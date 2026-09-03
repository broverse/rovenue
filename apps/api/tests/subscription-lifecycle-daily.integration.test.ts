// =============================================================
// Subscription-lifecycle chart series — pin + widen (task 3)
// =============================================================
//
// `new_subs` / `reactivations` / `trials_started` / `churn` (chart-
// catalog.ts) are backed by widening two existing services in place:
// mrr-decomposition.ts (ClickHouse, FINAL) gets a `countIf` sibling
// query for the first two; summary.ts (Postgres) gets a daily-grain
// sibling for the last two. Neither existing function
// (`getMrrDecomposition`, `getRevenueSummary`) was modified — this file
// proves that by calling BOTH the old and the new functions against the
// SAME seeded rows and checking the new functions' daily rows reconcile
// to the old functions' window totals.
//
// CH-only container (no Kafka): rows are inserted directly into
// raw_revenue_events, same pattern as revenue-aggregates-idempotency.
// integration.test.ts. Postgres uses the ambient per-worker template
// database tests/global-setup.ts already builds — no testcontainer
// needed for it.
//
// Fixed host port: CH_HOST_PORT = 8234 (not parallel-safe; see
// host-port-allocations.test.ts).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { __resetClickHouseForTests } from "../src/lib/clickhouse";
import { env } from "../src/lib/env";
import {
  getMrrDecomposition,
  getMrrDecompositionDailyCounts,
} from "../src/services/metrics/mrr-decomposition";
import {
  getRevenueSummary,
  getChurnDaily,
  getTrialConversionsDaily,
  getTrialStartsDaily,
} from "../src/services/metrics/summary";
import { readChartSeries } from "../src/services/metrics/charts";

const CH_HOST_PORT = 8234;

let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
}

beforeAll(async () => {
  clickhouse = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  // Bind production's queryAnalytics client to this container — see
  // mrr-clickhouse-only.integration.test.ts's header for why mutating
  // process.env alone is not enough.
  const mEnv = env as { CLICKHOUSE_URL?: string; CLICKHOUSE_USER?: string; CLICKHOUSE_PASSWORD?: string };
  mEnv.CLICKHOUSE_URL = chUrl;
  mEnv.CLICKHOUSE_USER = "rovenue";
  mEnv.CLICKHOUSE_PASSWORD = "rovenue_test";
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";
  __resetClickHouseForTests();

  let stable = 0;
  await waitFor(async () => {
    try {
      const c = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test" });
      const res = await c.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
      const rows = (await res.json()) as Array<{ ok: number }>;
      await c.close();
      if (rows[0]?.ok === 1) { stable++; return stable >= 3; }
      stable = 0; return false;
    } catch { stable = 0; return false; }
  }, 45_000);

  // --- migration runner (verbatim pattern from revenue-aggregates-idempotency) ---
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "default", request_timeout: 60_000 });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (filename String, sha256 FixedString(64), applied_at DateTime64(3,'UTC') DEFAULT now64(3,'UTC')) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const chMig = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
  const migrationsDir = join(process.cwd(), "..", "..", "packages", "db", "clickhouse", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content.split(/;\s*$/m).map((s) => {
      const lines = s.split("\n");
      const i = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("--"));
      return i >= 0 ? lines.slice(i).join("\n").trim() : "";
    }).filter((s) => s.length > 0);
    for (const statement of statements) {
      await chMig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbN, tN] = m[1]!.includes(".") ? m[1]!.split(".") : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await chMig.query({ query: `SELECT count() AS c FROM system.tables WHERE database='${dbN}' AND name='${tN}'`, format: "JSONEachRow" });
            const rows = (await res.json()) as Array<{ c: string | number }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await chMig.insert({ table: "_migrations", values: [{ filename, sha256 }], format: "JSONEachRow" });
  }
  await chMig.close();

  ch = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
}, 300_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
});

// =============================================================
// Fixture: one project, six subscribers, three days of history
// =============================================================
//
//                       2026-06-01        2026-06-02       2026-06-03
// raw_revenue_events:
//   sub_a  INITIAL      $10                                            new
//   sub_b  TRIAL_CONV.  $5                                             new + a trial conversion
//   sub_c  REACTIVATION $7                                             reactivation
//   sub_d  RENEWAL      $20                                            retained (neither new nor reactivation)
//   sub_e                                 INITIAL $15                  new
//   sub_f                                 REACTIVATION $8              reactivation
//                                                          (no events — a real zero day)
//
// purchases (Postgres):
//   sub_a  ACTIVE,  isTrial=false                    -> active snapshot
//   sub_c  ACTIVE,  isTrial=false                    -> active snapshot
//   sub_b  TRIAL,   isTrial=true,  purchaseDate 06-01 -> trial start, day 1
//   sub_e  TRIAL,   isTrial=true,  purchaseDate 06-02 -> trial start, day 2
//   sub_d  REFUNDED,               cancellationDate 06-01 -> churned, day 1
//   sub_f  EXPIRED,                expiresDate      06-02 -> churned, day 2 (cancellationDate NULL)

