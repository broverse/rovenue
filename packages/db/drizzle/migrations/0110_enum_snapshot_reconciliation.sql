-- Snapshot reconciliation — NOT a schema change.
--
-- Seven enums were declared in enums.ts and USED by schema.ts but never
-- re-exported from it. drizzle-kit only registers enums it can see
-- exported from the file named in drizzle.config.ts's `schema`, so it
-- believed they did not exist. The consequences were real and shipped:
-- `generate` emitted a destructive `DROP TYPE "public"."ImportJobStatus"`
-- on a clean tree, and across four consecutive tasks it silently dropped
-- CREATE TYPE statements and swept unrelated DDL into new migrations.
--
-- The re-export is the actual fix (packages/db/src/drizzle/schema.ts).
-- This migration exists so the checked-in snapshot catches up in step
-- with the journal. Every type below ALREADY EXISTS on any database
-- that ran its original migration, so each statement is guarded and is
-- a no-op there; the guard also makes it correct on a database that
-- somehow lacks one.

DO $$ BEGIN
  CREATE TYPE "public"."aggregate_type" AS ENUM('EXPOSURE', 'REVENUE_EVENT', 'CREDIT_LEDGER', 'BILLING', 'NOTIFICATION', 'FUNNEL', 'PAYWALL_EVENT', 'SUBSCRIPTION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."IntegrationDeliveryStatus" AS ENUM('pending', 'succeeded', 'failed', 'skipped', 'dead_letter');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."PaywallStatus" AS ENUM('draft', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."refund_shield_apple_environment" AS ENUM('PRODUCTION', 'SANDBOX');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."refund_shield_outcome" AS ENUM('REFUND_APPROVED', 'REFUND_DECLINED', 'REFUND_REVERSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."refund_shield_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED_NOT_FOUND', 'SKIPPED_DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
