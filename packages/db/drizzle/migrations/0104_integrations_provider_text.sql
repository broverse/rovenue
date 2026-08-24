-- 0104_integrations_provider_text.sql
--
-- provider_id becomes text: the provider registry (app code) is the single
-- source of truth, so adding a provider must not require a migration.
-- ALTER on the partitioned integration_deliveries parent cascades to its
-- pg_partman partitions.
ALTER TABLE "integration_connections" ALTER COLUMN "provider_id" TYPE text USING "provider_id"::text;
ALTER TABLE "integration_deliveries" ALTER COLUMN "provider_id" TYPE text USING "provider_id"::text;

-- pg_partman keeps a template table per partitioned parent
-- (partman.template_public_integration_deliveries) that mirrors the
-- parent's column defs but does NOT inherit from it, so the ALTER above
-- does not cascade to it. It still depends on the enum, so DROP TYPE
-- below fails without this.
ALTER TABLE "partman"."template_public_integration_deliveries" ALTER COLUMN "provider_id" TYPE text USING "provider_id"::text;

DROP TYPE IF EXISTS "IntegrationProvider";

-- Multi-endpoint webhooks: uniqueness stays DB-enforced for single-connection
-- providers; CUSTOM_WEBHOOK rows are exempt. Excluding soft-deleted rows also
-- fixes recreate-after-delete for every provider.
DROP INDEX IF EXISTS "integration_connections_project_provider_uidx";
CREATE UNIQUE INDEX "integration_connections_project_provider_uidx"
  ON "integration_connections" ("project_id", "provider_id")
  WHERE "provider_id" <> 'CUSTOM_WEBHOOK' AND "deleted_at" IS NULL;

-- Subscription lifecycle events get their own outbox aggregate (Task 6).
-- PG16 allows ADD VALUE inside a transaction as long as the new value is not
-- used in the same transaction — nothing in this migration uses it.
ALTER TYPE "aggregate_type" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
