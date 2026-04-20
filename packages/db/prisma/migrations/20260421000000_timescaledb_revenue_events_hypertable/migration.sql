-- ============================================================
-- TimescaleDB — revenue_events hypertable + continuous aggregate
-- ============================================================
--
-- Requires the `timescale/timescaledb` Docker image (see
-- docker-compose.yml). `CREATE EXTENSION IF NOT EXISTS` is a
-- no-op on a DB that already has it; on vanilla Postgres it
-- surfaces a clear error pointing at the image bump.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================
-- 1. Primary key rewrite
-- ============================================================
--
-- TimescaleDB requires every UNIQUE constraint (including the
-- PK) to include the partition column. The init migration wrote
-- PRIMARY KEY (id); we extend that to (id, eventDate) so the
-- hypertable conversion can run without copying the table.

ALTER TABLE "revenue_events" DROP CONSTRAINT "revenue_events_pkey";
ALTER TABLE "revenue_events"
  ADD CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id", "eventDate");

-- ============================================================
-- 2. Convert to hypertable
-- ============================================================
--
-- `eventDate` carries the business timestamp (when the store
-- recorded the charge), which is what analytics queries filter
-- and bucket on. Using that — not createdAt — as the partition
-- column keeps daily_mrr accurate even when webhook delivery
-- stretches several minutes behind the event.
--
-- 1-day chunk interval fits the current read patterns (MTD /
-- YTD / rolling 30). Larger intervals start to slow chunk
-- exclusion; smaller ones explode the chunk count. Ops can
-- `SELECT set_chunk_time_interval('revenue_events', INTERVAL '…')`
-- later if ingest volume changes the tradeoff.
--
-- `migrate_data => TRUE` copies existing rows into the new
-- chunked structure. Safe: revenue_events is append-only and
-- the table volume in dev is tiny.

SELECT create_hypertable(
  'revenue_events',
  'eventDate',
  chunk_time_interval => INTERVAL '1 day',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

-- ============================================================
-- 3. Compression
-- ============================================================
--
-- Chunks older than 7 days are compressed in place with a
-- project-scoped columnar layout. ~10-20× storage win once the
-- dataset is real; negligible CPU on the reader side because
-- TimescaleDB keeps decompression per-chunk and respects chunk
-- exclusion first.

ALTER TABLE "revenue_events" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"eventDate" DESC'
);

SELECT add_compression_policy(
  'revenue_events',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- ============================================================
-- 4. Retention policy
-- ============================================================
--
-- Financial events stay online for 7 years to cover audit +
-- regulatory requests. Anything older is dropped by chunk —
-- cheap compared to DELETE on a regular table.

SELECT add_retention_policy(
  'revenue_events',
  INTERVAL '7 years',
  if_not_exists => TRUE
);

-- ============================================================
-- 5. Continuous aggregate — daily_mrr
-- ============================================================
--
-- Per-project daily gross revenue (USD) that the dashboard's
-- MRR chart reads in constant time. `materialized_only => FALSE`
-- means the view unions the materialised window with a fresh
-- real-time tail for today's incomplete bucket, so callers
-- never see yesterday's MRR when today is already in flight.
--
-- `with_data => FALSE` skips the initial backfill — the refresh
-- policy below fills the window from existing rows the first
-- time it runs. Running the backfill inside `CREATE MATERIALIZED
-- VIEW` would take a migration lock for the duration of the
-- backfill, which we don't want on a first-time deploy.

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_mrr
WITH (timescaledb.continuous) AS
SELECT
  "projectId",
  time_bucket(INTERVAL '1 day', "eventDate") AS bucket,
  SUM("amountUsd") AS gross_usd,
  COUNT(*)          AS event_count,
  COUNT(DISTINCT "subscriberId") AS active_subscribers
FROM "revenue_events"
GROUP BY "projectId", bucket
WITH NO DATA;

-- Refresh the last 60 days every 10 minutes. The window starts
-- one hour in the future so the tail keeps up with a small
-- clock skew on the writer side.
SELECT add_continuous_aggregate_policy(
  'daily_mrr',
  start_offset      => INTERVAL '60 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes',
  if_not_exists     => TRUE
);
