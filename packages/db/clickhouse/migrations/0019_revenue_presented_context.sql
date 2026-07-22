-- 0019_revenue_presented_context.sql
-- Precise paywall attribution for revenue: extract the purchase's
-- presentedContext (stamped into the outbox payload's `metadata` by
-- receipt-verify / the Stripe webhook) into first-class columns on
-- raw_revenue_events, so placement/paywall/variant conversion can be
-- counted directly instead of via the viewer-overlap proxy.
--
-- DEPLOY NOTE (live ClickHouse): this migration RECREATES
-- mv_revenue_to_raw. Dropping a Kafka-fed MV advances the consumer
-- offset without materializing — messages consumed in the gap are LOST
-- (see the 0015 incident). On a live deployment, pause the
-- rovenue-ch-revenue consumer (DETACH TABLE rovenue.revenue_queue)
-- before applying and re-attach after, or backfill the gap from
-- Postgres revenue_events. Fresh installs are unaffected.
--
-- Rows ingested before this migration carry '' in the new columns —
-- attribution is precise from this point forward.

ALTER TABLE rovenue.raw_revenue_events
  ADD COLUMN IF NOT EXISTS placementId   String DEFAULT '',
  ADD COLUMN IF NOT EXISTS paywallId     String DEFAULT '',
  ADD COLUMN IF NOT EXISTS variantId     String DEFAULT '',
  ADD COLUMN IF NOT EXISTS experimentKey String DEFAULT '';

DROP TABLE IF EXISTS rovenue.mv_revenue_to_raw;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_revenue_to_raw
TO rovenue.raw_revenue_events AS
SELECT
  eventId,
  JSONExtractString(payload, 'revenueEventId')                              AS revenueEventId,
  JSONExtractString(payload, 'projectId')                                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                                AS subscriberId,
  JSONExtractString(payload, 'purchaseId')                                  AS purchaseId,
  JSONExtractString(payload, 'productId')                                   AS productId,
  JSONExtractString(payload, 'type')                                        AS type,
  JSONExtractString(payload, 'store')                                       AS store,
  toDecimal128(JSONExtractString(payload, 'amount'),    4)                  AS amount,
  toDecimal128(JSONExtractString(payload, 'amountUsd'), 4)                  AS amountUsd,
  JSONExtractString(payload, 'currency')                                    AS currency,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'eventDate'), 3
  )                                                                         AS eventDate,
  JSONExtractString(payload, 'metadata', 'presentedContext', 'placementId') AS placementId,
  JSONExtractString(payload, 'metadata', 'presentedContext', 'paywallId')   AS paywallId,
  JSONExtractString(payload, 'metadata', 'presentedContext', 'variantId')   AS variantId,
  JSONExtractString(payload, 'metadata', 'presentedContext', 'experimentKey') AS experimentKey,
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.revenue_queue;
