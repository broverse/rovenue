-- 0005_credit_kafka_engine.sql
-- Kafka Engine ingestion for the rovenue.credit topic.
-- Pipeline mirrors 0004 exactly, swapping payload shape:
--   rovenue.credit (Redpanda)
--     -> rovenue.credit_queue      (Kafka Engine table)
--     -> mv_credit_to_raw          (materialized view)
--     -> rovenue.raw_credit_ledger (ReplacingMergeTree target)
--
-- credit_ledger has signed integer amount and a running balance column
-- that is the POST-mutation balance. We preserve `balance` here so
-- downstream aggregates can pick the latest row per subscriber and trust
-- it as the current state (no SUM needed, matches Postgres invariant-by-construction).
--
-- _version = toUnixTimestamp64Milli(now64(3, 'UTC')) stamped at ingest
-- so that replayed rows with a newer ingestedAt win the dedup race;
-- business fields (amount, balance, etc.) for the same creditLedgerId never
-- drift because credit_ledger is append-only in Postgres.

CREATE TABLE IF NOT EXISTS rovenue.credit_queue
(
  eventId     String,
  aggregateId String,
  eventType   String,
  payload     String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list          = 'redpanda:9092',
  kafka_topic_list           = 'rovenue.credit',
  kafka_group_name           = 'rovenue-ch-credit',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_skip_broken_messages = 10;

CREATE TABLE IF NOT EXISTS rovenue.raw_credit_ledger
(
  eventId        String,
  creditLedgerId String,
  projectId      String,
  subscriberId   String,
  type           LowCardinality(String),
  amount         Int64,
  balance        Int64,
  referenceType  Nullable(String),
  referenceId    Nullable(String),
  createdAt      DateTime64(3, 'UTC'),
  ingestedAt     DateTime64(3, 'UTC'),
  _version       UInt64
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (projectId, createdAt, eventId)
PARTITION BY toYYYYMM(createdAt)
-- 2y hot TTL; Postgres/Timescale holds the 7y authoritative record (see ADR B.0)
TTL toDateTime(createdAt) + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_to_raw
TO rovenue.raw_credit_ledger AS
SELECT
  eventId,
  JSONExtractString(payload, 'creditLedgerId')                              AS creditLedgerId,
  JSONExtractString(payload, 'projectId')                                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                                AS subscriberId,
  JSONExtractString(payload, 'type')                                        AS type,
  toInt64OrZero(JSONExtractString(payload, 'amount'))                       AS amount,
  toInt64OrZero(JSONExtractString(payload, 'balance'))                      AS balance,
  JSONExtractString(payload, 'referenceType')                               AS referenceType,
  JSONExtractString(payload, 'referenceId')                                 AS referenceId,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'createdAt'), 3
  )                                                                         AS createdAt,
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.credit_queue;
