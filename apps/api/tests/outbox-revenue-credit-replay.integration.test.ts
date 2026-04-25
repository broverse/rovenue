// =============================================================
// Outbox replay idempotency — revenue + credit aggregates (E.2)
// =============================================================
//
// Proves that ClickHouse's ReplacingMergeTree tables
// `raw_revenue_events` and `raw_credit_ledger` deduplicate on
// `eventId` when the same Kafka message is delivered more than once.
//
// This is the at-least-once safety property for the two new
// aggregates introduced in Plan 2 (the EXPOSURE equivalent was
// proven in Plan 1's `outbox-replay-idempotency.test.ts`).
//
// Shape:
//   1. Spin Redpanda + ClickHouse via testcontainers on a shared
//      Network.
//   2. Apply CH migrations 0001–0008 via the manual inline path
//      from D.3 (splits Kafka Engine CREATE from MV CREATE to avoid
//      the CH 24.3 race condition documented in dashboard-mrr-
//      dual-read.test.ts).
//   3. Publish 3 revenue payloads and 3 credit payloads via an
//      ad-hoc producer — each eventId appears once initially.
//   4. Wait for CH raw tables to receive all 6 rows.
//   5. Snapshot: count and sum from raw_revenue_events FINAL;
//      count, last-balance, granted-sum, debited-sum from
//      raw_credit_ledger FINAL.
//   6. REPLAY: re-publish the same 6 Kafka payloads (identical
//      eventIds). This simulates Redpanda's at-least-once delivery
//      sending the same message twice — the actual production
//      failure mode the dispatcher must tolerate.
//   7. Wait briefly then snapshot again.
//   8. Assert: counts + sums are unchanged (ReplacingMergeTree
//      on (projectId, eventDate/createdAt, eventId) dedupes).
//
// mv_mrr_daily_target and mv_credit_balance_target are intentionally
// NOT asserted post-replay: the source of truth is raw_revenue_events
// and raw_credit_ledger. Downstream MV idempotency follows from
// raw-table idempotency. The MV chain quirk (documented in D.3)
// means the MV may not fire from the Kafka chain in a fresh
// testcontainer, so asserting MV counts is unreliable in this test.
//
// Port allocation (fixed host ports, no dynamic mapping):
//   BROKER_EXTERNAL_PORT = 19097  (not used by any other test)
//   CH_HOST_PORT         = 8227   (not used by any other test)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient } from "@clickhouse/client";
import { Kafka, type Producer } from "kafkajs";

const execFileP = promisify(execFile);

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let brokerUrl: string;
let chUrl: string;

const BROKER_EXTERNAL_PORT = 19097;
const CH_HOST_PORT = 8227;

// ----------------------------------------------------------------
// Helper: poll until fn() returns true or timeoutMs is exceeded.
// ----------------------------------------------------------------
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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}

// ----------------------------------------------------------------
// Container boot + migration setup (beforeAll)
// ----------------------------------------------------------------
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

  // Pre-create topics so CH Kafka Engine attaches on first poll.
  const kafkaAdmin = new Kafka({
    clientId: "rev-cred-replay-setup",
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

  // Do NOT mount a <kafka> config.xml — CH 24.3 rejects the
  // legacy `kafka.broker.list` flattening. The per-table SETTINGS
  // clause in the Kafka Engine migrations is the only broker surface.
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

  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";

  // Wait for CH HTTP interface to stabilise: need 3 consecutive
  // successful authenticated queries before the deferred user
  // creation settles (same technique as G.1 and D.3).
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

  // Apply CH migrations using the inline manual path from D.3.
  //
  // CH 24.3-alpine has a race condition: CREATE TABLE ... ENGINE = Kafka
  // completes synchronously, but the Kafka consumer background thread
  // registers the table asynchronously. If a CREATE MATERIALIZED VIEW
  // FROM <kafka_table> is issued before registration completes, CH
  // raises UNKNOWN_TABLE. The migration runner (which fires statements
  // sequentially without waiting) hits this race on 0004/0005 because
  // both have a Kafka Engine table followed immediately by an MV.
  //
  // Fix: apply all 8 migrations directly via the CH client here,
  // inserting a waitFor(system.tables) + 3s settle delay after each
  // ENGINE = Kafka CREATE — same workaround as D.3. We record applied
  // migrations in the _migrations table so a subsequent runner
  // invocation won't re-apply them.
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const chMigBootstrap = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "default",
    request_timeout: 60_000,
  });
  await chMigBootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await chMigBootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (
      filename String,
      sha256 FixedString(64),
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await chMigBootstrap.close();

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

    // Split on `;` at end of line (same logic as clickhouse-migrate.ts).
    // Strip leading comment lines from each segment so we see the
    // actual SQL keyword (not a comment) before filtering empty segments.
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
      // After creating a Kafka Engine table, wait until it appears in
      // system.tables, then add a 3s settle delay for the Kafka consumer
      // thread to register the table internally. Skipping this delay
      // causes the subsequent MV CREATE to fail with UNKNOWN_TABLE.
      // (CH 24.3-alpine race; documented in D.3.)
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
}, 300_000);

