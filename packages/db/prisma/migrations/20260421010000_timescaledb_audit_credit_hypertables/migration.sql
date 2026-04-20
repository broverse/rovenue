-- ============================================================
-- TimescaleDB — audit_logs + credit_ledger hypertables
-- ============================================================
--
-- Second pass after revenue_events. These two tables share the
-- append-only posture (UPDATE is blocked by BEFORE triggers) and
-- skew heavily toward time-range reads, so partitioning by
-- createdAt is a clean win.
--
-- webhook_events is intentionally deferred — its UNIQUE (source,
-- storeEventId) constraint would need to carry the partition
-- column, which loosens dedup across chunks. We'll revisit with
-- a per-chunk dedup pattern in a later phase.

-- ============================================================
-- audit_logs
-- ============================================================

-- Every UNIQUE constraint must carry the partition column.
-- (id) → (id, createdAt)  |  (rowHash) → (rowHash, createdAt)
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_pkey";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id", "createdAt");

DROP INDEX "audit_logs_rowHash_key";
CREATE UNIQUE INDEX "audit_logs_rowHash_key"
  ON "audit_logs"("rowHash", "createdAt");

SELECT create_hypertable(
  'audit_logs',
  'createdAt',
  chunk_time_interval => INTERVAL '1 day',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

-- Compression: per-project columnar layout. Audit reads are
-- almost always project-scoped + date-bounded so the segmentby
-- choice maps onto the hot access pattern.
ALTER TABLE "audit_logs" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);

-- Compress chunks older than 30 days. Audit history stays live
-- for the first month (common investigation window) and shifts
-- to the columnar store after.
SELECT add_compression_policy(
  'audit_logs',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

-- No retention policy: audit trail is kept indefinitely by design.
-- Compliance workflows run their own anonymisation against the
-- uncompressed tail via anonymizeSubscriber().

-- ============================================================
-- credit_ledger
-- ============================================================

ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_pkey";
ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id", "createdAt");

SELECT create_hypertable(
  'credit_ledger',
  'createdAt',
  chunk_time_interval => INTERVAL '1 day',
  migrate_data        => TRUE,
  if_not_exists       => TRUE
);

ALTER TABLE "credit_ledger" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);

SELECT add_compression_policy(
  'credit_ledger',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

-- Financial ledger — 7-year retention window to cover audit +
-- regulatory requests, matching the revenue_events policy.
SELECT add_retention_policy(
  'credit_ledger',
  INTERVAL '7 years',
  if_not_exists => TRUE
);
