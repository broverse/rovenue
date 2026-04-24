-- outbox_events: transactional outbox feeding the Kafka pipeline.
--
-- Every analytics-eligible OLTP write lands here in the same
-- transaction as the business insert (same-tx safety: the Kafka
-- publish can never happen without the OLTP row, and vice versa).
-- An async outbox-dispatcher worker (apps/api/src/workers/
-- outbox-dispatcher.ts) claims unpublished rows in batches, writes
-- them to Redpanda, and marks `publishedAt` on success. At-least-
-- once semantics — consumers (ClickHouse Kafka Engine + the
-- ReplacingMergeTree on `eventId`) handle dedup.
--
-- Columns are double-quoted camelCase to match the rovenue
-- on-disk convention (revenueEvents, creditLedger, outgoingWebhooks
-- etc).
--
-- Indexes:
--   pk on id — every insert/claim/markPublished filters by id.
--   unpublished_idx on (createdAt) WHERE publishedAt IS NULL —
--     the dispatcher's claim query is
--     `ORDER BY createdAt LIMIT N WHERE publishedAt IS NULL`.
--     A partial index keeps this fast even after millions of
--     published rows accumulate (rows get cleaned up by a separate
--     retention worker not in this plan — Plan 2 scope).
--
-- The aggregate_type enum enumerates the Kafka topic suffix:
--   'EXPOSURE'      → rovenue.exposures
--   'REVENUE_EVENT' → rovenue.revenue   (Plan 2)
--   'CREDIT_LEDGER' → rovenue.credit    (Plan 2)
-- Plan 1 only fans out EXPOSURE; the other values are reserved so
-- Plan 2 does not need a schema migration.
--
-- drizzle-orm's migrator wraps each .sql in a transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aggregate_type') THEN
    CREATE TYPE "aggregate_type" AS ENUM (
      'EXPOSURE',
      'REVENUE_EVENT',
      'CREDIT_LEDGER'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" TEXT PRIMARY KEY,
  "aggregateType" "aggregate_type" NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "publishedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "outbox_events_unpublished_idx"
  ON "outbox_events" ("createdAt")
  WHERE "publishedAt" IS NULL;
