// =============================================================
// analytics-router experiment reader — ClickHouse integration test
// =============================================================
//
// Proves the subscriber-level, windowed reader added to
// `runAnalyticsQuery({ kind: "experiment_results" | "experiment_revenue_by_store" })`
// against a REAL ClickHouse (testcontainer) — no mocked client anywhere in
// this file. The unit test at `analytics-router.test.ts` only proves the
// TypeScript composed the SQL string it meant to; this file proves the SQL
// is actually correct against the live schema and produces the right
// numbers, which is the entire point of Task 3: the unit of analysis is
// the subscriber, because the subscriber is the unit of randomisation, and
// an order-level sum would let one subscriber with three renewals count
// three times in a comparison that randomised subscribers.
//
// Setup mirrors tests/analytics-clickhouse.integration.test.ts (Redpanda is
// required only so the Kafka-Engine migration tables apply cleanly; rows
// are seeded by DIRECT INSERT into raw_exposures / raw_revenue_events, not
// via the Kafka path — the reader's query is time-of-read, so inserts are
// visible immediately, modulo the ReplacingMergeTree settle noted below).
//
// The maturation-window boundary depends on wall-clock `now()` inside the
// SQL itself (Ruling 5 / the "window must have elapsed" filter), so unlike
// most CH integration tests here this one anchors its fixture timestamps
// to the ACTUAL current time (`new Date()` at setup) rather than fixed
// calendar dates.
//
// NOT parallel-safe: binds fixed host ports (see host-port-allocations.
// test.ts registry) BROKER_EXTERNAL_PORT=19105, CH_HOST_PORT=8233.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Kafka } from "kafkajs";
import { __resetClickHouseForTests } from "../lib/clickhouse";
import { env } from "../lib/env";
import { MATURATION_WINDOW_DAYS } from "../lib/experiment-constants";
import {
  runAnalyticsQuery,
  type ExperimentVariantRow,
  type ExperimentStoreRevenueRow,
} from "./analytics-router";

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;

const BROKER_EXTERNAL_PORT = 19105;
const CH_HOST_PORT = 8233;

const RUN_ID = Date.now();
const PROJECT = `prj_exp_windowed_${RUN_ID}`;
const EXPERIMENT_ID = `exp_windowed_${RUN_ID}`;
const EXPERIMENT_KEY = `exp_windowed_key_${RUN_ID}`;

// Fixture timestamps are anchored to the wall clock at setup time, not a
// fixed calendar date — the "window has elapsed" filter compares against
// SQL `now()`, which is the real current time inside the testcontainer.
const NOW = new Date();

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function toChDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

// Comfortably beyond one full MATURATION_WINDOW_DAYS window so the
// "window must have elapsed" filter is unambiguously satisfied, with
// margin to spare for slow CI clocks.
const MATURE_EXPOSURE_DAYS_AGO = MATURATION_WINDOW_DAYS + 3;
// "Exposed yesterday" — inside the current, not-yet-elapsed window.
const IMMATURE_EXPOSURE_DAYS_AGO = 1;

interface RawExposureRow {
  eventId: string;
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform: string;
  country: string;
  exposedAt: string;
  insertedAt: string;
}

function exposureRow(opts: {
  suffix: string;
  variantId: string;
  subscriberId: string;
  exposedAt: Date;
}): RawExposureRow {
  return {
    eventId: `exposure_${opts.suffix}_${RUN_ID}`,
    experimentId: EXPERIMENT_ID,
    variantId: opts.variantId,
    projectId: PROJECT,
    subscriberId: opts.subscriberId,
    platform: "ios",
    country: "US",
    exposedAt: toChDateTime(opts.exposedAt),
    insertedAt: toChDateTime(opts.exposedAt),
  };
}

interface RawRevenueRow {
  eventId: string;
  revenueEventId: string;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: string;
  store: string;
  amount: string;
  amountUsd: string;
  currency: string;
  eventDate: string;
  ingestedAt: string;
  _version: number;
}