const RUN = Date.now();
const PROJECT = `prj_lifecycle_${RUN}`;
const PRODUCT_ID = `prod_lifecycle_${RUN}`;
const SUB = {
  a: `sub_lc_a_${RUN}`,
  b: `sub_lc_b_${RUN}`,
  c: `sub_lc_c_${RUN}`,
  d: `sub_lc_d_${RUN}`,
  e: `sub_lc_e_${RUN}`,
  f: `sub_lc_f_${RUN}`,
};

const FROM = new Date("2026-06-01T00:00:00.000Z");
const TO = new Date("2026-06-03T23:59:59.999Z");

function chRow(input: {
  eventId: string;
  subscriberId: string;
  type: string;
  amountUsd: number;
  day: string;
}) {
  return {
    eventId: input.eventId,
    revenueEventId: `rev_${input.eventId}`,
    projectId: PROJECT,
    subscriberId: input.subscriberId,
    purchaseId: `pur_${input.eventId}`,
    productId: PRODUCT_ID,
    type: input.type,
    store: "APP_STORE",
    amount: input.amountUsd.toFixed(4),
    amountUsd: input.amountUsd.toFixed(4),
    currency: "USD",
    eventDate: `${input.day} 00:00:00.000`,
    ingestedAt: `${input.day} 00:00:00.000`,
    _version: 1,
  };
}

beforeAll(async () => {
  // --- ClickHouse rows ---
  await ch.insert({
    table: "raw_revenue_events",
    format: "JSONEachRow",
    values: [
      chRow({ eventId: `evt_a_${RUN}`, subscriberId: SUB.a, type: "INITIAL", amountUsd: 10, day: "2026-06-01" }),
      chRow({ eventId: `evt_b_${RUN}`, subscriberId: SUB.b, type: "TRIAL_CONVERSION", amountUsd: 5, day: "2026-06-01" }),
      chRow({ eventId: `evt_c_${RUN}`, subscriberId: SUB.c, type: "REACTIVATION", amountUsd: 7, day: "2026-06-01" }),
      chRow({ eventId: `evt_d_${RUN}`, subscriberId: SUB.d, type: "RENEWAL", amountUsd: 20, day: "2026-06-01" }),
      chRow({ eventId: `evt_e_${RUN}`, subscriberId: SUB.e, type: "INITIAL", amountUsd: 15, day: "2026-06-02" }),
      chRow({ eventId: `evt_f_${RUN}`, subscriberId: SUB.f, type: "REACTIVATION", amountUsd: 8, day: "2026-06-02" }),
    ],
  });

  // --- Postgres rows ---
  await drizzle.db.insert(drizzle.schema.projects).values({ id: PROJECT, name: `Lifecycle ${RUN}` });
  await drizzle.db.insert(drizzle.schema.subscribers).values(
    Object.values(SUB).map((id) => ({
      id,
      projectId: PROJECT,
      rovenueId: `rov_${id}`,
      appUserId: `user_${id}`,
    })),
  );
  await drizzle.db.insert(drizzle.schema.products).values({
    id: PRODUCT_ID,
    projectId: PROJECT,
    identifier: "lifecycle_product",
    type: "SUBSCRIPTION",
    storeIds: { apple: "com.lifecycle.pro" },
    displayName: "Lifecycle Pro",
  });

  type PurchaseInsert = typeof drizzle.schema.purchases.$inferInsert;
  const purchase = (over: Partial<PurchaseInsert>): PurchaseInsert =>
    ({
      projectId: PROJECT,
      productId: PRODUCT_ID,
      store: "APP_STORE" as const,
      originalPurchaseDate: new Date("2026-05-01T00:00:00.000Z"),
      environment: "PRODUCTION" as const,
      ...over,
    }) as PurchaseInsert;

  await drizzle.db.insert(drizzle.schema.purchases).values([
    purchase({
      subscriberId: SUB.a,
      storeTransactionId: `stx_a_${RUN}`,
      originalTransactionId: `otx_a_${RUN}`,
      status: "ACTIVE",
      isTrial: false,
      purchaseDate: new Date("2026-06-01T00:00:00.000Z"),
      expiresDate: new Date("2026-07-01T00:00:00.000Z"),
    }),
    purchase({
      subscriberId: SUB.c,
      storeTransactionId: `stx_c_${RUN}`,
      originalTransactionId: `otx_c_${RUN}`,
      status: "ACTIVE",
      isTrial: false,
      purchaseDate: new Date("2026-05-01T00:00:00.000Z"),
      expiresDate: new Date("2026-07-01T00:00:00.000Z"),
    }),
    purchase({
      subscriberId: SUB.b,
      storeTransactionId: `stx_b_${RUN}`,
      originalTransactionId: `otx_b_${RUN}`,
      status: "TRIAL",
      isTrial: true,
      purchaseDate: new Date("2026-06-01T00:00:00.000Z"),
      expiresDate: new Date("2026-06-08T00:00:00.000Z"),
    }),
    purchase({
      subscriberId: SUB.e,
      storeTransactionId: `stx_e_${RUN}`,
      originalTransactionId: `otx_e_${RUN}`,
      status: "TRIAL",
      isTrial: true,
      purchaseDate: new Date("2026-06-02T00:00:00.000Z"),
      expiresDate: new Date("2026-06-09T00:00:00.000Z"),
    }),
    purchase({
      subscriberId: SUB.d,
      storeTransactionId: `stx_d_${RUN}`,
      originalTransactionId: `otx_d_${RUN}`,
      status: "REFUNDED",
      isTrial: false,
      purchaseDate: new Date("2026-05-01T00:00:00.000Z"),
      cancellationDate: new Date("2026-06-01T00:00:00.000Z"),
      expiresDate: new Date("2026-06-01T00:00:00.000Z"),
    }),
    purchase({
      subscriberId: SUB.f,
      storeTransactionId: `stx_f_${RUN}`,
      originalTransactionId: `otx_f_${RUN}`,
      status: "EXPIRED",
      isTrial: false,
      purchaseDate: new Date("2026-05-01T00:00:00.000Z"),
      expiresDate: new Date("2026-06-02T00:00:00.000Z"),
    }),
  ]);
}, 120_000);

