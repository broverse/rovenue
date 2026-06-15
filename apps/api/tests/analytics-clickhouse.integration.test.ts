// =============================================================
// Analytics endpoints — ClickHouse integration test
// =============================================================
//
// Phase 1-3 + predictive-LTV shipped several new ClickHouse-backed
// services whose SQL had only ever run against MOCKED services in
// unit tests. This test executes that SQL against a real ClickHouse
// (testcontainer) to catch column-name / CH-function errors that
// unit tests cannot.
//
// Covered (full service call, CH-only):
//   - getMrrDecomposition  (services/metrics/mrr-decomposition.ts)
//   - getLtvDistribution   (services/metrics/ltv.ts)
//   - listEngagement       (services/metrics/engagement.ts)
//
// Covered (CH-SQL smoke — the CH half of mixed CH+PG services; the
// Postgres half is standard Drizzle query-builder code exercised by
// the unit tests, not re-run here):
//   - getRevenueSummary window + lifetime queries (summary.ts)
//   - getLtvPrediction revenue + size queries (ltv-prediction.ts)
//
// Setup mirrors mrr-clickhouse-only.integration.test.ts (Redpanda is
// required only so the Kafka-Engine migration tables apply cleanly;
// the test body seeds raw_revenue_events / sdk_sessions_daily_tbl by
// DIRECT INSERT, not via the Kafka path — the read views are
// query-time so inserts are visible immediately).
//
// NOT parallel-safe: binds fixed host ports below.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Kafka } from "kafkajs";
import {
  __resetClickHouseForTests,
  queryAnalytics,
} from "../src/lib/clickhouse";
import { env } from "../src/lib/env";
import { getMrrDecomposition } from "../src/services/metrics/mrr-decomposition";
import { getLtvDistribution } from "../src/services/metrics/ltv";
import { listEngagement } from "../src/services/metrics/engagement";

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;

const BROKER_EXTERNAL_PORT = 19101;
const CH_HOST_PORT = 8231;

const RUN_ID = Date.now();
const PROJECT = `prj_analytics_${RUN_ID}`;

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
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
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}

// Build a raw_revenue_events row. Amounts are USD; refunds are stored
// as POSITIVE magnitudes (see migration 0011 note).
function rev(
  sub: string,
  type: string,
  amountUsd: number,
  eventDate: string,
  store: string,
  productId: string,
) {
  const id = `evt_${sub}_${type}_${eventDate}_${RUN_ID}`;
  return {
    eventId: id,
    revenueEventId: id,
    projectId: PROJECT,
    subscriberId: sub,
    purchaseId: `pur_${sub}_${RUN_ID}`,
    productId,
    type,
    store,
    amount: amountUsd.toFixed(4),
    amountUsd: amountUsd.toFixed(4),
    currency: "USD",
    eventDate: `${eventDate} 00:00:00.000`,
    ingestedAt: `${eventDate} 00:00:00.000`,
    _version: 1,
  };
}

