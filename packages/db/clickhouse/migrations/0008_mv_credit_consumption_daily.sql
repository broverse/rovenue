-- 0008_mv_credit_consumption_daily.sql
-- Daily per-project credit flow (granted vs debited, event count,
-- unique-subscriber HLL). SummingMergeTree for O(1) rollup reads;
-- pair with uniqMerge(subscribersHll) for distinct-subscriber queries.

CREATE TABLE IF NOT EXISTS rovenue.mv_credit_consumption_daily_target
(
  projectId        String,
  day              Date,
  granted_credits  Int64,
  debited_credits  Int64,
  net_flow         Int64,
  event_count      UInt64,
  subscribersHll   AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_consumption_daily
TO rovenue.mv_credit_consumption_daily_target AS
SELECT
  projectId,
  toDate(createdAt)                                    AS day,
  sumIf(amount, amount > 0)                            AS granted_credits,
  sumIf(-amount, amount < 0)                           AS debited_credits,
  sum(amount)                                          AS net_flow,
  count()                                              AS event_count,
  uniqState(subscriberId)                              AS subscribersHll
FROM rovenue.raw_credit_ledger
GROUP BY projectId, day;
