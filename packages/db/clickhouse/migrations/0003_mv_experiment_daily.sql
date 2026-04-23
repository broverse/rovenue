CREATE TABLE IF NOT EXISTS rovenue.mv_experiment_daily_target
(
  projectId       String,
  experimentId    String,
  variantId       String,
  platform        LowCardinality(String),
  day             Date,
  exposures       UInt64,
  subscribersHll  AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, experimentId, variantId, platform, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_experiment_daily
TO rovenue.mv_experiment_daily_target AS
SELECT
  projectId,
  experimentId,
  variantId,
  platform,
  toDate(exposedAt)      AS day,
  count()                AS exposures,
  uniqState(subscriberId) AS subscribersHll
FROM rovenue.raw_exposures
GROUP BY projectId, experimentId, variantId, platform, day;