afterAll(async () => {
  await drizzle.db.delete(drizzle.schema.projects).where(eq(drizzle.schema.projects.id, PROJECT));
});

// =============================================================
// Part 1 — PIN: the existing callers, untouched by this widening
// =============================================================

describe("pin: existing callers are unaffected by the widening", () => {
  it("getMrrDecomposition returns the same window totals it always did", async () => {
    const d = await getMrrDecomposition({ projectId: PROJECT, from: FROM, to: TO });
    expect(d.newUsd).toBe("30.0000"); // sub_a $10 + sub_b $5 + sub_e $15
    expect(d.retainedUsd).toBe("20.0000"); // sub_d RENEWAL
    expect(d.reactivationUsd).toBe("15.0000"); // sub_c $7 + sub_f $8
    expect(d.churnedUsd).toBe("0.0000");
  });

  it("getRevenueSummary returns the same window figures it always did", async () => {
    const s = await getRevenueSummary({ projectId: PROJECT, from: FROM, to: TO });
    expect(s.grossUsd).toBe("65.0000"); // 10+5+7+20+15+8
    expect(s.trialConversions).toBe(1); // sub_b
    expect(s.trialStarts).toBe(2); // sub_b, sub_e
    expect(s.activeSubscriberBase).toBe(2); // sub_a, sub_c
    expect(s.churnedInWindow).toBe(2); // sub_d, sub_f
    expect(s.churnRate).toBeCloseTo(2 / 4, 6); // 2 churned / (2 active + 2 churned)
  });
});

// =============================================================
// Part 2 — WIDEN: the new daily-grain readers reconcile to Part 1
// =============================================================

