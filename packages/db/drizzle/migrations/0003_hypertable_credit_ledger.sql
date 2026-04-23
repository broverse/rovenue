-- Convert credit_ledger to a TimescaleDB hypertable partitioned by
-- createdAt. Append-only by DB trigger (seed.ts confirms mutations
-- are blocked), so compressed chunk read/modify cost is zero.
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_pkey";
ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id", "createdAt");

SELECT create_hypertable(
  '"credit_ledger"',
  by_range('createdAt', INTERVAL '1 day'),
  migrate_data => true,
  if_not_exists => true
);
