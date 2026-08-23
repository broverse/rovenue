-- 0022_drop_experiment_daily_mv.sql
-- Drop the unread experiment daily rollup (0003): mv_experiment_daily +
-- mv_experiment_daily_target are referenced by NOTHING in apps/api —
-- the experiment results query (analytics-router.ts) reads
-- uniqExact(eventId) over raw_exposures directly (query-time idempotent,
-- the 0012/0016 pattern), so the SummingMergeTree rollup only wastes
-- insert work and, being insert-counted, would inflate on outbox replays
-- anyway.
--
-- Safety: BOTH of these MVs read from a raw MergeTree table
-- (raw_exposures), NOT from a Kafka Engine queue table, so dropping
-- them has NO consumer-offset gap — the 0015 gotcha (dropping a
-- Kafka-fed MV advances the consumer offset without materializing)
-- does not apply here. The Kafka->raw ingestion MV
-- (mv_exposures_to_raw) is intentionally NOT touched.
--
-- The paywall rollup (0018 mv_paywall_daily -> mv_paywall_daily_target)
-- is intentionally KEPT: charts.ts and analytics-router.ts still read
-- its uniqMerge(subscribersHll) HLL state (replay-safe). Only the
-- inflating sum(views) READ moved to a query-time uniqExact over
-- raw_paywall_events (companion TypeScript change in
-- apps/api/src/services/analytics-router.ts).

-- MV first, then its target table (0012 drop ordering).
DROP TABLE IF EXISTS rovenue.mv_experiment_daily;

DROP TABLE IF EXISTS rovenue.mv_experiment_daily_target;
