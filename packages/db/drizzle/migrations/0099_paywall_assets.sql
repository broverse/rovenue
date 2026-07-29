-- Paywall asset CDN: uploaded images, video and Lottie files.
--
-- Rows are immutable once created (design spec §4.1): an asset is
-- created and deleted, never overwritten. That is what lets the
-- storage key omit a content hash and still guarantee a key never
-- serves two different byte sequences, and it is what makes the
-- `immutable` cache header on the served object an honest claim.
--
-- Column names are camelCase, matching the paywalls/paywall_versions/
-- font_families family this table joins against (billing_tier_limits
-- below is the one genuinely snake_case table in this file, and its
-- existing columns are left untouched).

CREATE TABLE "paywall_assets" (
  "id"              text PRIMARY KEY NOT NULL,
  "projectId"       text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind"            text NOT NULL,
  "name"            text NOT NULL,
  "storageKey"      text NOT NULL,
  "contentHash"     text NOT NULL,
  "contentType"     text NOT NULL,
  "byteSize"        integer NOT NULL,
  "width"           integer,
  "height"          integer,
  "sourceFormat"    text,
  "sourceWidth"     integer,
  "sourceHeight"    integer,
  "policyVersion"   integer NOT NULL,
  "createdAt"       timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt"       timestamp with time zone DEFAULT now() NOT NULL,
  "deletedAt"       timestamp with time zone
);

-- Partial, so that deleting an asset frees its hash for re-upload.
CREATE UNIQUE INDEX "paywall_assets_project_hash_key"
  ON "paywall_assets" ("projectId", "contentHash")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "paywall_assets_project_idx"
  ON "paywall_assets" ("projectId") WHERE "deletedAt" IS NULL;

-- The sweeper scans by age across all projects.
CREATE INDEX "paywall_assets_created_at_idx" ON "paywall_assets" ("createdAt");

-- Which published paywall version references which asset. Derived data,
-- rewritten on every publish (design spec §7).
CREATE TABLE "paywall_asset_usages" (
  "assetId"   text NOT NULL REFERENCES "paywall_assets"("id") ON DELETE CASCADE,
  "paywallId" text NOT NULL REFERENCES "paywalls"("id") ON DELETE CASCADE,
  "versionId" text NOT NULL REFERENCES "paywall_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "paywall_asset_usages_pk" PRIMARY KEY ("assetId", "versionId")
);

CREATE INDEX "paywall_asset_usages_version_idx"
  ON "paywall_asset_usages" ("versionId");

-- Per-project storage cap. NULL means unlimited, matching how
-- `events_limit` and `sql_limit` already behave in this table.
-- bigint, not integer: 50 GB is 53,687,091,200.
ALTER TABLE "billing_tier_limits"
  ADD COLUMN "asset_storage_bytes_limit" bigint;

UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 262144000
  WHERE "tier" = 'free';                                    -- 250 MB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 5368709120
  WHERE "tier" = 'indie';                                   -- 5 GB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 53687091200
  WHERE "tier" = 'studio';                                  -- 50 GB
-- enterprise stays NULL (unlimited).
