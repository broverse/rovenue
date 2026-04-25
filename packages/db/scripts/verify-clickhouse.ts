#!/usr/bin/env tsx
// =============================================================
// ClickHouse schema-drift verifier
// =============================================================
//
// Asserts the live ClickHouse instance matches the schema
// declared in packages/db/clickhouse/migrations/*.sql — same
// pattern as `verify-timescale.ts`, but for the analytics
// pipeline tables and their engines.
//
// What it checks:
//   1. The expected tables exist in database `rovenue` and
//      carry the right ENGINE (Kafka, ReplacingMergeTree,
//      MaterializedView, SummingMergeTree, AggregatingMergeTree).
//      Covers Plan 1 (exposure pipeline) and Plan 2 (revenue +
//      credit Kafka chains, MRR/credit-balance rollups).
//   2. Kafka consumer state — last_poll_time, num_messages_read,
//      and any recent librdkafka exceptions. Useful for spotting
//      a mis-configured broker or a CH container that booted
//      before Redpanda. Includes Plan 2 consumer groups
//      rovenue-ch-revenue and rovenue-ch-credit.
//   3. Outbox-backlog diagnostic — queries Postgres
//      outbox_events WHERE publishedAt IS NULL, grouped by
//      aggregateType. Two-tier threshold:
//        WARN (default 1 000, env OUTBOX_BACKLOG_WARN_THRESHOLD)
//          → prints warning, exit 0.
//        CRIT (default 10 000, env OUTBOX_BACKLOG_CRIT_THRESHOLD)
//          → prints error, exit 2.
//      Steady-state should be ~0; sustained 1k = look, 10k = page.
//
// Usage:
//   CLICKHOUSE_URL=http://localhost:8124 \
//   CLICKHOUSE_USER=rovenue \
//   CLICKHOUSE_PASSWORD=rovenue \
//   DATABASE_URL=postgresql://rovenue:rovenue@localhost:5432/rovenue \
//     pnpm --filter @rovenue/db db:verify:clickhouse
//
// Exits non-zero if any expected table is missing or on the
// wrong engine.

import { createClient } from "@clickhouse/client";
import { Client as PgClient } from "pg";

const url = process.env.CLICKHOUSE_URL;
const user = process.env.CLICKHOUSE_USER ?? "rovenue";
const password = process.env.CLICKHOUSE_PASSWORD;

if (!url) {
  console.error("CLICKHOUSE_URL is required");
  process.exit(1);
}
if (!password) {
  console.error("CLICKHOUSE_PASSWORD is required");
  process.exit(1);
}

const client = createClient({
  url,
  username: user,
  password,
  database: "rovenue",
});

// -------------------------------------------------------------
// Expected inventory — single source of truth. Must match the
// engines declared in packages/db/clickhouse/migrations/*.sql.
// -------------------------------------------------------------
const EXPECTED_TABLES: ReadonlyArray<{ name: string; engine: string }> = [
  // Plan 1 — exposure pipeline
  { name: "exposures_queue", engine: "Kafka" },
  { name: "raw_exposures", engine: "ReplacingMergeTree" },
  { name: "mv_exposures_to_raw", engine: "MaterializedView" },
  { name: "mv_experiment_daily", engine: "MaterializedView" },
  { name: "mv_experiment_daily_target", engine: "SummingMergeTree" },
  // Plan 2 — revenue Kafka chain
  { name: "revenue_queue", engine: "Kafka" },
  { name: "raw_revenue_events", engine: "ReplacingMergeTree" },
  { name: "mv_revenue_to_raw", engine: "MaterializedView" },
  // Plan 2 — credit Kafka chain
  { name: "credit_queue", engine: "Kafka" },
  { name: "raw_credit_ledger", engine: "ReplacingMergeTree" },
  { name: "mv_credit_to_raw", engine: "MaterializedView" },
  // Plan 2 — MRR rollup
  { name: "mv_mrr_daily_target", engine: "SummingMergeTree" },
  { name: "mv_mrr_daily", engine: "MaterializedView" },
  // Plan 2 — credit balance rollup
  { name: "mv_credit_balance_target", engine: "AggregatingMergeTree" },
  { name: "mv_credit_balance", engine: "MaterializedView" },
  // Plan 2 — credit consumption rollup
  { name: "mv_credit_consumption_daily_target", engine: "SummingMergeTree" },
  { name: "mv_credit_consumption_daily", engine: "MaterializedView" },
];

interface TableRow {
  name: string;
  engine: string;
}

