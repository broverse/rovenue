-- 0014_drop_daily_mrr_cagg.sql
-- Plan 3 Phase C — drop the `daily_mrr` continuous aggregate.
--
-- Pre-req: Plan 3 Phase A + B shipped, no consumers remain
-- (`mrr-adapter.ts`, `metricsRepo.listDailyMrr`,
-- `subscriberDetail.listCreditLedgerBySubscriber` all deleted).
-- Pre-req: Plan 3 Phase 0 cutover gate passed in production.
--
-- Reverses the effect of 0005_cagg_daily_mrr.sql forward-only —
-- the legacy migration stays in `_journal.json` per the project's
-- forward-only convention (CLAUDE.md / Plan 2 inheritance).
--
-- The continuous aggregate's refresh policy is a TimescaleDB
-- background job and must be removed before the materialised view
-- can be dropped.

SELECT remove_continuous_aggregate_policy('daily_mrr', if_exists => true);

DROP MATERIALIZED VIEW IF EXISTS daily_mrr CASCADE;
