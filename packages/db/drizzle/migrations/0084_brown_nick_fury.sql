-- Add 'studio' to billing_tier via the recreate-enum pattern instead of
-- ALTER TYPE ... ADD VALUE: Postgres forbids USING a value added by
-- ADD VALUE inside the same transaction, and the drizzle migrator runs
-- all pending migrations in one transaction (0085 inserts studio rows).
-- CREATE TYPE has no such restriction.
ALTER TABLE "billing_subscriptions" ALTER COLUMN "tier" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."billing_tier" RENAME TO "billing_tier_old";--> statement-breakpoint
CREATE TYPE "public"."billing_tier" AS ENUM ('free', 'indie', 'pro', 'scale', 'studio', 'growth', 'enterprise');--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "tier" TYPE "public"."billing_tier" USING "tier"::text::"public"."billing_tier";--> statement-breakpoint
ALTER TABLE "billing_tier_limits" ALTER COLUMN "tier" TYPE "public"."billing_tier" USING "tier"::text::"public"."billing_tier";--> statement-breakpoint
DROP TYPE "public"."billing_tier_old";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "tier" SET DEFAULT 'free';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "usage_locked_at" timestamp with time zone;
