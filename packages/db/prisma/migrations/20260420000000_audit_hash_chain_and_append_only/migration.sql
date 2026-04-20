-- ============================================================
-- Audit log hash chain + append-only enforcement
-- ============================================================
--
-- Part 1: add prevHash/rowHash columns to audit_logs so the
--   application writer can build a tamper-evident chain. Both are
--   nullable at the DB level because rows predating this migration
--   have no chain state; new rows are required to populate them
--   (enforced in apps/api/src/lib/audit.ts).
--
-- Part 2: install DB-level triggers that reject UPDATE against
--   audit_logs and credit_ledger. UPDATE is the only mutation
--   that can silently rewrite history — a compromised app account
--   with INSERT+UPDATE could overwrite prevHash/rowHash pairs in
--   place and forge the chain. Blocking it at the DB level means
--   the chain can only grow forward, never sideways.
--
--   DELETE is intentionally NOT blocked at the trigger level:
--     * ON DELETE CASCADE from `projects` must still work for
--       test cleanup and future GDPR project-wipe flows
--     * Gaps in the chain are *detectable* (prev_hash of row N+1
--       won't match any row's rowHash), which is sufficient for
--       tamper-evidence
--     * The chain verifier reports both "broken links" and "missing
--       rows" — policy, not physics, guarantees retention

-- ============================================================
-- Part 1 — Hash chain columns
-- ============================================================

ALTER TABLE "audit_logs" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "rowHash" TEXT;
CREATE UNIQUE INDEX "audit_logs_rowHash_key" ON "audit_logs"("rowHash");

-- ============================================================
-- Part 2 — Append-only triggers (UPDATE blocked, DELETE allowed)
-- ============================================================

CREATE OR REPLACE FUNCTION reject_update_audit() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only (UPDATE rejected)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON "audit_logs";
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_update_audit();

DROP TRIGGER IF EXISTS credit_ledger_no_update ON "credit_ledger";
CREATE TRIGGER credit_ledger_no_update
  BEFORE UPDATE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_update_audit();
