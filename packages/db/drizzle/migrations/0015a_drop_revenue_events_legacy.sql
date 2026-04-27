-- 0015a_drop_revenue_events_legacy.sql
-- Plan 3 §D.2 — drop the renamed legacy hypertable AFTER copy-and-swap
-- verification has reported byte-for-byte row-count parity per partition.
--
-- This migration is GATED on the GUC `rovenue.plan3_legacy_drop_verified=1`,
-- which the migrator runner sets when started with the env var
-- PLAN3_LEGACY_DROP_VERIFIED=1. The deploy pipeline MUST NOT set the env
-- automatically — operator opt-in only.
--
-- If the GUC is not set, the migration RAISES, the transaction rolls back,
-- and Drizzle leaves it un-applied. Re-running `db:migrate` with the env
-- var present picks up where it left off.

DO $$
BEGIN
  IF coalesce(current_setting('rovenue.plan3_legacy_drop_verified', true), '0') <> '1' THEN
    RAISE EXCEPTION 'rovenue.plan3_legacy_drop_verified is not set. The legacy revenue_events_legacy_hypertable drop is gated; operator must run with PLAN3_LEGACY_DROP_VERIFIED=1 once row-count parity has been verified per partition. Aborting migration.';
  END IF;
END$$;--> statement-breakpoint

DROP TABLE IF EXISTS "revenue_events_legacy_hypertable";
