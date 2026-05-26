CREATE TYPE "public"."FeatureFlagEnv" AS ENUM('PROD', 'STAGING', 'DEVELOPMENT');--> statement-breakpoint
DROP INDEX "feature_flags_projectId_key_key";--> statement-breakpoint
DROP INDEX "feature_flags_projectId_isEnabled_idx";--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN "env" "FeatureFlagEnv" DEFAULT 'PROD' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_projectId_env_key_key" ON "feature_flags" USING btree ("projectId","env","key");--> statement-breakpoint
CREATE INDEX "feature_flags_projectId_env_isEnabled_idx" ON "feature_flags" USING btree ("projectId","env","isEnabled");