-- 1. add columns (rovenueId nullable for now)
ALTER TABLE "subscribers" ADD COLUMN "rovenueId" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "identifiedAt" timestamp with time zone;--> statement-breakpoint

-- 2. backfill: the current device-facing key becomes the permanent rovenueId.
--    Applies to soft-deleted rows too so mergedInto redirects keep resolving.
UPDATE "subscribers" SET "rovenueId" = "appUserId" WHERE "rovenueId" IS NULL;--> statement-breakpoint

-- 3. enforce
ALTER TABLE "subscribers" ALTER COLUMN "rovenueId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ALTER COLUMN "appUserId" DROP NOT NULL;--> statement-breakpoint

-- 4. swap unique indexes
DROP INDEX IF EXISTS "subscribers_projectId_appUserId_key";--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_projectId_rovenueId_key" ON "subscribers" ("projectId","rovenueId");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_projectId_appUserId_key" ON "subscribers" ("projectId","appUserId") WHERE "appUserId" IS NOT NULL AND "deletedAt" IS NULL;
