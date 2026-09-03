-- BILLING_ISSUE cannot be added with ALTER TYPE ... ADD VALUE.
-- Postgres forbids USING a value added that way inside the transaction
-- that added it, and the drizzle migrator runs ALL pending migrations
-- in one transaction (drizzle-orm/pg-core/dialect.cjs — `migrate()`
-- wraps the whole loop in `session.transaction`). Splitting across two
-- files does not help: on a fresh install both land in the same
-- transaction and the run fails with `unsafe use of new value`, while
-- passing on a developer machine where the files ran separately.
-- Same reasoning and same shape as 0084_brown_nick_fury.sql.
--
-- Both partial indexes are dropped and recreated. Only the second one's
-- predicate actually changes (it gains BILLING_ISSUE, so held Play
-- subscriptions keep being re-polled); the first is dropped because a
-- partial-index predicate embeds Const nodes of the enum type being
-- dropped and cannot be rebuilt in place.
DROP INDEX IF EXISTS "purchases_status_expiresDate_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "purchases_google_reconciliation_idx";--> statement-breakpoint
ALTER TYPE "public"."PurchaseStatus" RENAME TO "PurchaseStatus_old";--> statement-breakpoint
CREATE TYPE "public"."PurchaseStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'REFUNDED', 'REVOKED', 'PAUSED', 'GRACE_PERIOD', 'BILLING_ISSUE');--> statement-breakpoint
ALTER TABLE "purchases" ALTER COLUMN "status" TYPE "public"."PurchaseStatus" USING "status"::text::"public"."PurchaseStatus";--> statement-breakpoint
DROP TYPE "public"."PurchaseStatus_old";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "billingIssueDetectedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "purchases_status_expiresDate_idx" ON "purchases" USING btree ("status","expiresDate") WHERE "purchases"."status" IN ('TRIAL', 'ACTIVE', 'PAUSED', 'GRACE_PERIOD');--> statement-breakpoint
CREATE INDEX "purchases_google_reconciliation_idx" ON "purchases" USING btree ("store","lastReconciledAt","expiresDate") WHERE "purchases"."store" = 'PLAY_STORE' AND "purchases"."status" IN ('TRIAL', 'ACTIVE', 'PAUSED', 'GRACE_PERIOD', 'BILLING_ISSUE');