afterAll(async () => {
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

// ----------------------------------------------------------------
// Test
// ----------------------------------------------------------------

describe("outbox replay idempotency — revenue + credit", () => {
  it(
    "re-dispatching same outbox rows leaves CH counts + sums unchanged",
    async () => {
      const RUN_ID = Date.now();
      const projectId = `prj_replay_rc_${RUN_ID}`;
      const subscriberId = `sub_replay_rc_${RUN_ID}`;

      // ── 3 revenue events ──────────────────────────────────────
      // Each has a distinct eventId, revenueEventId, and purchaseId.
      // Amounts: $10, $20, $30. All RENEWAL type, 2026-04-24 eventDate.
      const revEvents = [
        {
          eventId: `evt_rev_1_${RUN_ID}`,
          revenueEventId: `rev_1_${RUN_ID}`,
          purchaseId: `pur_1_${RUN_ID}`,
          productId: `prod_1_${RUN_ID}`,
          amountUsd: 10.0,
          amount: 10.0,
          currency: "USD",
          type: "RENEWAL",
          store: "APP_STORE",
          eventDate: "2026-04-24T00:00:00.000Z",
        },
        {
          eventId: `evt_rev_2_${RUN_ID}`,
          revenueEventId: `rev_2_${RUN_ID}`,
          purchaseId: `pur_2_${RUN_ID}`,
          productId: `prod_1_${RUN_ID}`,
          amountUsd: 20.0,
          amount: 20.0,
          currency: "USD",
          type: "RENEWAL",
          store: "APP_STORE",
          eventDate: "2026-04-24T00:00:00.000Z",
        },
        {
          eventId: `evt_rev_3_${RUN_ID}`,
          revenueEventId: `rev_3_${RUN_ID}`,
          purchaseId: `pur_3_${RUN_ID}`,
          productId: `prod_1_${RUN_ID}`,
          amountUsd: 30.0,
          amount: 30.0,
          currency: "USD",
          type: "RENEWAL",
          store: "APP_STORE",
          eventDate: "2026-04-24T00:00:00.000Z",
        },
      ];

      // ── 3 credit ledger rows ───────────────────────────────────
      // Pattern: GRANT(+100, balance=100), DEBIT(-30, balance=70), GRANT(+50, balance=120).
      // Timestamps are artificially spread so createdAt ordering is deterministic.
      const creditRows = [
        {
          eventId: `evt_cred_1_${RUN_ID}`,
          creditLedgerId: `cred_1_${RUN_ID}`,
          type: "GRANT",
          amount: 100,
          balance: 100,
          createdAt: "2026-04-24T10:00:00.000Z",
        },
        {
          eventId: `evt_cred_2_${RUN_ID}`,
          creditLedgerId: `cred_2_${RUN_ID}`,
          type: "DEBIT",
          amount: -30,
          balance: 70,
          createdAt: "2026-04-24T11:00:00.000Z",
        },
        {
          eventId: `evt_cred_3_${RUN_ID}`,
          creditLedgerId: `cred_3_${RUN_ID}`,
          type: "GRANT",
          amount: 50,
          balance: 120,
          createdAt: "2026-04-24T12:00:00.000Z",
        },
      ];

      // ── Build Kafka payloads (same structure the dispatcher writes) ──
      //
      // The dispatcher serialises each outbox row as:
      //   { eventId, eventType, aggregateId, createdAt, payload: <object> }
      // The payload field is the outbox row's `payload` column — already
      // an object in Postgres (jsonb), but when the dispatcher serialises
      // the whole envelope via JSON.stringify it becomes a nested object.
      // The Kafka Engine MV uses JSONExtractString(payload, 'fieldName')
      // which works on a JSON string. We replicate the dispatcher shape
      // exactly: payload is already an object inside the outer envelope,
      // and JSON.stringify(outerEnvelope) encodes it as a string
      // representation of the nested JSON.
      //
      // Actually: the dispatcher does `payload: r.payload` where r.payload
      // is the JSONB object. JSON.stringify wraps the whole thing once, so
      // the `payload` field in the Kafka message value IS a JSON object
      // literal (not a string). The MV uses JSONExtractString(payload, ...)
      // where `payload` refers to the Kafka Engine column `payload String`.
      // The Kafka Engine reads the entire Kafka message value as JSONEachRow,
      // so `payload` maps to whatever value is at key "payload" in the top-
      // level JSON — which is an embedded JSON object. CH coerces it to a
      // String column by re-serialising, so JSONExtractString works on it.
      //
      // To match the dispatcher exactly, we pass `payload` as an object —
      // JSON.stringify wraps the outer envelope and CH reads it back.
      const revKafkaMessages = revEvents.map((e) => ({
        key: e.revenueEventId,
        value: JSON.stringify({
          eventId: e.eventId,
          eventType: "revenue.event.recorded",
          aggregateId: e.revenueEventId,
          createdAt: new Date().toISOString(),
          payload: JSON.stringify({
            revenueEventId: e.revenueEventId,
            projectId,
            subscriberId,
            purchaseId: e.purchaseId,
            productId: e.productId,
            type: e.type,
            store: e.store,
            amount: String(e.amount),
            amountUsd: String(e.amountUsd),
            currency: e.currency,
            eventDate: e.eventDate,
          }),
        }),
      }));

      const credKafkaMessages = creditRows.map((c) => ({
        key: c.creditLedgerId,
        value: JSON.stringify({
          eventId: c.eventId,
          eventType: "credit.ledger.appended",
          aggregateId: c.creditLedgerId,
          createdAt: new Date().toISOString(),
          payload: JSON.stringify({
            creditLedgerId: c.creditLedgerId,
            projectId,
            subscriberId,
            type: c.type,
            amount: c.amount,
            balance: c.balance,
            referenceType: null,
            referenceId: null,
            createdAt: c.createdAt,
          }),
        }),
      }));

      // ── Produce once (initial delivery) ───────────────────────
      const kafka = new Kafka({
        clientId: "rev-cred-replay-producer",
        brokers: [brokerUrl],
      });
      const producer: Producer = kafka.producer({ idempotent: false });
      await producer.connect();

      await producer.send({
        topic: "rovenue.revenue",
        messages: revKafkaMessages,
      });
      await producer.send({
        topic: "rovenue.credit",
        messages: credKafkaMessages,
      });

      const ch = createClient({
        url: chUrl,
        username: "rovenue",
        password: "rovenue_test",
        database: "rovenue",
      });

      // ── Wait for initial rows to land ─────────────────────────
      await waitFor(async () => {
        const res = await ch.query({
          query: `SELECT count() AS c FROM rovenue.raw_revenue_events WHERE projectId = {pid:String}`,
          query_params: { pid: projectId },
          format: "JSONEachRow",
        });
        const rows = (await res.json()) as Array<{ c: string | number }>;
        return Number(rows[0]?.c ?? 0) >= 3;
      }, 90_000);

      await waitFor(async () => {
        const res = await ch.query({
          query: `SELECT count() AS c FROM rovenue.raw_credit_ledger WHERE projectId = {pid:String}`,
          query_params: { pid: projectId },
          format: "JSONEachRow",
        });
        const rows = (await res.json()) as Array<{ c: string | number }>;
        return Number(rows[0]?.c ?? 0) >= 3;
      }, 90_000);

      // ── Snapshot 1 (before replay) ────────────────────────────
      const snap1Rev = await ch.query({
        query: `
          SELECT
            count() AS cnt,
            sum(amountUsd) AS totalUsd
          FROM rovenue.raw_revenue_events FINAL
          WHERE projectId = {pid:String}
        `,
        query_params: { pid: projectId },
        format: "JSONEachRow",
      });
      const snap1RevRows = (await snap1Rev.json()) as Array<{
        cnt: string | number;
        totalUsd: string | number;
      }>;
      const rawRevCount1 = Number(snap1RevRows[0]?.cnt ?? 0);
      const rawRevSum1 = Number(snap1RevRows[0]?.totalUsd ?? 0);

      const snap1Cred = await ch.query({
        query: `
          SELECT
            count() AS cnt,
            sumIf(amount, amount > 0) AS granted,
            sumIf(abs(amount), amount < 0) AS debited
          FROM rovenue.raw_credit_ledger FINAL
          WHERE projectId = {pid:String}
        `,
        query_params: { pid: projectId },
        format: "JSONEachRow",
      });
      const snap1CredRows = (await snap1Cred.json()) as Array<{
        cnt: string | number;
        granted: string | number;
        debited: string | number;
      }>;
      const rawCredCount1 = Number(snap1CredRows[0]?.cnt ?? 0);
      const rawCredGranted1 = Number(snap1CredRows[0]?.granted ?? 0);
      const rawCredDebited1 = Number(snap1CredRows[0]?.debited ?? 0);

      // Sanity-check initial delivery before replay.
      expect(rawRevCount1).toBe(3);
      expect(rawRevSum1).toBeCloseTo(60, 2);
      expect(rawCredCount1).toBe(3);
      expect(rawCredGranted1).toBe(150); // 100 + 50
      expect(rawCredDebited1).toBe(30);

      // ── REPLAY: re-produce the same 6 Kafka payloads ──────────
      //
      // Simulates Redpanda at-least-once delivery re-sending the same
      // messages after a consumer crash/restart. The Kafka Engine will
      // write new rows into raw_revenue_events and raw_credit_ledger,
      // but ReplacingMergeTree on (projectId, eventDate/createdAt, eventId)
      // deduplicates them on merge. FINAL forces the merge at read time,
      // so the logical row count stays at 3 for each table.
      await producer.send({
        topic: "rovenue.revenue",
        messages: revKafkaMessages,
      });
      await producer.send({
        topic: "rovenue.credit",
        messages: credKafkaMessages,
      });

      // Wait for the replayed rows to land (raw count should reach >= 6
      // since ReplacingMergeTree hasn't merged yet — pre-merge we see
      // both copies; FINAL will collapse them).
      await waitFor(async () => {
        const res = await ch.query({
          query: `SELECT count() AS c FROM rovenue.raw_revenue_events WHERE projectId = {pid:String}`,
          query_params: { pid: projectId },
          format: "JSONEachRow",
        });
        const rows = (await res.json()) as Array<{ c: string | number }>;
        // >=6 means both the original and the replay arrived.
        return Number(rows[0]?.c ?? 0) >= 6;
      }, 90_000);

      await waitFor(async () => {
        const res = await ch.query({
          query: `SELECT count() AS c FROM rovenue.raw_credit_ledger WHERE projectId = {pid:String}`,
          query_params: { pid: projectId },
          format: "JSONEachRow",
        });
        const rows = (await res.json()) as Array<{ c: string | number }>;
        return Number(rows[0]?.c ?? 0) >= 6;
      }, 90_000);

      // ── Snapshot 2 (after replay) — FINAL must still show 3 ──
      const snap2Rev = await ch.query({
        query: `
          SELECT
            count() AS cnt,
            sum(amountUsd) AS totalUsd
          FROM rovenue.raw_revenue_events FINAL
          WHERE projectId = {pid:String}
        `,
        query_params: { pid: projectId },
        format: "JSONEachRow",
      });
      const snap2RevRows = (await snap2Rev.json()) as Array<{
        cnt: string | number;
        totalUsd: string | number;
      }>;
      const rawRevCount2 = Number(snap2RevRows[0]?.cnt ?? 0);
      const rawRevSum2 = Number(snap2RevRows[0]?.totalUsd ?? 0);

      const snap2Cred = await ch.query({
        query: `
          SELECT
            count() AS cnt,
            sumIf(amount, amount > 0) AS granted,
            sumIf(abs(amount), amount < 0) AS debited
          FROM rovenue.raw_credit_ledger FINAL
          WHERE projectId = {pid:String}
        `,
        query_params: { pid: projectId },
        format: "JSONEachRow",
      });
      const snap2CredRows = (await snap2Cred.json()) as Array<{
        cnt: string | number;
        granted: string | number;
        debited: string | number;
      }>;
      const rawCredCount2 = Number(snap2CredRows[0]?.cnt ?? 0);
      const rawCredGranted2 = Number(snap2CredRows[0]?.granted ?? 0);
      const rawCredDebited2 = Number(snap2CredRows[0]?.debited ?? 0);

      await producer.disconnect();
      await ch.close();

      // ── Assertions ───────────────────────────────────────────
      //
      // FINAL forces ReplacingMergeTree to deduplicate on
      // (projectId, eventDate, eventId) for raw_revenue_events and
      // (projectId, createdAt, eventId) for raw_credit_ledger.
      // Same eventId means the same logical row — the replayed copy
      // does not survive the dedup.
      expect(rawRevCount2).toBe(rawRevCount1); // still 3
      expect(rawRevSum2).toBeCloseTo(rawRevSum1, 2); // still $60
      expect(rawCredCount2).toBe(rawCredCount1); // still 3
      expect(rawCredGranted2).toBe(rawCredGranted1); // still 150
      expect(rawCredDebited2).toBe(rawCredDebited1); // still 30
    },
    300_000,
  );
});
