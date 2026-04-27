-- 0017_partition_outgoing_webhooks.sql
-- Plan 3 §D.4 — convert outgoing_webhooks from a TimescaleDB hypertable
-- to a vanilla declarative range-partitioned table on `createdAt` (monthly).
--
-- Pre-req: Plan 3 Phase 0 cutover gate passed in production.
-- Pre-req: 0016 (credit_ledger partition) applied.
-- Pre-req: migrate-hypertable-to-partitioned.ts dry-run passed in staging.
--
-- Schema MUST match packages/db/src/drizzle/schema.ts (outgoingWebhooks).
-- The 90-day retention sweep stays on the existing webhook-retention worker
-- because the predicate is composite (status + age); pg_partman (Phase F)
-- intentionally does NOT manage this table's lifecycle.

ALTER TABLE "outgoing_webhooks" RENAME TO "outgoing_webhooks_legacy_hypertable";--> statement-breakpoint

CREATE TABLE "outgoing_webhooks" (
  "id"               text                       NOT NULL,
  "projectId"        text                       NOT NULL REFERENCES "projects"("id")  ON DELETE CASCADE,
  "eventType"        text                       NOT NULL,
  "subscriberId"     text                       NOT NULL REFERENCES "subscribers"("id") ON DELETE CASCADE,
  "purchaseId"       text                       REFERENCES "purchases"("id"),
  "payload"          jsonb                      NOT NULL,
  "url"              text                       NOT NULL,
  "status"           "OutgoingWebhookStatus"    NOT NULL DEFAULT 'PENDING',
  "httpStatus"       integer,
  "responseBody"     text,
  "lastErrorMessage" text,
  "attempts"         integer                    NOT NULL DEFAULT 0,
  "nextRetryAt"      timestamptz,
  "sentAt"           timestamptz,
  "deadAt"           timestamptz,
  "createdAt"        timestamptz                NOT NULL DEFAULT now(),
  CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");--> statement-breakpoint

CREATE INDEX "outgoing_webhooks_status_nextRetryAt_idx"
  ON "outgoing_webhooks" ("status", "nextRetryAt");--> statement-breakpoint
CREATE INDEX "outgoing_webhooks_projectId_status_idx"
  ON "outgoing_webhooks" ("projectId", "status");--> statement-breakpoint

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
    child_name := format('outgoing_webhooks_%s_%s',
                         to_char(cur, 'YYYY'),
                         to_char(cur, 'MM'));
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "outgoing_webhooks" FOR VALUES FROM (%L) TO (%L)',
      child_name, cur::timestamptz, next_month::timestamptz
    );
    cur := next_month;
  END LOOP;
END
$partitions$;