beforeAll(async () => {
  network = await new Network().start();

  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withNetwork(network)
    .withNetworkAliases("redpanda")
    .withCommand([
      "redpanda",
      "start",
      "--smp=1",
      "--memory=512M",
      "--overprovisioned",
      "--node-id=0",
      "--check=false",
      `--kafka-addr=INTERNAL://0.0.0.0:9092,EXTERNAL://0.0.0.0:${BROKER_EXTERNAL_PORT}`,
      `--advertise-kafka-addr=INTERNAL://redpanda:9092,EXTERNAL://localhost:${BROKER_EXTERNAL_PORT}`,
    ])
    .withExposedPorts({
      container: BROKER_EXTERNAL_PORT,
      host: BROKER_EXTERNAL_PORT,
    })
    .start();
  const brokerUrl = `localhost:${BROKER_EXTERNAL_PORT}`;

  const kafkaAdmin = new Kafka({
    clientId: "analytics-it-setup",
    brokers: [brokerUrl],
  }).admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    topics: [
      { topic: "rovenue.exposures", numPartitions: 1 },
      { topic: "rovenue.revenue", numPartitions: 1 },
      { topic: "rovenue.credit", numPartitions: 1 },
    ],
  });
  await kafkaAdmin.disconnect();

  clickhouse = await new GenericContainer(
    "clickhouse/clickhouse-server:24.3-alpine",
  )
    .withNetwork(network)
    .withNetworkAliases("clickhouse")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  // `env` (src/lib/env.ts) is parsed once at import, so setting
  // process.env now is too late for the service's CH client. Mutate
  // the shared (unfrozen) env object so the lazily-built client
  // targets THIS container's dynamic port.
  const mEnv = env as {
    CLICKHOUSE_URL?: string;
    CLICKHOUSE_USER?: string;
    CLICKHOUSE_PASSWORD?: string;
  };
  mEnv.CLICKHOUSE_URL = chUrl;
  mEnv.CLICKHOUSE_USER = "rovenue";
  mEnv.CLICKHOUSE_PASSWORD = "rovenue_test";
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";
  __resetClickHouseForTests();

  let stableSuccesses = 0;
  await waitFor(async () => {
    const probe = createClient({
      url: chUrl,
      username: "rovenue",
      password: "rovenue_test",
    });
    try {
      const res = await probe.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
      const rows = (await res.json()) as Array<{ ok: number }>;
      if (rows[0]?.ok === 1) {
        stableSuccesses++;
        return stableSuccesses >= 3;
      }
      stableSuccesses = 0;
      return false;
    } finally {
      await probe.close();
    }
  }, 45_000);

  // --- apply CH migrations (same applier as the MRR integration test) ---
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "default",
    request_timeout: 60_000,
  });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (
      filename String,
      sha256 FixedString(64),
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const mig = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "rovenue",
    request_timeout: 60_000,
  });

  const migrationsDir = join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "db",
    "clickhouse",
    "migrations",
  );
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content
      .split(/;\s*$/m)
      .map((s) => {
        const lines = s.split("\n");
        const firstNonComment = lines.findIndex(
          (l) => l.trim().length > 0 && !l.trim().startsWith("--"),
        );
        return firstNonComment >= 0
          ? lines.slice(firstNonComment).join("\n").trim()
          : "";
      })
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await mig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbName, tblName] = m[1]!.includes(".")
            ? m[1]!.split(".")
            : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await mig.query({
              query: `SELECT count() AS c FROM system.tables WHERE database = '${dbName}' AND name = '${tblName}'`,
              format: "JSONEachRow",
            });
            const rows = (await res.json()) as Array<{ c: string | number }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await mig.insert({
      table: "_migrations",
      values: [{ filename, sha256 }],
      format: "JSONEachRow",
    });
  }
  await mig.close();

  // --- seed data via direct insert (read views are query-time) ---
  ch = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "rovenue",
    request_timeout: 60_000,
  });

  // Cohorts: A,B acquired 2026-01; C acquired 2026-03.
  // D has only a REACTIVATION (no acquisition) -> excluded from cohorts.
  const events = [
    rev("subA", "INITIAL", 10, "2026-01-15", "APP_STORE", "prodA"),
    rev("subA", "RENEWAL", 10, "2026-02-15", "APP_STORE", "prodA"),
    rev("subA", "RENEWAL", 10, "2026-03-15", "APP_STORE", "prodA"),
    rev("subB", "TRIAL_CONVERSION", 5, "2026-01-20", "PLAY_STORE", "prodB"),
    rev("subB", "RENEWAL", 5, "2026-02-20", "PLAY_STORE", "prodB"),
    rev("subC", "INITIAL", 20, "2026-03-10", "APP_STORE", "prodA"),
    rev("subC", "REFUND", 20, "2026-03-12", "APP_STORE", "prodA"),
    rev("subD", "REACTIVATION", 8, "2026-02-05", "APP_STORE", "prodA"),
  ];
  await ch.insert({
    table: "rovenue.raw_revenue_events",
    values: events,
    format: "JSONEachRow",
  });

  await ch.insert({
    table: "rovenue.sdk_sessions_daily_tbl",
    values: [
      { projectId: PROJECT, subscriberId: "subA", day: "2026-03-01", session_ms: 120000, session_count: 4 },
      { projectId: PROJECT, subscriberId: "subA", day: "2026-03-02", session_ms: 60000, session_count: 2 },
      { projectId: PROJECT, subscriberId: "subB", day: "2026-03-01", session_ms: 30000, session_count: 1 },
    ],
    format: "JSONEachRow",
  });

  // Direct inserts are synchronous for the query-time read views, but
  // sdk_sessions_daily_tbl is a SummingMergeTree — give the part a beat.
  await new Promise((r) => setTimeout(r, 500));
}, 300_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

const WINDOW = {
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-12-31T00:00:00Z"),
};

