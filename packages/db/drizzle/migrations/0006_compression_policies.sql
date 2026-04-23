-- Compression settings + policies for the three hypertables.
--
-- TSL-gated: compression requires timescaledb.license=timescale
-- (see docker-compose.yml). Does NOT work under apache license.
--
-- segment_by choice: projectId for all three. It has the right
-- cardinality (tens to hundreds in a multi-tenant deployment — sweet
-- spot per spec §5.3) and lines up with the dominant query filter
-- ("WHERE projectId = $1"), so compressed-chunk reads prune to one
-- segment and decompress only what they need.
--
-- order_by is time DESC because reads almost always want the newest
-- rows first (dashboard time-series charts, webhook retry lookups).

-- revenue_events
ALTER TABLE "revenue_events" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"eventDate" DESC'
);
-- Chunks older than 30 days get compressed on the nightly policy run.
SELECT add_compression_policy('revenue_events', INTERVAL '30 days');

-- credit_ledger
ALTER TABLE "credit_ledger" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);
SELECT add_compression_policy('credit_ledger', INTERVAL '30 days');

-- outgoing_webhooks
-- Retry worker (apps/api/src/workers/webhook-delivery.ts) has a
-- cumulative ~14.6h retry schedule, so rows older than 7 days are
-- guaranteed terminal (SENT / DEAD / DISMISSED). Dashboard
-- manual-retry endpoints (resetWebhookForRetry, markWebhookDismissed)
-- still take a bare WHERE id = $1 filter and could therefore decompress
-- a chunk on a stale DEAD retry. See Task 6.1 precondition follow-up.
ALTER TABLE "outgoing_webhooks" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);
SELECT add_compression_policy('outgoing_webhooks', INTERVAL '7 days');
