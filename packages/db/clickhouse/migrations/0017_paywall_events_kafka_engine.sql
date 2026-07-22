-- 0017_paywall_events_kafka_engine.sql
-- Kafka Engine ingestion for the rovenue.paywall_events topic.
-- Pipeline mirrors 0002 (exposures) / 0004 (revenue) / 0005 (credit):
--   rovenue.paywall_events (Redpanda)
--     -> rovenue.paywall_events_queue     (Kafka Engine table)
--     -> mv_paywall_events_to_raw         (materialized view)
--     -> rovenue.raw_paywall_events       (ReplacingMergeTree target)
--
-- Produced by POST /v1/events (`paywall_view`) via the transactional
-- outbox (aggregateType PAYWALL_EVENT); apps/api/src/workers/
-- outbox-dispatcher.ts reshapes the raw client envelope into a flat
-- payload (projectId, subscriberId, paywallId, placementId,
-- placementRevision, variantId, experimentKey, occurredAt) before
-- publishing — same convention as publishExposure()'s payload in
-- services/event-bus.ts.
--
-- eventId is a content-derived sha256 of
-- `projectId:subscriberId:paywallId:placementId:clientEventId`
-- (see paywallEventId() in outbox-dispatcher.ts), NOT the outbox
-- row's own id. That makes it stable across BOTH a dispatcher-level
-- crash-replay (same outbox row re-claimed) AND an SDK-level retry
-- (a lost 202 makes the SDK re-POST, producing a second, distinct
-- outbox row for the same logical paywall view) — mirroring
-- sessionEventId() in routes/v1/sdk-sessions.ts. ReplacingMergeTree
-- on raw_paywall_events collapses either replay case.

CREATE TABLE IF NOT EXISTS rovenue.paywall_events_queue
(
  eventId     String,
  eventType   String,
  aggregateId String,
  createdAt   String,
  payload     String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list          = 'redpanda:9092',
  kafka_topic_list           = 'rovenue.paywall_events',
  kafka_group_name           = 'rovenue-ch-paywall-events',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_skip_broken_messages = 100;

CREATE TABLE IF NOT EXISTS rovenue.raw_paywall_events
(
  eventId           String,
  projectId         String,
  subscriberId      String,
  paywallId         String,
  placementId       String,
  placementRevision Int64,
  variantId         Nullable(String),
  experimentKey     Nullable(String),
  occurredAt        DateTime64(3, 'UTC'),
  insertedAt        DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(insertedAt)
ORDER BY (projectId, placementId, occurredAt, eventId)
PARTITION BY toYYYYMM(occurredAt)
TTL toDateTime(occurredAt) + INTERVAL 2 YEAR DELETE;

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
  now64(3, 'UTC')                                               AS insertedAt
FROM rovenue.paywall_events_queue;