interface KafkaConsumerRow {
  database: string;
  table: string;
  consumer_id: string;
  "assignments.topic": string[];
  "assignments.partition_id": number[];
  "assignments.current_offset": string[];
  last_poll_time: string;
  num_messages_read: string | number;
  num_commits: string | number;
  "exceptions.time": string[];
  "exceptions.text": string[];
}

async function main(): Promise<void> {
  // ---------- Schema check ----------
  const tableRes = await client.query({
    query:
      "SELECT name, engine FROM system.tables WHERE database = 'rovenue' ORDER BY name",
    format: "JSONEachRow",
  });
  const rows = (await tableRes.json()) as TableRow[];
  const byName = new Map(rows.map((r) => [r.name, r.engine]));

  let drift = 0;
  console.log("ClickHouse schema check:");
  for (const expected of EXPECTED_TABLES) {
    const actual = byName.get(expected.name);
    const ok = actual === expected.engine;
    console.log(
      `  ${ok ? "✓" : "✗"} ${expected.name} — expected ${
        expected.engine
      }, got ${actual ?? "MISSING"}`,
    );
    if (!ok) drift++;
  }

  // ---------- Kafka consumer state ----------
  //
  // system.kafka_consumers in CH 24.3 exposes `topic` /
  // `partition_id` / `current_offset` as nested arrays under
  // `assignments` — we flatten them with the dotted-name accessor
  // so the JSON output is cleaner for operators.
  const consumerRes = await client.query({
    query: `
      SELECT
        database,
        table,
        consumer_id,
        assignments.topic          AS \`assignments.topic\`,
        assignments.partition_id   AS \`assignments.partition_id\`,
        assignments.current_offset AS \`assignments.current_offset\`,
        last_poll_time,
        num_messages_read,
        num_commits,
        exceptions.time            AS \`exceptions.time\`,
        exceptions.text            AS \`exceptions.text\`
      FROM system.kafka_consumers
      ORDER BY database, table
    `,
    format: "JSONEachRow",
  });
  const consumers = (await consumerRes.json()) as KafkaConsumerRow[];

  console.log("\nKafka consumer state:");
  if (consumers.length === 0) {
    console.log("  (no rovenue.* Kafka Engine consumers registered yet)");
  } else {
    console.log(JSON.stringify(consumers, null, 2));
  }

  await client.close();

  if (drift > 0) {
    console.error(`\nSchema drift detected: ${drift} table(s) off spec.`);
    process.exit(1);
  }
  console.log("\nClickHouse schema: OK");

  // ---------- Outbox backlog per aggregate ----------
  //
  // Healthy steady-state: 0 unpublished rows per aggregate.
  // WARN: any aggregate >= OUTBOX_BACKLOG_WARN_THRESHOLD (default 1 000)
  //   → exit 0 but print a warning header.
  // CRIT: any aggregate >= OUTBOX_BACKLOG_CRIT_THRESHOLD (default 10 000)
  //   → exit 2.
  //
  // Thresholds re-tunable per env after 30 days of prod data.

  const WARN_THRESHOLD = Number(
    process.env.OUTBOX_BACKLOG_WARN_THRESHOLD ?? 1_000,
  );
  const CRIT_THRESHOLD = Number(
    process.env.OUTBOX_BACKLOG_CRIT_THRESHOLD ?? 10_000,
  );

  const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const { rows } = await pg.query<{
      aggregate_type: string;
      backlog: number;
    }>(`
      SELECT "aggregateType" AS aggregate_type, count(*)::int AS backlog
      FROM outbox_events
      WHERE "publishedAt" IS NULL
      GROUP BY "aggregateType"
      ORDER BY "aggregateType"
    `);
    console.log("\nOutbox backlog per aggregate:");
    if (rows.length === 0) {
      console.log("  (all aggregates drained — backlog = 0)");
    } else {
      for (const r of rows) {
        console.log(`  ${r.aggregate_type}: ${r.backlog.toLocaleString()}`);
      }
    }
    const maxBacklog =
      rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.backlog));
    if (maxBacklog >= CRIT_THRESHOLD) {
      console.error(
        `\nCRIT: outbox backlog ${maxBacklog} >= ${CRIT_THRESHOLD} (env OUTBOX_BACKLOG_CRIT_THRESHOLD)`,
      );
      process.exit(2);
    }
    if (maxBacklog >= WARN_THRESHOLD) {
      console.warn(
        `\nWARN: outbox backlog ${maxBacklog} >= ${WARN_THRESHOLD} (env OUTBOX_BACKLOG_WARN_THRESHOLD)`,
      );
    }
  } finally {
    await pg.end();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
