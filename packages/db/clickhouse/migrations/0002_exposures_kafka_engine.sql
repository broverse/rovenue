CREATE TABLE IF NOT EXISTS rovenue.exposures_queue
(
  eventId      String,
  eventType    String,
  aggregateId  String,
  createdAt    String,
  payload      String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'redpanda:9092',
  kafka_topic_list = 'rovenue.exposures',
  kafka_group_name = 'rovenue-ch-exposures',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_max_block_size = 1048576,
  kafka_skip_broken_messages = 100;

CREATE TABLE IF NOT EXISTS rovenue.raw_exposures
(
  eventId        String,
  experimentId   String,
  variantId      String,
  projectId      String,
  subscriberId   String,
  platform       LowCardinality(String),
  country        LowCardinality(String),
  exposedAt      DateTime64(3, 'UTC'),
  insertedAt     DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(insertedAt)
ORDER BY (projectId, experimentId, exposedAt, eventId)
PARTITION BY toYYYYMM(exposedAt)
TTL toDateTime(exposedAt) + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_exposures_to_raw
TO rovenue.raw_exposures AS
SELECT
  eventId                                                   AS eventId,
  JSONExtractString(payload, 'experimentId')                AS experimentId,
  JSONExtractString(payload, 'variantId')                   AS variantId,
  JSONExtractString(payload, 'projectId')                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                AS subscriberId,
  JSONExtractString(payload, 'platform')                    AS platform,
  JSONExtractString(payload, 'country')                     AS country,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'exposedAt'), 3
  )                                                         AS exposedAt,
  now64(3, 'UTC')                                           AS insertedAt
FROM rovenue.exposures_queue;
