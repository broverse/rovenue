-- Financial invariants for the append-only credit ledger.
-- credit_ledger is range-partitioned (pg_partman); CHECK + trigger
-- apply to the parent and propagate to all partitions.

ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_balance_non_negative" CHECK ("balance" >= 0);

CREATE OR REPLACE FUNCTION "credit_ledger_reject_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "credit_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_reject_mutation"();
