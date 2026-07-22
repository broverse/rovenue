-- 0093_paywall_versions.sql
--
-- P0 of the paywall builder redesign: split draft from published.
--
-- Before this migration `paywalls.builderConfig` was BOTH the builder's
-- autosave target AND the document /v1/placements shipped to production
-- devices — an in-progress edit went live as soon as the edge cache
-- expired. After it, the builder still autosaves into
-- `paywalls.builderConfig` (now unambiguously THE DRAFT) and publishing
-- snapshots that draft into `paywall_versions`, which is what the SDK
-- resolution path reads.
--
-- The snapshot carries `offeringId` and `remoteConfig` as well as
-- `builderConfig`: re-pointing the draft at another offering, or editing
-- remote config, must not retroactively change an already-published
-- version.
--
-- The backfill at the bottom is NOT optional. apps/api/src/lib/
-- placement-resolution.ts resolves `publishedVersionId` and returns null
-- when it is absent, so without the backfill every existing paywall
-- would go dark on deploy.

CREATE TYPE "PaywallStatus" AS ENUM ('draft', 'published', 'archived');

CREATE TABLE "paywall_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "paywallId" text NOT NULL,
  "versionNo" integer NOT NULL,
  "builderConfig" jsonb,
  "remoteConfig" jsonb NOT NULL,
  "offeringId" text NOT NULL,
  "configFormatVersion" integer DEFAULT 1 NOT NULL,
  "label" text,
  "publishedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "publishedBy" text
);

ALTER TABLE "paywall_versions"
  ADD CONSTRAINT "paywall_versions_paywallId_paywalls_id_fk"
  FOREIGN KEY ("paywallId") REFERENCES "paywalls"("id") ON DELETE cascade;

ALTER TABLE "paywall_versions"
  ADD CONSTRAINT "paywall_versions_publishedBy_user_id_fk"
  FOREIGN KEY ("publishedBy") REFERENCES "user"("id") ON DELETE set null;

CREATE UNIQUE INDEX "paywall_versions_paywallId_versionNo_key"
  ON "paywall_versions" ("paywallId", "versionNo");

CREATE INDEX "paywall_versions_paywallId_idx"
  ON "paywall_versions" ("paywallId");

ALTER TABLE "paywalls"
  ADD COLUMN "status" "PaywallStatus" DEFAULT 'draft' NOT NULL;

ALTER TABLE "paywalls" ADD COLUMN "publishedVersionId" text;

ALTER TABLE "paywalls"
  ADD CONSTRAINT "paywalls_publishedVersionId_paywall_versions_id_fk"
  FOREIGN KEY ("publishedVersionId") REFERENCES "paywall_versions"("id")
  ON DELETE set null;

-- ---------------------------------------------------------------
-- Backfill: auto-publish a v1 for every existing paywall from its
-- current state, then point the paywall at it.
--
-- `gen_random_uuid()::text` is a deliberate one-off exception to the
-- cuid2 ID convention: cuid2 is generated in application code and is
-- unavailable inside a SQL migration. IDs are opaque `text`, so a UUID
-- string is a valid value for this column; every version minted after
-- this migration comes from `createId()` as normal.
-- ---------------------------------------------------------------

WITH inserted AS (
  INSERT INTO "paywall_versions" (
    "id", "paywallId", "versionNo", "builderConfig", "remoteConfig",
    "offeringId", "configFormatVersion", "label", "publishedAt", "publishedBy"
  )
  SELECT
    gen_random_uuid()::text,
    "paywalls"."id",
    1,
    "paywalls"."builderConfig",
    "paywalls"."remoteConfig",
    "paywalls"."offeringId",
    "paywalls"."configFormatVersion",
    'Backfilled from pre-versioning state',
    "paywalls"."updatedAt",
    NULL
  FROM "paywalls"
  RETURNING "id", "paywallId"
)
UPDATE "paywalls"
SET "publishedVersionId" = inserted."id",
    "status" = 'published'
FROM inserted
WHERE "paywalls"."id" = inserted."paywallId";
