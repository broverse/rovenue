-- 0025_mcp_access_log.sql
-- Kafka Engine ingestion for the rovenue.mcp_access topic.
-- Pipeline mirrors 0017 (paywall_events):
--   rovenue.mcp_access (Redpanda)
--     -> rovenue.mcp_access_queue      (Kafka Engine table)
--     -> mv_mcp_access_to_raw          (materialized view)
--     -> rovenue.raw_mcp_access        (ReplacingMergeTree target)
--
-- Produced by every MCP tool call via the transactional outbox
-- (aggregateType MCP_ACCESS, eventType mcp.tool_called — see
-- apps/api/src/services/mcp/access-log.ts). The dispatcher needs no
-- per-type branch: the generic toOutboxKafkaMessage envelope
-- (eventId, eventType, aggregateId, createdAt, payload) is what lands
-- here, keyed by tokenId for partition stability.
--
-- Privacy is structural: the payload carries an argsDigest (sha256 over
-- canonicalized arguments), never argument values, so no PII can arrive
-- no matter what a future tool accepts.
--
-- eventId is the outbox row id (stable across dispatcher crash-replay —
-- the same row re-claimed publishes the same id). ReplacingMergeTree on
-- raw_mcp_access collapses that replay case.

CREATE TABLE IF NOT EXISTS rovenue.mcp_access_queue
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
  kafka_topic_list           = 'rovenue.mcp_access',
  kafka_group_name           = 'rovenue-ch-mcp-access',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_skip_broken_messages = 100,
  kafka_flush_interval_ms    = 2000;

CREATE TABLE IF NOT EXISTS rovenue.raw_mcp_access
(
  eventId    String,
  projectId  String,
  tokenId    String,
  userId     String,
  toolName   String,
  scope      String,
  argsDigest String,
  ok         UInt8,
  occurredAt DateTime64(3, 'UTC'),
  insertedAt DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(insertedAt)
ORDER BY (projectId, occurredAt, eventId)
PARTITION BY toYYYYMM(occurredAt)
TTL toDateTime(occurredAt) + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_mcp_access_to_raw
TO rovenue.raw_mcp_access AS
SELECT
  eventId                                         AS eventId,
  JSONExtractString(payload, 'projectId')         AS projectId,
  JSONExtractString(payload, 'tokenId')           AS tokenId,
  JSONExtractString(payload, 'userId')            AS userId,
  JSONExtractString(payload, 'toolName')          AS toolName,
  JSONExtractString(payload, 'scope')             AS scope,
  JSONExtractString(payload, 'argsDigest')        AS argsDigest,
  JSONExtractBool(payload, 'ok')                  AS ok,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'occurredAt'), 3
  )                                                AS occurredAt,
  now64(3, 'UTC')                                  AS insertedAt
FROM rovenue.mcp_access_queue;
