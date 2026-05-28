-- 0009_sdk_session_events_kafka.sql
-- Kafka Engine ingestion for the rovenue.sdk-sessions topic.
-- Backs Refund Shield's "objective engagement" signal: every SDK
-- session start/heartbeat/end is produced by the backend after a
-- POST /v1/sdk/sessions ingest, then consumed here. T5 layers a
-- SummingMergeTree daily rollup on top.
--
-- Pipeline mirrors 0002 / 0004 / 0005:
--   rovenue.sdk-sessions (Redpanda)
--     -> rovenue.sdk_session_events_queue (Kafka Engine table)
--     -> mv_sdk_sessions_to_raw           (materialized view)
--     -> rovenue.raw_sdk_session_events   (ReplacingMergeTree target)
--
-- Note on ID types: project_id / subscriber_id are stored as `String`
-- (not `UUID`) because Postgres uses cuid2 text IDs for these
-- columns. The Refund Shield plan originally suggested `UUID`, but
-- a 16-byte UUID can't round-trip a cuid2 — keeping `String` matches
-- the producer payloads and the rest of the rovenue.* schema
-- (see raw_credit_ledger, raw_exposures).
--
-- _version = toUnixTimestamp64Milli(now64(3, 'UTC')) stamped at ingest
-- so replayed rows with a newer ingestedAt win the dedup race.

CREATE TABLE IF NOT EXISTS rovenue.sdk_session_events_queue
(
  eventId     String,
  aggregateId String,
  eventType   String,
  payload     String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list          = 'redpanda:9092',
  kafka_topic_list           = 'rovenue.sdk-sessions',
  kafka_group_name           = 'rovenue-ch-sdk-sessions',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_skip_broken_messages = 10;

CREATE TABLE IF NOT EXISTS rovenue.raw_sdk_session_events
(
  eventId      String,
  projectId    String,
  subscriberId String,
  eventType    LowCardinality(String),
  occurredAt   DateTime64(3, 'UTC'),
  durationMs   UInt32,
  appVersion   LowCardinality(String),
  sdkVersion   LowCardinality(String),
  ingestedAt   DateTime64(3, 'UTC'),
  _version     UInt64
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (projectId, subscriberId, occurredAt, eventId)
PARTITION BY toYYYYMM(occurredAt)
-- 2y hot TTL; Postgres holds no authoritative copy here, but 2y is
-- enough for Refund Shield's lifetime-engagement signal (Apple's
-- consumption window is 12h after CONSUMPTION_REQUEST).
TTL toDateTime(occurredAt) + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_sdk_sessions_to_raw
TO rovenue.raw_sdk_session_events AS
SELECT
  eventId,
  JSONExtractString(payload, 'projectId')                                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                                AS subscriberId,
  JSONExtractString(payload, 'eventType')                                   AS eventType,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'occurredAt'), 3
  )                                                                         AS occurredAt,
  toUInt32(JSONExtractInt(payload, 'durationMs'))                           AS durationMs,
  JSONExtractString(payload, 'appVersion')                                  AS appVersion,
  JSONExtractString(payload, 'sdkVersion')                                  AS sdkVersion,
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.sdk_session_events_queue;