describe("widen: daily-grain readers reconcile to the pinned window totals", () => {
  it("getMrrDecompositionDailyCounts: per-day countIf sums to the window count", async () => {
    const { newSubs, reactivations } = await getMrrDecompositionDailyCounts({
      projectId: PROJECT,
      from: FROM,
      to: TO,
    });
    const byDay = (rows: { day: string; n: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.day, r.n]));

    expect(byDay(newSubs)).toEqual({ "2026-06-01": 2, "2026-06-02": 1 });
    expect(byDay(reactivations)).toEqual({ "2026-06-01": 1, "2026-06-02": 1 });

    // Reconciliation: a pure COUNT is additive across a GROUP BY day
    // partition, so the day-sum must exactly equal a fresh window-total
    // countIf over the same predicate (not the money sum, which is a
    // different quantity).
    const totalNew = newSubs.reduce((a, r) => a + r.n, 0);
    const totalReact = reactivations.reduce((a, r) => a + r.n, 0);
    expect(totalNew).toBe(3); // sub_a, sub_b, sub_e
    expect(totalReact).toBe(2); // sub_c, sub_f
  });

  it("getTrialStartsDaily reconciles to the pinned trialStarts window total", async () => {
    const rows = await getTrialStartsDaily({ projectId: PROJECT, from: FROM, to: TO });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
    expect(byDay).toEqual({ "2026-06-01": 1, "2026-06-02": 1 });
    expect(rows.reduce((a, r) => a + r.n, 0)).toBe(2); // matches s.trialStarts above
  });

  it("getChurnDaily's daily churn counts sum to the pinned churnedInWindow (fix round 1: count, not a rate divided by a constant snapshot)", async () => {
    const churnedByDay = await getChurnDaily({
      projectId: PROJECT,
      from: FROM,
      to: TO,
    });
    const byDay = Object.fromEntries(churnedByDay.map((r) => [r.day, r.n]));
    expect(byDay).toEqual({ "2026-06-01": 1, "2026-06-02": 1 }); // sub_d, sub_f
    expect(churnedByDay.reduce((a, r) => a + r.n, 0)).toBe(2); // matches s.churnedInWindow above
  });

  it("getTrialConversionsDaily (task 4, ClickHouse) reconciles to the pinned trialConversions window total", async () => {
    const rows = await getTrialConversionsDaily({ projectId: PROJECT, from: FROM, to: TO });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
    // ClickHouse's GROUP BY day emits a row for every day that has ANY
    // event, not just days with a TRIAL_CONVERSION — 2026-06-02 has
    // sub_e/sub_f events (INITIAL/REACTIVATION) so it's a real row with
    // uniqExactIf(...) = 0, distinct from 2026-06-03 (zero events at
    // all that day), which has no row. Both read as 0 once
    // buildCountSeriesPoints fills the window, so this doesn't change
    // the dispatcher's output — see the Part 3 test below.
    expect(byDay).toEqual({ "2026-06-01": 1, "2026-06-02": 0 }); // sub_b, TRIAL_CONVERSION
    expect(rows.reduce((a, r) => a + r.n, 0)).toBe(1); // matches s.trialConversions above
  });
});

// =============================================================
// Part 3 — the dispatcher, end to end, against the real schema
// =============================================================

describe("readChartSeries — subscription-lifecycle ids, real ClickHouse + real Postgres", () => {
  beforeAll(() => {
    // Fake ONLY Date — the real ClickHouse HTTP client relies on real
    // setTimeout/setInterval internally, and faking those alongside Date
    // hangs every CH request for the fake-timer duration (observed:
    // 30s+ timeouts on new_subs/reactivations, which go through
    // queryAnalytics; trials_started/churn, which are Postgres-only,
    // were unaffected).
    vi.useFakeTimers({ toFake: ["Date"] });
    // buildWindow's `to` is `new Date()`; freeze it so windowDays=3
    // covers exactly 2026-06-01..2026-06-03.
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("new_subs: daily counts, a real zero on the day with no events", async () => {
    const res = await readChartSeries(PROJECT, "new_subs", 3);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.map((p) => p.value)).toEqual([2, 1, 0]);
  });

  it("reactivations: daily counts, a real zero on the day with no events", async () => {
    const res = await readChartSeries(PROJECT, "reactivations", 3);
    expect(res.unit).toBe("count");
    expect(res.points.map((p) => p.value)).toEqual([1, 1, 0]);
  });

  it("trials_started: daily counts from Postgres, no ClickHouse involved", async () => {
    const res = await readChartSeries(PROJECT, "trials_started", 3);
    expect(res.unit).toBe("count");
    expect(res.points.map((p) => p.value)).toEqual([1, 1, 0]);
  });

  it("churn: daily counts (fix round 1 — was a percent divided by a constant snapshot; see task-3-fixes.md), a real zero on the day with no churn", async () => {
    const res = await readChartSeries(PROJECT, "churn", 3);
    expect(res.unit).toBe("count");
    // day1: sub_d churned; day2: sub_f churned; day3: nobody
    expect(res.points.map((p) => p.value)).toEqual([1, 1, 0]);
  });

  it("trial_to_paid (task 4): daily TRIAL_CONVERSION counts, real zeros on days with no conversion", async () => {
    const res = await readChartSeries(PROJECT, "trial_to_paid", 3);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    // day1: sub_b converts; day2/day3: nobody
    expect(res.points.map((p) => p.value)).toEqual([1, 0, 0]);
  });
});
