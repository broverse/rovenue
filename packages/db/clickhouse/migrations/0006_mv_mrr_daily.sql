-- 0006_mv_mrr_daily.sql
-- Daily MRR rollup consumed by the dashboard metrics endpoint
-- in dual-read mode (Phase D). Schema superset of the Timescale
-- daily_mrr cagg: gross_usd + event_count + active_subscribers
-- are the compare-me columns; refunds_usd + net_usd are extra.
--
-- Active-subscriber count uses uniq-state so re-reads across the
-- retention horizon can re-aggregate without double-counting a
-- single subscriber who purchased on the same day twice.

CREATE TABLE IF NOT EXISTS rovenue.mv_mrr_daily_target
(
  projectId          String,
  day                Date,
  gross_usd          Decimal(18, 4),
  refunds_usd        Decimal(18, 4),
  net_usd            Decimal(18, 4),
  event_count        UInt64,
  subscribersHll     AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_mrr_daily
TO rovenue.mv_mrr_daily_target AS
SELECT
  projectId,
  toDate(eventDate) AS day,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))      AS gross_usd,
  sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))           AS refunds_usd,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))
    - sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))       AS net_usd,
  count()                                                      AS event_count,
  uniqState(subscriberId)                                      AS subscribersHll
FROM rovenue.raw_revenue_events
GROUP BY projectId, day;
