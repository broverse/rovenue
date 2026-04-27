// =============================================================
// MRR endpoint — ClickHouse-exclusive integration test (Plan 3 Phase A)
// =============================================================
//
// Replaces the deleted dual-read and correlation tests. Asserts that
// `listDailyMrr` (services/metrics/mrr.ts) reads from CH's
// `mv_mrr_daily_target` aggregate after revenue events flow through
// the Kafka path:
//
//   producer → rovenue.revenue topic → CH Kafka Engine
//            → raw_revenue_events → mv_revenue_to_raw
//            → mv_mrr_daily      → mv_mrr_daily_target
//
// Cases:
//   1. Response shape unchanged from the dual-read snapshot:
//      `{ bucket: Date, grossUsd: string, eventCount: number,
//         activeSubscribers: number }`, ordered by bucket ASC.
//   2. End-to-end freshness: producer.send() → endpoint visibility
//      under the freshness budget (5s p95). p99 (≤30s) requires a
//      larger sample than this test runs; it lives in load-test land.
//   3. Empty-result behaviour: a project with zero revenue events
//      returns `[]`, not an error.
//
// Port allocation (fixed host ports, no dynamic mapping):
//   BROKER_EXTERNAL_PORT = 19098
//   CH_HOST_PORT         = 8228
//
// NOT parallel-safe: binds fixed host ports above.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient } from "@clickhouse/client";
import { Kafka, type Producer } from "kafkajs";
import {
  __resetClickHouseForTests,
  queryAnalytics,
} from "../src/lib/clickhouse";
import { listDailyMrr } from "../src/services/metrics/mrr";

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let brokerUrl: string;
let chUrl: string;
let producer: Producer;

