-- 0016_partition_credit_ledger.sql
-- Plan 3 §D.3 — convert credit_ledger from a TimescaleDB hypertable to a
-- vanilla declarative range-partitioned table on `createdAt` (monthly).
--
-- Pre-req: Plan 3 Phase 0 cutover gate passed in production.
-- Pre-req: 0015 (revenue_events partition) applied.
-- Pre-req: migrate-hypertable-to-partitioned.ts dry-run passed in staging.
--
-- Schema MUST match packages/db/src/drizzle/schema.ts (creditLedger).
-- credit_ledger is append-only by repository convention.

ALTER TABLE "credit_ledger" RENAME TO "credit_ledger_legacy_hypertable";--> statement-breakpoint

CREATE TABLE "credit_ledger" (
  "id"             text                 NOT NULL,
  "projectId"      text                 NOT NULL REFERENCES "projects"("id")  ON DELETE CASCADE,
  "subscriberId"   text                 NOT NULL REFERENCES "subscribers"("id") ON DELETE CASCADE,
  "type"           "CreditLedgerType"   NOT NULL,
  "amount"         integer              NOT NULL,
  "balance"        integer              NOT NULL,
  "referenceType"  text,
  "referenceId"    text,
  "description"    text,
  "metadata"       jsonb,
  "createdAt"      timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");--> statement-breakpoint

CREATE INDEX "credit_ledger_subscriberId_createdAt_idx"
  ON "credit_ledger" ("subscriberId", "createdAt");--> statement-breakpoint
CREATE INDEX "credit_ledger_projectId_subscriberId_idx"
  ON "credit_ledger" ("projectId", "subscriberId");--> statement-breakpoint

DO $partitions$
DECLARE
  start_month date := DATE '2024-01-01';
  end_month   date := DATE '2029-01-01';
  cur date := start_month;
  next_month date;
  child_name text;
BEGIN
  WHILE cur < end_month LOOP
    next_month := (cur + INTERVAL '1 month')::date;
    child_name := format('credit_ledger_%s_%s',
                         to_char(cur, 'YYYY'),
                         to_char(cur, 'MM'));
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "credit_ledger" FOR VALUES FROM (%L) TO (%L)',
      child_name, cur::timestamptz, next_month::timestamptz
    );
    cur := next_month;
  END LOOP;
END
$partitions$;
