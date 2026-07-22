-- 0018_mv_paywall_daily.sql
-- Daily paywall-view rollup feeding placement/paywall/variant funnel
-- charts (paywall_view_rate, etc. — see metrics/chart-catalog.ts).
--
-- Engine choice: SummingMergeTree + AggregateFunction(uniq, String)
-- for the unique-subscriber count, matching mv_experiment_daily_target
-- (0003) exactly. This SummingMergeTree + AggregateFunction(uniq)
-- combination is the experimentally-verified-correct pattern in this
-- codebase for "summable counter + distinct count" rollups — do NOT
-- refactor to AggregatingMergeTree (see MEMORY:
-- clickhouse_summing_aggregatefunction).
--
-- variantId is nullable on raw_paywall_events (a placement can resolve
-- without an experiment), but ORDER BY columns in this codebase are
-- never Nullable — coalesce to '' for the dimension, matching how
-- other rollups avoid Nullable group keys.
--
-- Read path: `sum(views)` for the count, `uniqMerge(subscribersHll)`
-- for unique subscribers — same read pattern as mv_experiment_daily_target
-- (SummingMergeTree merges views across parts; the AggregateFunction
-- state column always needs *Merge() regardless of merge state).

CREATE TABLE IF NOT EXISTS rovenue.mv_paywall_daily_target
(
  projectId     String,
  placementId   String,
  paywallId     String,
  variantId     String,
  day           Date,
  views         UInt64,
  subscribersHll AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, placementId, paywallId, variantId, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_paywall_daily
TO rovenue.mv_paywall_daily_target AS
SELECT
  projectId,
  placementId,
  paywallId,
  coalesce(variantId, '')   AS variantId,
  toDate(occurredAt)        AS day,
  count()                   AS views,
  uniqState(subscriberId)   AS subscribersHll
FROM rovenue.raw_paywall_events
GROUP BY projectId, placementId, paywallId, variantId, day;
