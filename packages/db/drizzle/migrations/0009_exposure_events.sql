-- exposure_events: one row per variant impression. Every call to
-- getVariant() on a live experiment writes here. Higher insert rate
-- than revenue_events (~10-100x per project), so we partition on
-- 1-hour chunks instead of 1-day and keep only 90 days in Postgres
-- — ClickHouse mv_experiment_daily (Phase 4.5) owns the long-term
-- aggregates.
--
-- Column names are double-quoted camelCase so they survive PG's
-- default identifier lowercasing and match the rovenue on-disk
-- convention (revenueEvents, creditLedger etc).
--
-- drizzle-orm's migrator wraps each .sql in a transaction — no
-- BEGIN/COMMIT here.

CREATE TABLE "exposure_events" (
  "id" TEXT NOT NULL,
  "experimentId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "platform" TEXT,
  "country" TEXT,
  "exposedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "exposure_events_pkey" PRIMARY KEY ("id", "exposedAt")
);

CREATE INDEX "exposure_events_experimentId_exposedAt_idx"
  ON "exposure_events" ("experimentId", "exposedAt" DESC);
CREATE INDEX "exposure_events_projectId_exposedAt_idx"
  ON "exposure_events" ("projectId", "exposedAt" DESC);

-- Convert to a hypertable. Matches the pattern in 0002/0003/0004.
-- Table is empty at migration time, so migrate_data => true is a
-- no-op that tolerates re-runs.
SELECT create_hypertable(
  '"exposure_events"',
  by_range('exposedAt', INTERVAL '1 hour'),
  migrate_data => true,
  if_not_exists => true
);

-- Compression: segment by experiment so same-experiment rows share
-- columnar encoding. Segmenting by projectId instead would collapse
-- all experiments of a given project — the experiment_id dimension
-- is the hot filter (stats endpoints group by variant within a
-- single experiment).
ALTER TABLE "exposure_events" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"experimentId"',
  timescaledb.compress_orderby = '"exposedAt" DESC'
);
SELECT add_compression_policy('exposure_events', INTERVAL '7 days');

-- Retention: drop chunks older than 90 days. ClickHouse aggregates
-- cover the rest (Plan 1 Phase 4.5 mv_experiment_daily).
SELECT add_retention_policy('exposure_events', INTERVAL '90 days');
