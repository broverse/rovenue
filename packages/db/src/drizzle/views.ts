import { decimal, integer, pgMaterializedView, text, timestamp } from "drizzle-orm/pg-core";

// =============================================================
// TimescaleDB continuous aggregates, declared to Drizzle
// =============================================================
//
// Continuous aggregates are materialised views under the hood —
// Drizzle treats them the same as any MV. The schemas here MUST
// stay in lockstep with the `CREATE MATERIALIZED VIEW` statements
// in the timescaledb migration SQL. A column type or name drift
// breaks downstream repository types silently; the drizzle-
// foundation smoke test pins the column-name mapping so the drift
// surfaces in CI.
//
// `daily_mrr` lives in migration 20260421000000_timescaledb_
// revenue_events_hypertable. Columns:
//   projectId           text           partition / segmentby
//   bucket              timestamptz    time_bucket(1 day, eventDate)
//   gross_usd           numeric(12,4)  SUM(amountUsd)
//   event_count         bigint         COUNT(*)
//   active_subscribers  bigint         COUNT(DISTINCT subscriberId)

export const dailyMrr = pgMaterializedView("daily_mrr", {
  projectId: text("projectId").notNull(),
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  grossUsd: decimal("gross_usd", { precision: 12, scale: 4 }).notNull(),
  // Postgres COUNT(*) is bigint, which Drizzle surfaces as text by
  // default on node-postgres. We keep it numeric here and let the
  // repository layer coerce to number where needed.
  eventCount: integer("event_count").notNull(),
  activeSubscribers: integer("active_subscribers").notNull(),
}).existing();
