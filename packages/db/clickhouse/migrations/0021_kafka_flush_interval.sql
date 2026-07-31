-- 0021_kafka_flush_interval.sql
--
-- Bound ingestion latency by giving every Kafka engine table an explicit
-- `kafka_flush_interval_ms` instead of inheriting the server default.
--
-- The problem
-- -----------
-- None of the five queue tables set it, so each fell back to
-- `stream_flush_interval_ms`, whose default is 7500ms. That interval is the
-- dominant term in end-to-end freshness: a row is invisible to queries until
-- the consumer flushes, and the read path downstream is now query-time views
-- (0012 / 0016) that add no lag of their own. Measured p95 from
-- producer.send() to endpoint visibility was 6.06s against a 5s budget —
-- reproducible across runs, and unreachable by definition while a 7.5s timer
-- gates the pipeline.
--
-- The value
-- ---------
-- 2000ms. The flush fires on whichever bound is hit first — the interval, or
-- `kafka_max_block_size` (kept at 1048576). So the two settings cover
-- opposite regimes: under load the block bound wins and batches stay large,
-- and when traffic is sparse the interval bound caps how long a row can sit
-- invisible. That asymmetry is the point — lowering the interval costs
-- nothing at high volume.
--
-- The cost is part creation when traffic is continuous but thin: at most one
-- part per table per 2s, against one per 7.5s before. That stays well inside
-- ClickHouse's guidance of keeping inserts under roughly one per second per
-- table, and leaves ~2x headroom under the 5s budget. Going lower (500ms,
-- 1000ms) buys latency nobody has asked for and multiplies parts, which the
-- background merges then have to absorb.
--
-- Why this recreates the tables
-- -----------------------------
-- Kafka engine tables reject `ALTER TABLE ... MODIFY SETTING` ("table engine
-- doesn't support settings changes", verified on 24.3), so the setting can
-- only be applied by recreating the table.
--
-- DROPPING THE QUEUE TABLE IS SAFE. DROPPING ITS MATERIALIZED VIEW IS NOT.
-- The distinction matters and is the opposite of what it looks like:
--
--   * Dropping the queue table removes the consumer, so consumption stops
--     dead. Offsets are committed broker-side under `kafka_group_name`, so
--     recreating the table with the SAME group name resumes exactly where it
--     left off. Nothing is lost; delivery is merely delayed by the length of
--     the gap.
--   * Dropping `mv_*_to_raw` instead leaves the consumer running with nowhere
--     to write. The offset keeps advancing and every message consumed during
--     the gap is gone for good. 0016 carries the same warning.
--
-- So the materialized views are left untouched here. They survive their
-- source being dropped, and the dependency is re-established by name when the
-- table comes back — verified on a live instance before writing this.
--
-- Any NEW Kafka engine table must declare this setting too;
-- packages/db/tests/clickhouse-migrations.test.ts fails the build otherwise.

DROP TABLE IF EXISTS rovenue.revenue_queue;

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
  kafka_flush_interval_ms    = 2000,
  kafka_skip_broken_messages = 10;

DROP TABLE IF EXISTS rovenue.credit_queue;

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
  kafka_flush_interval_ms    = 2000,
  kafka_skip_broken_messages = 10;

DROP TABLE IF EXISTS rovenue.sdk_session_events_queue;

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
  kafka_flush_interval_ms    = 2000,
  kafka_skip_broken_messages = 10;

DROP TABLE IF EXISTS rovenue.exposures_queue;

CREATE TABLE IF NOT EXISTS rovenue.exposures_queue
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
  kafka_topic_list           = 'rovenue.exposures',
  kafka_group_name           = 'rovenue-ch-exposures',
  kafka_format               = 'JSONEachRow',
  kafka_num_consumers        = 1,
  kafka_max_block_size       = 1048576,
  kafka_flush_interval_ms    = 2000,
  kafka_skip_broken_messages = 100;

DROP TABLE IF EXISTS rovenue.paywall_events_queue;

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
  kafka_flush_interval_ms    = 2000,
  kafka_skip_broken_messages = 100;
