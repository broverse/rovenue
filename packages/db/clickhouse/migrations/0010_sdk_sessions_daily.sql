-- 0010_sdk_sessions_daily.sql
--
-- Per-subscriber daily SDK-session rollup feeding Refund Shield's
-- "objective engagement" signal. Pairs with raw_sdk_session_events
-- (0009) so the Apple consumption-request worker can ask
-- "how many ms / sessions did this subscriber accumulate?" in O(1)
-- merged-row reads instead of scanning the raw fact table.
--
-- Filter rationale: we sum durationMs and count sessions only on
-- 'background' / 'close' events, which is when the SDK flushes a
-- finalised duration. 'start' / 'heartbeat' events carry partial
-- or zero durations and would double-count if rolled up here.
--
-- Engine choice: SummingMergeTree with plain UInt64 sums.
-- Matches the precedent in 0006_mv_mrr_daily.sql and
-- 0008_mv_credit_consumption_daily.sql: this codebase uses
-- SummingMergeTree for naturally-summable counters and only
-- reaches for AggregateFunction(...) state when distinct-counting
-- (uniqState) is required. Sessions don't need HLL today, so
-- plain summed columns keep merges cheap and reads trivial
-- (no *Merge() needed on the read path).
--
-- ORDER BY (projectId, subscriberId, day) so the consumption
-- worker's per-subscriber lookup hits the primary index directly.
-- TTL mirrors raw_sdk_session_events: 2 years is plenty for
-- Apple's 12h consumption window and any lifetime-engagement
-- signal Refund Shield needs.
--
-- Uses line-comment ("--") headers like every other CH migration:
-- the runner's statement splitter strips leading "--" lines before
-- a chunk's DDL keyword check (fixed in b36d8c6), so a leading
-- comment block no longer swallows the first statement.

CREATE TABLE IF NOT EXISTS rovenue.sdk_sessions_daily_tbl
(
  projectId      String,
  subscriberId   String,
  day            Date,
  session_ms     UInt64,
  session_count  UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (projectId, subscriberId, day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.sdk_sessions_daily
TO rovenue.sdk_sessions_daily_tbl AS
SELECT
  projectId,
  subscriberId,
  toDate(occurredAt)        AS day,
  sum(toUInt64(durationMs)) AS session_ms,
  count()                   AS session_count
FROM rovenue.raw_sdk_session_events
WHERE eventType IN ('background', 'close')
GROUP BY projectId, subscriberId, day;
