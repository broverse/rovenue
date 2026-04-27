-- 0015_partition_revenue_events.sql
-- Plan 3 §D.2 — convert revenue_events from a TimescaleDB hypertable to
-- a vanilla declarative range-partitioned table on `eventDate` (monthly).
--
-- Pre-req: Plan 3 Phase 0 cutover gate passed in production.
-- Pre-req: Phase C (0014_drop_daily_mrr_cagg) applied.
-- Pre-req: migrate-hypertable-to-partitioned.ts dry-run passed in staging.
--
-- This migration only renames + creates. The data copy runs OUTSIDE
-- the migration via packages/db/scripts/migrate-hypertable-to-partitioned.ts
-- (one tx per partition, not one for the whole copy). The legacy table
-- is dropped by 0015a, gated on PLAN3_LEGACY_DROP_VERIFIED=1.
--
-- Schema MUST match packages/db/src/drizzle/schema.ts (revenueEvents)
-- column-for-column. A drift means Drizzle inserts will silently fail
-- against the new table.
--
-- drizzle-orm's migrator already wraps each .sql in a transaction.

ALTER TABLE "revenue_events" RENAME TO "revenue_events_legacy_hypertable";--> statement-breakpoint

CREATE TABLE "revenue_events" (
  "id"             text                NOT NULL,
  "projectId"      text                NOT NULL REFERENCES "projects"("id")  ON DELETE CASCADE,
  "subscriberId"   text                NOT NULL REFERENCES "subscribers"("id") ON DELETE CASCADE,
  "purchaseId"     text                NOT NULL REFERENCES "purchases"("id"),
  "type"           "RevenueEventType"  NOT NULL,
  "amount"         numeric(12, 4)      NOT NULL,
  "currency"       text                NOT NULL,
  "amountUsd"      numeric(12, 4)      NOT NULL,
  "store"          "Store"             NOT NULL,
  "productId"      text                NOT NULL REFERENCES "products"("id"),
  "eventDate"      timestamptz         NOT NULL,
  "createdAt"      timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id", "eventDate")
) PARTITION BY RANGE ("eventDate");--> statement-breakpoint

CREATE INDEX "revenue_events_projectId_eventDate_idx"
  ON "revenue_events" ("projectId", "eventDate");--> statement-breakpoint
CREATE INDEX "revenue_events_subscriberId_type_idx"
  ON "revenue_events" ("subscriberId", "type");--> statement-breakpoint

-- Initial partitions: 2024-01 through 2028-12 (60 months).
-- pg_partman (Phase F migration 0019) takes over rolling-window
-- premake/drop after this migration; it's safe to over-provision here.
DO $partitions$
DECLARE
  start_month date := DATE '2024-01-01';
  end_month   date := DATE '2029-01-01';
  cur date := start_month;
  next_month date;
  child_name text;
BEGIN
  WHILE cur < end_month LOOP
    next_month := (cur + INTERVAL '1 month')::date;
    child_name := format('revenue_events_%s_%s',
                         to_char(cur, 'YYYY'),
                         to_char(cur, 'MM'));
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "revenue_events" FOR VALUES FROM (%L) TO (%L)',
      child_name, cur::timestamptz, next_month::timestamptz
    );
    cur := next_month;
  END LOOP;
END
$partitions$;