function revenueRow(opts: {
  eventId: string;
  subscriberId: string;
  type: string;
  amountUsd: number;
  eventDate: Date;
  store?: string;
  version?: number;
}): RawRevenueRow {
  return {
    eventId: opts.eventId,
    revenueEventId: opts.eventId,
    projectId: PROJECT,
    subscriberId: opts.subscriberId,
    purchaseId: `purchase_${opts.eventId}`,
    productId: "prod_windowed_test",
    type: opts.type,
    store: opts.store ?? "APP_STORE",
    amount: opts.amountUsd.toFixed(4),
    amountUsd: opts.amountUsd.toFixed(4),
    currency: "USD",
    eventDate: toChDateTime(opts.eventDate),
    ingestedAt: toChDateTime(opts.eventDate),
    _version: opts.version ?? 1,
  };
}

// --- variant ids: one per test case, all under the same experiment -------
const V_THREE_RENEWALS = "v_three_renewals";
const V_IMMATURE = "v_immature";
const V_CROSSOVER_A = "v_crossover_a";
const V_CROSSOVER_B = "v_crossover_b";
const V_REFUNDED = "v_refunded";
const V_DUP_EVENT = "v_dup_event";
const V_STORE_SPLIT = "v_store_split";
/** Net-NEGATIVE subscriber: refunded past their gross. */
const V_NET_NEGATIVE = "v_net_negative";
// 2026-09-04 ruling: an experiment's gross must count every sale it
// caused, including one-time purchases (NON_RENEWING_PURCHASE) and
// coin-pack buys (CREDIT_PURCHASE) — the old allow-list excluded both.
const V_ONE_TIME_TYPES = "v_one_time_types";

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
    clientId: "analytics-router-experiment-it-setup",
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

  // `env` (lib/env.ts) is parsed once at import; mutate the shared
  // (unfrozen) env object directly so the lazily-built client in
  // lib/clickhouse.ts targets THIS container, then drop the memoised
  // client. See schema-contract.integration.test.ts's header for the
  // original diagnosis of this seam.
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

  // --- apply every CH migration so the schema under test is the real one ---
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

  // --- seed fixtures via direct insert (bypassing Kafka) ------------------
  ch = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "rovenue",
    request_timeout: 60_000,
  });

  const matureExposedAt = daysAgo(MATURE_EXPOSURE_DAYS_AGO);
  const immatureExposedAt = daysAgo(IMMATURE_EXPOSURE_DAYS_AGO);

  await ch.insert({
    table: "rovenue.raw_exposures",
    values: [
      // Case 1: one subscriber, three renewals — must count once.
      exposureRow({
        suffix: "three_renewals",
        variantId: V_THREE_RENEWALS,
        subscriberId: `sub_three_renewals_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      // Case 2: exposed yesterday — window has not elapsed.
      exposureRow({
        suffix: "immature",
        variantId: V_IMMATURE,
        subscriberId: `sub_immature_${RUN_ID}`,
        exposedAt: immatureExposedAt,
      }),
      // Case 3: one subscriber seen under two variants — crossover.
      exposureRow({
        suffix: "crossover_a",
        variantId: V_CROSSOVER_A,
        subscriberId: `sub_crossover_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      exposureRow({
        suffix: "crossover_b",
        variantId: V_CROSSOVER_B,
        subscriberId: `sub_crossover_${RUN_ID}`,
        exposedAt: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      // Case 4: fully-refunded subscriber — not a converter.
      exposureRow({
        suffix: "refunded",
        variantId: V_REFUNDED,
        subscriberId: `sub_refunded_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      // Ruling 5: duplicate eventId (at-least-once outbox redelivery).
      exposureRow({
        suffix: "dup_event",
        variantId: V_DUP_EVENT,
        subscriberId: `sub_dup_event_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      // Welch cross-check: a subscriber refunded PAST their gross, so their
      // windowed net revenue is negative. Not representable in the
      // converter-only log aggregates (log of a non-positive value is
      // undefined), which is why the raw sufficient statistics are a
      // separate pair of columns rather than derived from them.
      exposureRow({
        suffix: "net_negative",
        variantId: V_NET_NEGATIVE,
        subscriberId: `sub_net_negative_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      // Per-store breakdown: two subscribers, two different stores.
      exposureRow({
        suffix: "store_split_apple",
        variantId: V_STORE_SPLIT,
        subscriberId: `sub_store_apple_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      exposureRow({
        suffix: "store_split_google",
        variantId: V_STORE_SPLIT,
        subscriberId: `sub_store_google_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
      // 2026-09-04 ruling: one-time purchase types must count in gross.
      exposureRow({
        suffix: "one_time_types",
        variantId: V_ONE_TIME_TYPES,
        subscriberId: `sub_one_time_types_${RUN_ID}`,
        exposedAt: matureExposedAt,
      }),
    ],
    format: "JSONEachRow",
  });

  const dupEventDate = daysAgo(MATURE_EXPOSURE_DAYS_AGO - 2);

  await ch.insert({
    table: "rovenue.raw_revenue_events",
    values: [
      // Case 1: three renewals from the SAME subscriber, all within window.
      revenueRow({
        eventId: `rev_three_a_${RUN_ID}`,
        subscriberId: `sub_three_renewals_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 10,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      revenueRow({
        eventId: `rev_three_b_${RUN_ID}`,
        subscriberId: `sub_three_renewals_${RUN_ID}`,
        type: "RENEWAL",
        amountUsd: 10,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 2),
      }),
      revenueRow({
        eventId: `rev_three_c_${RUN_ID}`,
        subscriberId: `sub_three_renewals_${RUN_ID}`,
        type: "RENEWAL",
        amountUsd: 10,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 3),
      }),
      // Case 3: crossover subscriber has revenue too — must be excluded.
      revenueRow({
        eventId: `rev_crossover_${RUN_ID}`,
        subscriberId: `sub_crossover_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 99,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      // Case 4: fully refunded — gross 50, refund 50, net 0 -> not a converter.
      revenueRow({
        eventId: `rev_refunded_initial_${RUN_ID}`,
        subscriberId: `sub_refunded_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 50,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      revenueRow({
        eventId: `rev_refunded_refund_${RUN_ID}`,
        subscriberId: `sub_refunded_${RUN_ID}`,
        type: "REFUND",
        amountUsd: 50, // house convention: refunds stored POSITIVE
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      // Welch cross-check: gross 10, refunded 25 -> net -15.
      revenueRow({
        eventId: `rev_net_negative_initial_${RUN_ID}`,
        subscriberId: `sub_net_negative_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 10,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      revenueRow({
        eventId: `rev_net_negative_refund_${RUN_ID}`,
        subscriberId: `sub_net_negative_${RUN_ID}`,
        type: "REFUND",
        amountUsd: 25, // house convention: refunds stored POSITIVE
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      // Per-store breakdown fixtures.
      revenueRow({
        eventId: `rev_store_apple_${RUN_ID}`,
        subscriberId: `sub_store_apple_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 40,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
        store: "APP_STORE",
      }),
      revenueRow({
        eventId: `rev_store_google_${RUN_ID}`,
        subscriberId: `sub_store_google_${RUN_ID}`,
        type: "INITIAL",
        amountUsd: 15,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
        store: "PLAY_STORE",
      }),
      // 2026-09-04 ruling: NON_RENEWING_PURCHASE and CREDIT_PURCHASE must
      // both land in an experiment's gross. Neither type is produced by
      // any code path yet (Tasks 6/7), so this row is constructed by
      // hand — the honest test proves the QUERY counts these types, not
      // that anything currently emits them.
      revenueRow({
        eventId: `rev_one_time_nonrenewing_${RUN_ID}`,
        subscriberId: `sub_one_time_types_${RUN_ID}`,
        type: "NON_RENEWING_PURCHASE",
        amountUsd: 25,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
      revenueRow({
        eventId: `rev_one_time_credit_${RUN_ID}`,
        subscriberId: `sub_one_time_types_${RUN_ID}`,
        type: "CREDIT_PURCHASE",
        amountUsd: 5,
        eventDate: daysAgo(MATURE_EXPOSURE_DAYS_AGO - 1),
      }),
    ],
    format: "JSONEachRow",
  });

  // Ruling 5: insert the SAME eventId TWICE, in two separate insert calls
  // (simulating two separate at-least-once outbox deliveries landing in two
  // separate parts). Both share the identical (projectId, eventDate,
  // eventId) ReplacingMergeTree sorting key, so `FINAL` must collapse them
  // to ONE logical row before the reader sums amountUsd — if it doesn't,
  // the $20 shows up as $40.
  const dupRow = revenueRow({
    eventId: `rev_dup_${RUN_ID}`,
    subscriberId: `sub_dup_event_${RUN_ID}`,
    type: "INITIAL",
    amountUsd: 20,
    eventDate: dupEventDate,
    version: 1,
  });
  await ch.insert({ table: "rovenue.raw_revenue_events", values: [dupRow], format: "JSONEachRow" });
  await ch.insert({
    table: "rovenue.raw_revenue_events",
    values: [{ ...dupRow, _version: 2 }],
    format: "JSONEachRow",
  });

  // Give ReplacingMergeTree a moment to settle before querying with FINAL.
  await new Promise((r) => setTimeout(r, 500));
}, 300_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

describe("runAnalyticsQuery experiment_results — subscriber-level windowed value aggregates", () => {
  let rows: ExperimentVariantRow[];

  beforeAll(async () => {
    rows = await runAnalyticsQuery({
      kind: "experiment_results",
      projectId: PROJECT,
      experimentId: EXPERIMENT_ID,
      experimentKey: EXPERIMENT_KEY,
    });
  });

  function rowFor(variantId: string): ExperimentVariantRow {
    const row = rows.find((r) => r.variant_id === variantId);
    if (!row) throw new Error(`no row for variant ${variantId} in ${JSON.stringify(rows)}`);
    return row;
  }

  it("folds one subscriber's three renewals into a single conversion, not three", () => {
    const row = rowFor(V_THREE_RENEWALS);
    expect(row.mature_users).toBe(1);
    expect(row.converters).toBe(1);
    expect(row.excluded_immature).toBe(0);
    expect(row.excluded_crossover).toBe(0);
    // gross = 10 + 10 + 10 = 30, summed ONCE per subscriber, not per order.
    expect(row.revenue_usd).toBeCloseTo(30, 4);
    expect(row.refunds_usd).toBeCloseTo(0, 4);
    expect(row.sum_log_value).toBeCloseTo(Math.log(30), 6);
    expect(row.sum_log_value_sq).toBeCloseTo(Math.log(30) ** 2, 6);
  });

  it("excludes a subscriber exposed yesterday when the window is MATURATION_WINDOW_DAYS", () => {
    const row = rowFor(V_IMMATURE);
    expect(row.mature_users).toBe(0);
    expect(row.excluded_immature).toBe(1);
    expect(row.excluded_crossover).toBe(0);
    expect(row.converters).toBe(0);
    expect(row.revenue_usd).toBeCloseTo(0, 4);
  });

  it("excludes a subscriber exposed to two variants and counts them as crossover on both", () => {
    const a = rowFor(V_CROSSOVER_A);
    const b = rowFor(V_CROSSOVER_B);
    for (const row of [a, b]) {
      expect(row.mature_users).toBe(0);
      expect(row.excluded_crossover).toBe(1);
      expect(row.excluded_immature).toBe(0);
      expect(row.converters).toBe(0);
      // The $99 purchase must not leak into either variant's revenue.
      expect(row.revenue_usd).toBeCloseTo(0, 4);
    }
  });

  it("does not count a fully-refunded subscriber as a converter", () => {
    const row = rowFor(V_REFUNDED);
    expect(row.mature_users).toBe(1);
    expect(row.excluded_immature).toBe(0);
    expect(row.excluded_crossover).toBe(0);
    // gross - refunds = 50 - 50 = 0, which fails the "> 0" converter gate.
    expect(row.converters).toBe(0);
    expect(row.revenue_usd).toBeCloseTo(50, 4);
    expect(row.refunds_usd).toBeCloseTo(50, 4);
    expect(row.sum_log_value).toBeCloseTo(0, 6);
  });

  it("emits Welch sufficient statistics over MATURE SUBSCRIBERS, not converters", () => {
    // One mature subscriber netting 30: n comes from mature_users, so
    // Sum(x) = 30 and Sum(x^2) = 900.
    const row = rowFor(V_THREE_RENEWALS);
    expect(row.mature_users).toBe(1);
    expect(row.net_revenue_usd).toBeCloseTo(30, 4);
    expect(row.net_revenue_sq).toBeCloseTo(900, 4);
  });

  it("counts a fully-refunded subscriber in the Welch statistics as a zero, not an absence", () => {
    // The SAME subscriber is excluded from `converters` and from the log
    // aggregates (spec 4.1: a fully-refunded purchase is not a
    // conversion) but must still appear in the raw revenue-per-USER
    // statistics contributing 0 — dropping them would silently shrink the
    // denominator of the assumption-free cross-check.
    const row = rowFor(V_REFUNDED);
    expect(row.mature_users).toBe(1);
    expect(row.converters).toBe(0);
    expect(row.sum_log_value).toBeCloseTo(0, 6);
    expect(row.net_revenue_usd).toBeCloseTo(0, 4);
    expect(row.net_revenue_sq).toBeCloseTo(0, 4);
  });

  it("carries a NEGATIVE net revenue through the Welch statistics", () => {
    // Gross 10, refunded 25 -> net -15. Sum(x) is negative and Sum(x^2) is
    // 225. This is the case the converter-only log aggregates structurally
    // cannot express, and clamping it to 0 would bias revenue per user
    // upward for exactly the arm that is losing money.
    const row = rowFor(V_NET_NEGATIVE);
    expect(row.mature_users).toBe(1);
    expect(row.converters).toBe(0);
    expect(row.net_revenue_usd).toBeCloseTo(-15, 4);
    expect(row.net_revenue_sq).toBeCloseTo(225, 4);
  });

  it("excludes immature and crossover subscribers from the Welch statistics too", () => {
    for (const variantId of [V_IMMATURE, V_CROSSOVER_A, V_CROSSOVER_B]) {
      const row = rowFor(variantId);
      expect(row.mature_users).toBe(0);
      expect(row.net_revenue_usd).toBeCloseTo(0, 4);
      expect(row.net_revenue_sq).toBeCloseTo(0, 4);
    }
  });

  it("Ruling 5: a duplicate eventId (at-least-once redelivery) is deduped, not double-summed", () => {
    const row = rowFor(V_DUP_EVENT);
    expect(row.mature_users).toBe(1);
    expect(row.converters).toBe(1);
    // If FINAL dedup were missing, this would be 40, not 20.
    expect(row.revenue_usd).toBeCloseTo(20, 4);
  });

  it("counts a NON_RENEWING_PURCHASE and a CREDIT_PURCHASE in an experiment's gross", () => {
    // Task 4 ruling: the gross list excluded CREDIT_PURCHASE, so a paywall
    // experiment never counted coin-pack revenue it caused, and would have
    // gone on to miss one-time purchases too — an experiment's revenue
    // counts every sale it caused. Executes the real query against real
    // ClickHouse rather than asserting on a SQL string.
    const row = rowFor(V_ONE_TIME_TYPES);
    expect(row.mature_users).toBe(1);
    expect(row.converters).toBe(1);
    // gross = 25 (NON_RENEWING_PURCHASE) + 5 (CREDIT_PURCHASE) = 30.
    expect(row.revenue_usd).toBeCloseTo(30, 4);
    expect(row.refunds_usd).toBeCloseTo(0, 4);
  });
});

describe("runAnalyticsQuery experiment_revenue_by_store — per-store split", () => {
  let storeRows: ExperimentStoreRevenueRow[];

  beforeAll(async () => {
    storeRows = await runAnalyticsQuery({
      kind: "experiment_revenue_by_store",
      projectId: PROJECT,
      experimentId: EXPERIMENT_ID,
    });
  });

  it("splits mature, windowed revenue by store for the same variant", () => {
    const rowsForVariant = storeRows
      .filter((r) => r.variant_id === V_STORE_SPLIT)
      .sort((a, b) => a.store.localeCompare(b.store));
    expect(rowsForVariant).toHaveLength(2);
    const apple = rowsForVariant.find((r) => r.store === "APP_STORE")!;
    const google = rowsForVariant.find((r) => r.store === "PLAY_STORE")!;
    expect(apple.revenue_usd).toBeCloseTo(40, 4);
    expect(google.revenue_usd).toBeCloseTo(15, 4);
  });

  it("does not include crossover or immature subscribers in the store split", () => {
    expect(storeRows.some((r) => r.variant_id === V_IMMATURE)).toBe(false);
    expect(storeRows.some((r) => r.variant_id === V_CROSSOVER_A)).toBe(false);
    expect(storeRows.some((r) => r.variant_id === V_CROSSOVER_B)).toBe(false);
  });
});
