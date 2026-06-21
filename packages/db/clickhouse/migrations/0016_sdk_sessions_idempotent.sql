-- 0016_sdk_sessions_idempotent.sql
--
-- Replace the SummingMergeTree daily rollup (sdk_sessions_daily_tbl +
-- sdk_sessions_daily MV) with a query-time idempotent VIEW that deduplicates
-- replayed events BEFORE summation, matching the pattern established by
-- 0012_idempotent_revenue_aggregates.sql for revenue and credit events.
--
-- Why the rollup double-counts
-- ----------------------------
-- The outbox dispatcher is at-least-once. A crash-replay can re-deliver the
-- same eventId to the rovenue.sdk-sessions Kafka topic. The Kafka->raw
-- ingestion MV (mv_sdk_sessions_to_raw) writes the duplicate into
-- raw_sdk_session_events; ReplacingMergeTree(_version) deduplicates that
-- asynchronously, but the SummingMergeTree target (sdk_sessions_daily_tbl)
-- may have already summed both the original and the duplicate row before the
-- background merge collapses them, leaving an inflated session_ms /
-- session_count permanently in the rollup.
--
-- Fix: query-time dedup via FINAL on raw_sdk_session_events
-- ----------------------------------------------------------
-- raw_sdk_session_events is ReplacingMergeTree(_version) ordered by
-- (projectId, subscriberId, occurredAt, eventId) — the same dedup key used
-- by the raw revenue and credit tables. Querying with FINAL collapses
-- duplicate eventIds deterministically before any aggregation, so a replayed
-- event is never double-counted at read time.
--
-- The Kafka->raw ingestion MV (mv_sdk_sessions_to_raw) is left UNTOUCHED.
-- Only the SummingMergeTree rollup is dropped. DO NOT drop mv_sdk_sessions_to_raw:
-- doing so loses any Kafka messages consumed between DROP and CREATE (offset
-- advances with no MV to receive them). If that MV ever needs recreation on a
-- live system, pause the rovenue-ch-sdk-sessions consumer group first and
-- backfill from Postgres before resuming (see MEMORY: clickhouse_mv_recreate_kafka_gap).
--
-- Caller migration
-- ----------------
-- Callers that read sdk_sessions_daily_tbl must switch to v_sdk_sessions_daily.
-- The two queries reading that table are:
--   apps/api/src/services/metrics/engagement.ts  (sum per day, date-range)
--   apps/api/src/services/refund-shield/aggregate-signals.ts  (lifetime sum per subscriber)
-- Both are updated in this PR (see companion TypeScript changes).

-- Drop the SummingMergeTree rollup (MV first, then its target table).
-- mv_sdk_sessions_to_raw (the Kafka ingestion MV) is intentionally NOT dropped.
DROP VIEW IF EXISTS rovenue.sdk_sessions_daily;
DROP TABLE IF EXISTS rovenue.sdk_sessions_daily_tbl;

-- Query-time idempotent session daily view.
-- FINAL on raw_sdk_session_events collapses duplicate eventIds (same replay
-- semantics as v_mrr_daily / v_credit_consumption_daily in 0012).
-- We only aggregate 'background' and 'close' events (finalised durations);
-- 'start' and 'heartbeat' carry partial/zero durations and are excluded
-- for the same reasons documented in 0010.
CREATE VIEW IF NOT EXISTS rovenue.v_sdk_sessions_daily AS
SELECT
  projectId,
  subscriberId,
  toDate(occurredAt)       AS day,
  sum(toUInt64(durationMs)) AS session_ms,
  count()                  AS session_count
FROM rovenue.raw_sdk_session_events FINAL
WHERE eventType IN ('background', 'close')
GROUP BY projectId, subscriberId, day;

-- Per-subscriber lifetime session view — Refund Shield hot path.
-- Mirrors v_revenue_lifetime_subscriber (0012): deduplicates via
-- GROUP BY eventId so a replayed event is counted exactly once regardless
-- of ReplacingMergeTree merge timing, then outer-aggregates to get
-- per-subscriber totals. Business fields for a given eventId are immutable
-- (Postgres is the write-authoritative store), so any() over the deduped
-- rows is safe.
CREATE VIEW IF NOT EXISTS rovenue.v_sdk_sessions_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sum(dur_ms)   AS lifetime_session_ms,
  sum(sessions) AS lifetime_session_count
FROM
(
  SELECT
    eventId,
    any(projectId)                    AS projectId,
    any(subscriberId)                 AS subscriberId,
    any(toUInt64(durationMs))         AS dur_ms,
    1                                 AS sessions
  FROM rovenue.raw_sdk_session_events
  WHERE eventType IN ('background', 'close')
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;
