-- Convert outgoing_webhooks to a TimescaleDB hypertable partitioned
-- by createdAt. Retry workers UPDATE `status`, `attempts`,
-- `nextRetryAt`, etc. on recent rows — hypertable supports those
-- updates on uncompressed chunks at zero cost, and compressed-chunk
-- updates (TimescaleDB 2.11+) are only triggered for old rows which
-- retry logic never touches (Alan 3 retry window << 30 days).
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "outgoing_webhooks" DROP CONSTRAINT "outgoing_webhooks_pkey";
ALTER TABLE "outgoing_webhooks"
  ADD CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id", "createdAt");

-- 6-hour chunks — smaller than revenue_events because retry queues
-- favour fine-grained chunk exclusion for "WHERE status = 'PENDING'
-- AND nextRetryAt <= now()" queries.
SELECT create_hypertable(
  '"outgoing_webhooks"',
  by_range('createdAt', INTERVAL '6 hours'),
  migrate_data => true,
  if_not_exists => true
);
