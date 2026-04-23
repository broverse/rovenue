-- daily_mrr continuous aggregate over revenue_events.
-- Columns MUST stay in lockstep with packages/db/src/drizzle/views.ts:
--   projectId            text           project scope
--   bucket               timestamptz    day bucket (UTC)
--   gross_usd            numeric(12,4)  SUM(amountUsd)
--   event_count          bigint         COUNT(*)
--   active_subscribers   bigint         COUNT(DISTINCT subscriberId)
--
-- TSL-gated: continuous aggregates require timescaledb.license=timescale
-- (see docker-compose.yml). Does NOT work under apache license.
--
-- NB: drizzle-orm's node-postgres migrator wraps each .sql file in a
-- transaction. `CALL refresh_continuous_aggregate(...)` cannot run
-- inside a transaction block, so the one-shot historical backfill
-- happens in Step 4 below (outside the migration) — not here.

CREATE MATERIALIZED VIEW "daily_mrr"
WITH (timescaledb.continuous) AS
SELECT
  "projectId"                               AS "projectId",
  time_bucket(INTERVAL '1 day', "eventDate") AS "bucket",
  SUM("amountUsd")                           AS "gross_usd",
  COUNT(*)                                   AS "event_count",
  COUNT(DISTINCT "subscriberId")             AS "active_subscribers"
FROM "revenue_events"
GROUP BY "projectId", "bucket"
WITH NO DATA;

-- Real-time tail: recompute the last 7 days every 10 minutes, leaving
-- the current hour live (on-read aggregation fills the gap). Matches
-- the dashboard expectation documented in apps/api/src/routes/
-- dashboard/metrics.ts line 15 ("refreshed every ~10 minutes with a
-- 1-hour real-time tail").
SELECT add_continuous_aggregate_policy(
  'daily_mrr',
  start_offset => INTERVAL '7 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes'
);
