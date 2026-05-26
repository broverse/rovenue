-- 0044_outbox_notification_aggregate.sql
-- Add 'NOTIFICATION' to the outbox aggregate_type enum.
--
-- Done via type-swap (CREATE _new / ALTER USING / DROP / RENAME) instead of
-- ALTER TYPE ADD VALUE so the whole change runs in one transaction —
-- matching the convention from 0039_member_role_rebuild.sql and avoiding
-- Postgres's "unsafe use of new enum value in the same transaction" guard.

CREATE TYPE "aggregate_type_new" AS ENUM (
  'EXPOSURE',
  'REVENUE_EVENT',
  'CREDIT_LEDGER',
  'NOTIFICATION'
);--> statement-breakpoint

ALTER TABLE outbox_events
  ALTER COLUMN "aggregateType" TYPE "aggregate_type_new"
  USING "aggregateType"::text::"aggregate_type_new";--> statement-breakpoint

DROP TYPE "aggregate_type";--> statement-breakpoint
ALTER TYPE "aggregate_type_new" RENAME TO "aggregate_type";
