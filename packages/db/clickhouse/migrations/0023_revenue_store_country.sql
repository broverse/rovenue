-- 0023_revenue_store_country.sql
-- Revenue country, sourced from the STORE's own per-transaction value,
-- never the subscriber's last-known SDK-reported country (a different,
-- optional, drift-prone fact — see
-- docs/superpowers/specs/2026-09-01-analytics-integrity-and-proceeds-design.md
-- §4.2). Apple's decoded JWS transaction already carries `storefront`
-- (apple-types.ts) — a per-transaction fact from Apple itself, threaded
-- through receipt-verify.ts / apple-webhook.ts's revenue-event call sites
-- as a top-level `country` field on the co-located outbox payload
-- (alongside `store`/`currency`), same as every other revenue dimension —
-- never written to ClickHouse directly. Google and Stripe country are
-- explicitly out of scope here (a later task's job).
--
-- DEPLOY NOTE (live ClickHouse): this migration RECREATES
-- mv_revenue_to_raw, same as 0019/0020. Dropping a Kafka-fed MV advances
-- the consumer offset without materializing — messages consumed in the
-- gap are LOST (see the 0015 incident). On a live deployment, pause the
-- rovenue-ch-revenue consumer (DETACH TABLE rovenue.revenue_queue)
-- before applying and re-attach after, or backfill the gap from Postgres
-- revenue_events. Fresh installs are unaffected.
--
-- Why 0021's "dropping the queue table is safe" finding does NOT change
-- that guidance here: it's safe to drop+recreate revenue_queue itself
-- because its offset is committed broker-side under kafka_group_name, so
-- recreating the SAME table resumes cleanly with nothing lost. But that
-- doesn't help sequence around THIS migration's problem — `CREATE
-- MATERIALIZED VIEW ... FROM revenue_queue` needs revenue_queue to exist
-- and be resolvable at creation time, so it can't be dropped first
-- without leaving nothing for the new MV to select from, and for as long
-- as it exists and is attached it is actively consuming into whatever MV
-- (old or none) is currently attached. There is no ordering of
-- drop/create statements alone that closes the gap; only pausing
-- consumption externally (DETACH) around the apply does, which is what
-- the note above instructs.
--
-- Rows ingested before this migration carry '' in `country` — attribution
-- is precise (Apple-sourced) from this point forward.

ALTER TABLE rovenue.raw_revenue_events
  ADD COLUMN IF NOT EXISTS country String DEFAULT '';

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
  JSONExtractString(payload, 'country')                                    AS country,
  now64(3, 'UTC')                                                          AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                  AS _version
FROM rovenue.revenue_queue;