const BROKER_EXTERNAL_PORT = 19098;
const CH_HOST_PORT = 8228;

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
  brokerUrl = `localhost:${BROKER_EXTERNAL_PORT}`;

  const kafkaAdmin = new Kafka({
    clientId: "mrr-ch-only-setup",
    brokers: [brokerUrl],
  }).admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    topics: [
      { topic: "rovenue.exposures", numPartitions: 3 },
      { topic: "rovenue.revenue", numPartitions: 3 },
      { topic: "rovenue.credit", numPartitions: 3 },
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
  chUrl = `http://localhost:${CH_HOST_PORT}`;

  // Bind the production code path to this testcontainer.
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";
  __resetClickHouseForTests();

  // Stabilise CH HTTP (3 consecutive auth'd successes — same pattern as
  // outbox-revenue-credit-replay).
  let stableSuccesses = 0;
  await waitFor(async () => {
    try {
      const ch = createClient({
        url: chUrl,
        username: "rovenue",
        password: "rovenue_test",
      });
      const res = await ch.query({
        query: "SELECT 1 AS ok",
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ ok: number }>;
      await ch.close();
      if (rows[0]?.ok === 1) {
        stableSuccesses++;
        return stableSuccesses >= 3;
      }
      stableSuccesses = 0;
      return false;
    } catch {
      stableSuccesses = 0;
      return false;
    }
  }, 45_000);

  // Apply CH migrations with the inline 24.3 race workaround.
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const chBootstrap = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "default",
    request_timeout: 60_000,
  });
  await chBootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await chBootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (
      filename String,
      sha256 FixedString(64),
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await chBootstrap.close();

  const chMig = createClient({
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

  const appliedRes = await chMig.query({
    query: "SELECT filename FROM _migrations FINAL",
    format: "JSONEachRow",
  });
  const appliedRows = (await appliedRes.json()) as Array<{ filename: string }>;
  const applied = new Set(appliedRows.map((r) => r.filename));

  for (const filename of files) {
    if (applied.has(filename)) continue;
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
      await chMig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const tableMatch = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (tableMatch) {
          const tableName = tableMatch[1];
          const [dbName, tblName] = tableName.includes(".")
            ? tableName.split(".")
            : ["rovenue", tableName];
          await waitFor(async () => {
            try {
              const res = await chMig.query({
                query: `SELECT count() AS c FROM system.tables WHERE database = '${dbName}' AND name = '${tblName}'`,
                format: "JSONEachRow",
              });
              const rows = (await res.json()) as Array<{ c: string | number }>;
              return Number(rows[0]?.c ?? 0) >= 1;
            } catch {
              return false;
            }
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await chMig.insert({
      table: "_migrations",
      values: [{ filename, sha256 }],
      format: "JSONEachRow",
    });
  }
  await chMig.close();

  const kafka = new Kafka({
    clientId: "mrr-ch-only-producer",
    brokers: [brokerUrl],
  });
  producer = kafka.producer({ idempotent: false });
  await producer.connect();
}, 300_000);

afterAll(async () => {
  await producer?.disconnect();
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

describe("listDailyMrr (CH-exclusive)", () => {
  it(
    "returns the canonical shape ordered by bucket ASC",
    async () => {
      const RUN_ID = Date.now();
      const projectId = `prj_mrr_shape_${RUN_ID}`;
      const subscriberId = `sub_mrr_shape_${RUN_ID}`;

      // Two days, three events: $10 + $20 on day 1, $30 on day 2.
      const events = [
        { evt: 1, day: "2026-04-24", amt: 10, sub: subscriberId },
        { evt: 2, day: "2026-04-24", amt: 20, sub: `${subscriberId}_b` },
        { evt: 3, day: "2026-04-25", amt: 30, sub: subscriberId },
      ];

      const messages = events.map((e) => ({
        key: `rev_${e.evt}_${RUN_ID}`,
        value: JSON.stringify({
          eventId: `evt_${e.evt}_${RUN_ID}`,
          eventType: "revenue.event.recorded",
          aggregateId: `rev_${e.evt}_${RUN_ID}`,
          createdAt: new Date().toISOString(),
          payload: JSON.stringify({
            revenueEventId: `rev_${e.evt}_${RUN_ID}`,
            projectId,
            subscriberId: e.sub,
            purchaseId: `pur_${e.evt}_${RUN_ID}`,
            productId: `prod_${RUN_ID}`,
            type: "RENEWAL",
            store: "APP_STORE",
            amount: String(e.amt),
            amountUsd: String(e.amt),
            currency: "USD",
            eventDate: `${e.day}T00:00:00.000Z`,
          }),
        }),
      }));

      await producer.send({ topic: "rovenue.revenue", messages });

      // Wait until the MV chain has propagated to mv_mrr_daily_target.
      // Two distinct day buckets are expected (2026-04-24, 2026-04-25).
      await waitFor(async () => {
        const rows = await queryAnalytics<{ c: string }>(
          projectId,
          `SELECT count() AS c
             FROM rovenue.mv_mrr_daily_target FINAL
            WHERE projectId = {projectId:String}`,
        );
        return Number(rows[0]?.c ?? 0) >= 2;
      }, 90_000);

      const points = await listDailyMrr({
        projectId,
        from: new Date("2026-04-20T00:00:00Z"),
        to: new Date("2026-04-30T00:00:00Z"),
      });

      // Shape contract.
      expect(points).toHaveLength(2);
      for (const p of points) {
        expect(p.bucket).toBeInstanceOf(Date);
        expect(typeof p.grossUsd).toBe("string");
        expect(typeof p.eventCount).toBe("number");
        expect(typeof p.activeSubscribers).toBe("number");
      }

      // Order by bucket ASC.
      expect(points[0]!.bucket.getTime()).toBeLessThan(
        points[1]!.bucket.getTime(),
      );

      // Day 1: $30 across 2 events, 2 distinct subscribers.
      expect(points[0]!.bucket.toISOString()).toBe("2026-04-24T00:00:00.000Z");
      expect(Number(points[0]!.grossUsd)).toBeCloseTo(30, 2);
      expect(points[0]!.eventCount).toBe(2);
      expect(points[0]!.activeSubscribers).toBe(2);

      // Day 2: $30 across 1 event, 1 distinct subscriber.
      expect(points[1]!.bucket.toISOString()).toBe("2026-04-25T00:00:00.000Z");
      expect(Number(points[1]!.grossUsd)).toBeCloseTo(30, 2);
      expect(points[1]!.eventCount).toBe(1);
      expect(points[1]!.activeSubscribers).toBe(1);
    },
    240_000,
  );

  it(
    "meets the freshness budget: p95 from producer.send() to endpoint ≤ 5s",
    async () => {
      // Sample size 5 — small enough to keep wall-clock reasonable; the
      // real p99 budget is enforced by the load test, not this one.
      const SAMPLES = 5;
      const latencies: number[] = [];

      for (let i = 0; i < SAMPLES; i++) {
        const RUN_ID = `${Date.now()}_${i}`;
        const projectId = `prj_mrr_fresh_${RUN_ID}`;
        const subscriberId = `sub_mrr_fresh_${RUN_ID}`;

        const start = performance.now();

        await producer.send({
          topic: "rovenue.revenue",
          messages: [
            {
              key: `rev_fresh_${RUN_ID}`,
              value: JSON.stringify({
                eventId: `evt_fresh_${RUN_ID}`,
                eventType: "revenue.event.recorded",
                aggregateId: `rev_fresh_${RUN_ID}`,
                createdAt: new Date().toISOString(),
                payload: JSON.stringify({
                  revenueEventId: `rev_fresh_${RUN_ID}`,
                  projectId,
                  subscriberId,
                  purchaseId: `pur_fresh_${RUN_ID}`,
                  productId: `prod_fresh_${RUN_ID}`,
                  type: "RENEWAL",
                  store: "APP_STORE",
                  amount: "9.99",
                  amountUsd: "9.99",
                  currency: "USD",
                  eventDate: "2026-04-26T00:00:00.000Z",
                }),
              }),
            },
          ],
        });

        // Spin until listDailyMrr returns this project's bucket.
        await waitFor(async () => {
          const points = await listDailyMrr({
            projectId,
            from: new Date("2026-04-26T00:00:00Z"),
            to: new Date("2026-04-26T23:59:59Z"),
          });
          return points.length === 1;
        }, 60_000);

        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.min(
        latencies.length - 1,
        Math.floor(latencies.length * 0.95),
      );
      const p95 = latencies[p95Index]!;

      // Budget: p95 ≤ 5s on the testcontainer fixture. Tighten by tuning
      // the dispatcher poll interval / batch size if this fails.
      expect(p95).toBeLessThanOrEqual(5_000);
    },
    600_000,
  );

  it(
    "returns [] for a project with zero revenue events",
    async () => {
      const points = await listDailyMrr({
        projectId: `prj_mrr_empty_${Date.now()}`,
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-12-31T00:00:00Z"),
      });
      expect(points).toEqual([]);
    },
    30_000,
  );
});
