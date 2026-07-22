-- 0020_paywall_event_kind.sql
-- Distinguishes paywall_view from paywall_close within the same
-- raw_paywall_events / mv_paywall_daily pipeline (0017/0018). The
-- server now routes ALL `paywall_*` events (view + close) into the
-- rovenue.paywall_events topic (see events.ts's deriveAggregateType
-- and outbox-dispatcher.ts's shapePaywallEventMessage), which
-- previously flattened every row as an (implicit) view — close rows
-- would have silently inflated paywall_view counts.
--
-- `kind` is derived by the dispatcher from the outbox row's eventType
-- (`paywall_view` -> "view", `paywall_close` -> "close"; an
-- unrecognized `paywall_*` suffix passes through as-is) and now rides
-- inside the shaped Kafka message's payload, alongside the existing
-- flat fields. kind ALSO joins paywallEventId()'s hash input, so a
-- view and a close sharing the same client eventId get distinct
-- eventIds instead of colliding under raw_paywall_events'
-- ReplacingMergeTree. One-time cost: an old-format message already
-- in flight in Kafka at deploy time (produced pre-deploy, so lacking
-- `kind`) computes a different eventId than an equivalent post-deploy
-- message would — an in-flight dispatcher-level retry landing exactly
-- across that window could double-count once. Accepted per spec (D4).
--
-- DEPLOY NOTE (live ClickHouse): this migration RECREATES both
-- mv_paywall_events_to_raw (the direct Kafka-Engine-fed MV) and
-- mv_paywall_daily (chained off raw_paywall_events). Dropping a
-- Kafka-fed MV advances the consumer offset without materializing —
-- messages consumed in the gap are LOST (see the 0015 incident). For
-- mv_paywall_daily, the DROP+CREATE gap instead means any row that
-- lands in raw_paywall_events while it's absent never gets rolled up
-- (silently under-counted, not lost at the raw-table level). On a
-- live deployment, pause the rovenue-ch-paywall-events consumer
-- (DETACH TABLE rovenue.paywall_events_queue) before applying and
-- re-attach after, or backfill the gap by replaying the affected
-- outbox_events rows. Fresh installs are unaffected.
--
-- Rows ingested before this migration default to kind = 'view' (the
-- only kind that existed pre-close-event-ingestion) via the column
-- DEFAULT and the extraction's own fallback below.

ALTER TABLE rovenue.raw_paywall_events
  ADD COLUMN IF NOT EXISTS kind LowCardinality(String) DEFAULT 'view';

DROP TABLE IF EXISTS rovenue.mv_paywall_events_to_raw;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_paywall_events_to_raw
TO rovenue.raw_paywall_events AS
SELECT
  eventId                                                      AS eventId,
  JSONExtractString(payload, 'projectId')                      AS projectId,
  JSONExtractString(payload, 'subscriberId')                   AS subscriberId,
  JSONExtractString(payload, 'paywallId')                      AS paywallId,
  JSONExtractString(payload, 'placementId')                    AS placementId,
  JSONExtractInt(payload, 'placementRevision')                 AS placementRevision,
  nullIf(JSONExtractString(payload, 'variantId'), '')          AS variantId,
  nullIf(JSONExtractString(payload, 'experimentKey'), '')      AS experimentKey,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'occurredAt'), 3
  )                                                             AS occurredAt,
  now64(3, 'UTC')                                               AS insertedAt,
  coalesce(nullIf(JSONExtractString(payload, 'kind'), ''), 'view') AS kind
FROM rovenue.paywall_events_queue;

DROP TABLE IF EXISTS rovenue.mv_paywall_daily;

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
WHERE kind = 'view'
GROUP BY projectId, placementId, paywallId, variantId, day;
