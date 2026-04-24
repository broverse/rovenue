-- 0004_revenue_kafka_engine.sql
-- Kafka Engine ingestion for the rovenue.revenue topic.
-- Pipeline mirrors 0002 exactly, swapping payload shape:
--   rovenue.revenue (Redpanda)
--     -> rovenue.revenue_queue      (Kafka Engine table)
--     -> mv_revenue_to_raw          (materialized view)
--     -> rovenue.raw_revenue_events (ReplacingMergeTree target)
--
-- _version = toUnixTimestamp64Milli(now64(3, 'UTC')) stamped at ingest
-- so that replayed rows with a newer ingestedAt win the dedup race;
-- business fields (amountUsd, etc.) for the same revenueEventId never
-- drift because revenue_events is append-only in Postgres.

CREATE TABLE IF NOT EXISTS rovenue.revenue_queue
(
  eventId     String,
  aggregateId String,
  eventType   String,
  payload     String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list          = 'redpanda:9092',
  kafka_topic_list           = 'rovenue.revenue',
  kafka_group_name           = 'rovenue-ch-revenue',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_skip_broken_messages = 10;

CREATE TABLE IF NOT EXISTS rovenue.raw_revenue_events
(
  eventId        String,
  revenueEventId String,
  projectId      String,
  subscriberId   String,
  purchaseId     String,
  productId      String,
  type           LowCardinality(String),
  store          LowCardinality(String),
  amount         Decimal(12, 4),
  amountUsd      Decimal(12, 4),
  currency       LowCardinality(String),
  eventDate      DateTime64(3, 'UTC'),
  ingestedAt     DateTime64(3, 'UTC'),
  _version       UInt64
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (projectId, eventDate, eventId)
PARTITION BY toYYYYMM(eventDate)
-- 2y hot TTL; Postgres/Timescale holds the 7y authoritative record (see ADR B.0)
TTL toDateTime(eventDate) + INTERVAL 2 YEAR DELETE;

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
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.revenue_queue;
