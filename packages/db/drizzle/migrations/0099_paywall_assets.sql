-- Paywall asset CDN: uploaded images, video and Lottie files.
--
-- Rows are immutable once created (design spec §4.1): an asset is
-- created and deleted, never overwritten. That is what lets the
-- storage key omit a content hash and still guarantee a key never
-- serves two different byte sequences, and it is what makes the
-- `immutable` cache header on the served object an honest claim.

CREATE TABLE "paywall_assets" (
  "id"              text PRIMARY KEY NOT NULL,
  "project_id"      text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind"            text NOT NULL,
  "name"            text NOT NULL,
  "storage_key"     text NOT NULL,
  "content_hash"    text NOT NULL,
  "content_type"    text NOT NULL,
  "byte_size"       integer NOT NULL,
  "width"           integer,
  "height"          integer,
  "source_format"   text,
  "source_width"    integer,
  "source_height"   integer,
  "policy_version"  integer NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"      timestamp with time zone
);

-- Partial, so that deleting an asset frees its hash for re-upload.
CREATE UNIQUE INDEX "paywall_assets_project_hash_key"
  ON "paywall_assets" ("project_id", "content_hash")
  WHERE "deleted_at" IS NULL;

CREATE INDEX "paywall_assets_project_idx"
  ON "paywall_assets" ("project_id") WHERE "deleted_at" IS NULL;

-- The sweeper scans by age across all projects.
CREATE INDEX "paywall_assets_created_at_idx" ON "paywall_assets" ("created_at");

-- Which published paywall version references which asset. Derived data,
-- rewritten on every publish (design spec §7).
CREATE TABLE "paywall_asset_usages" (
  "asset_id"   text NOT NULL REFERENCES "paywall_assets"("id") ON DELETE CASCADE,
  "paywall_id" text NOT NULL REFERENCES "paywalls"("id") ON DELETE CASCADE,
  "version_id" text NOT NULL REFERENCES "paywall_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "paywall_asset_usages_pk" PRIMARY KEY ("asset_id", "version_id")
);

CREATE INDEX "paywall_asset_usages_version_idx"
  ON "paywall_asset_usages" ("version_id");

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
