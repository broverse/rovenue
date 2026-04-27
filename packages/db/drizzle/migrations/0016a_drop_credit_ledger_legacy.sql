-- 0016a_drop_credit_ledger_legacy.sql
-- Plan 3 §D.3 — drop the renamed legacy hypertable AFTER per-partition
-- row-count parity has been verified by migrate-hypertable-to-partitioned.ts.
-- Gated on PLAN3_LEGACY_DROP_VERIFIED=1 (see 0015a for the full contract).

DO $$
BEGIN
  IF coalesce(current_setting('rovenue.plan3_legacy_drop_verified', true), '0') <> '1' THEN
    RAISE EXCEPTION 'rovenue.plan3_legacy_drop_verified is not set. The legacy credit_ledger_legacy_hypertable drop is gated; operator must run with PLAN3_LEGACY_DROP_VERIFIED=1 once row-count parity has been verified per partition. Aborting migration.';
  END IF;
END$$;--> statement-breakpoint

DROP TABLE IF EXISTS "credit_ledger_legacy_hypertable";