describe("analytics CH services (real ClickHouse)", () => {
  it("getMrrDecomposition splits new / expansion / churned", async () => {
    const d = await getMrrDecomposition({ projectId: PROJECT, ...WINDOW });
    // new = INITIAL(10+20) + TRIAL_CONVERSION(5) = 35
    expect(Number(d.newUsd)).toBeCloseTo(35, 4);
    // expansion = REACTIVATION(8)
    expect(Number(d.expansionUsd)).toBeCloseTo(8, 4);
    // churned = REFUND(20)
    expect(Number(d.churnedUsd)).toBeCloseTo(20, 4);
  });

  it("getLtvDistribution returns a bucketed histogram + quantiles", async () => {
    const dist = await getLtvDistribution(PROJECT);
    // net lifetime per sub: A=30, B=10, C=0, D=8 -> 4 subscribers
    expect(dist.totalSubscribers).toBe(4);
    // REACTIVATION is NOT in the lifetime "purchased" bucket (migration
    // 0011), so subD's $8 doesn't count: nets are 30, 10, 0, 0 -> avg 10.
    expect(Number(dist.avgUsd)).toBeCloseTo((30 + 10 + 0 + 0) / 4, 2);
    expect(dist.histogram).toHaveLength(9);
    const total = dist.histogram.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(4);
    // The top open-ended bucket is present and has a null upper bound.
    expect(dist.histogram[dist.histogram.length - 1]!.upperUsd).toBeNull();
  });

  it("listEngagement aggregates sessions per day", async () => {
    const points = await listEngagement({ projectId: PROJECT, ...WINDOW });
    const byDay = new Map(points.map((p) => [p.bucket.toISOString().slice(0, 10), p]));
    const d1 = byDay.get("2026-03-01")!;
    expect(d1.sessionCount).toBe(5); // 4 + 1
    expect(d1.activeSubscribers).toBe(2); // subA + subB
    expect(d1.avgSessionMs).toBe(Math.round(150000 / 5)); // 30000
    const d2 = byDay.get("2026-03-02")!;
    expect(d2.sessionCount).toBe(2);
    expect(d2.activeSubscribers).toBe(1);
  });

  // --- CH-SQL smoke for the CH half of mixed CH+PG services ---

  it("getRevenueSummary CH queries run and return sane rows", async () => {
    const params = { from: "2026-01-01", to: "2026-12-31" };
    const windowRows = await queryAnalytics<{
      gross_usd: string;
      refunds_usd: string;
      paying_subs: string;
      trial_conversions: string;
    }>(
      PROJECT,
      `
        SELECT
          toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))          AS gross_usd,
          toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))              AS refunds_usd,
          toString(uniqExactIf(subscriberId, type NOT IN ('REFUND','CHARGEBACK'))) AS paying_subs,
          toString(uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION'))           AS trial_conversions
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {from:Date}
          AND toDate(eventDate) <= {to:Date}
      `,
      params,
    );
    const w = windowRows[0]!;
    // gross = all non-refund amounts: 10+10+10+5+5+20+8 = 68
    expect(Number(w.gross_usd)).toBeCloseTo(68, 4);
    expect(Number(w.refunds_usd)).toBeCloseTo(20, 4);
    expect(Number(w.paying_subs)).toBe(4); // A,B,C,D have non-refund events
    expect(Number(w.trial_conversions)).toBe(1); // subB

    const ltvRows = await queryAnalytics<{ avg_usd: string; subscribers: string }>(
      PROJECT,
      `
        SELECT
          toString(round(avg(net_cents) / 100, 4)) AS avg_usd,
          toString(count())                        AS subscribers
        FROM (
          SELECT
            toInt64(lifetime_dollars_purchased_cents)
              - toInt64(lifetime_dollars_refunded_cents) AS net_cents
          FROM rovenue.v_revenue_lifetime_subscriber
          WHERE projectId = {projectId:String}
        )
      `,
      params,
    );
    expect(Number(ltvRows[0]!.subscribers)).toBe(4);
    // nets 30,10,0,0 (REACTIVATION excluded from lifetime purchased) -> 10
    expect(Number(ltvRows[0]!.avg_usd)).toBeCloseTo(10, 2);
  });

  it("getLtvPrediction CH queries (cohort revenue + sizes) run", async () => {
    const joinsCte = `
      joins AS (
        SELECT
          subscriberId,
          toStartOfMonth(min(eventDate))       AS cohort_month,
          argMin(store, eventDate)             AS join_store,
          argMin(productId, eventDate)         AS join_product
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND type IN ('INITIAL','TRIAL_CONVERSION')
        GROUP BY subscriberId
      )`;

    const sizeRows = await queryAnalytics<{
      cohort_month: string;
      store: string;
      product_id: string;
      size: string;
    }>(
      PROJECT,
      `
        WITH ${joinsCte}
        SELECT
          toString(cohort_month)  AS cohort_month,
          join_store              AS store,
          join_product            AS product_id,
          toString(count())       AS size
        FROM joins
        GROUP BY cohort_month, store, product_id
      `,
    );
    // Cohorts: 2026-01 (subA APP_STORE/prodA, subB PLAY_STORE/prodB), 2026-03 (subC).
    // subD has no acquisition event -> not present.
    const months = new Set(sizeRows.map((r) => r.cohort_month.slice(0, 7)));
    expect(months.has("2026-01")).toBe(true);
    expect(months.has("2026-03")).toBe(true);
    const totalJoiners = sizeRows.reduce((a, r) => a + Number(r.size), 0);
    expect(totalJoiners).toBe(3); // A, B, C (not D)

    const revRows = await queryAnalytics<{
      cohort_month: string;
      age_month: number;
      net_usd: string;
    }>(
      PROJECT,
      `
        WITH ${joinsCte}
        SELECT
          toString(j.cohort_month)                                           AS cohort_month,
          toInt32(dateDiff('month', j.cohort_month, toStartOfMonth(e.eventDate))) AS age_month,
          toString(
            sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK'))
              - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK'))
          )                                                                  AS net_usd
        FROM rovenue.raw_revenue_events AS e FINAL
        INNER JOIN joins AS j ON e.subscriberId = j.subscriberId
        WHERE e.projectId = {projectId:String}
        GROUP BY cohort_month, age_month
      `,
    );
    expect(revRows.length).toBeGreaterThan(0);
    // age offsets must be non-negative integers
    for (const r of revRows) expect(Number(r.age_month)).toBeGreaterThanOrEqual(0);
  });
});
