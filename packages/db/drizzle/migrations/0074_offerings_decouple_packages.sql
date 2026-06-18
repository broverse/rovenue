-- Add packages column (nullable first so we can backfill)
ALTER TABLE "offerings" ADD COLUMN "packages" jsonb;

-- Backfill packages from the old products JSONB. Each element gains an
-- "identifier": prefer a deterministic slug per slot; admins rename later.
UPDATE "offerings" o
SET "packages" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'identifier', 'package_' || (elem->>'order'),
        'productId',  elem->>'productId',
        'order',      COALESCE((elem->>'order')::int, 0),
        'isPromoted', COALESCE((elem->>'isPromoted')::boolean, false),
        'metadata',   COALESCE(elem->'metadata', '{}'::jsonb)
      )
    )
    FROM jsonb_array_elements(o."products") AS elem
  ),
  '[]'::jsonb
)
WHERE o."products" IS NOT NULL;

-- Enforce NOT NULL + default now that every row is backfilled
ALTER TABLE "offerings" ALTER COLUMN "packages" SET DEFAULT '[]'::jsonb;
UPDATE "offerings" SET "packages" = '[]'::jsonb WHERE "packages" IS NULL;
ALTER TABLE "offerings" ALTER COLUMN "packages" SET NOT NULL;

-- Drop the old products JSONB
ALTER TABLE "offerings" DROP COLUMN "products";

-- Decouple from access: drop the FK index, then the column
DROP INDEX IF EXISTS "offerings_accessId_isDefault_idx";
ALTER TABLE "offerings" DROP COLUMN "accessId";

-- Hardening: single default offering per project
CREATE UNIQUE INDEX "offerings_projectId_default_key"
  ON "offerings" ("projectId") WHERE "isDefault";
