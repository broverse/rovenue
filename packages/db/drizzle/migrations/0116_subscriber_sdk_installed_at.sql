ALTER TABLE "subscribers" ADD COLUMN "sdkInstalledAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "subscribers_projectId_sdkInstalledAt_idx" ON "subscribers" USING btree ("projectId","sdkInstalledAt") WHERE "subscribers"."sdkInstalledAt" IS NOT NULL;--> statement-breakpoint
-- Backfill from the pre-existing SDK-only marker. `attributes.platform`
-- is written by resolveOrCreateSubscriber on CREATE only (the conflict
-- path never touches attributes), and services/import/write.ts rule 6
-- forbids the CSV importer from ever setting it -- so its presence
-- identifies exactly the rows the SDK created, historically.
--
-- Rows anonymized before this migration have had their attributes
-- cleared (services/gdpr/anonymize-subscriber.ts) and stay NULL: that
-- install is not recoverable from retained data and is deliberately not
-- guessed. Going forward the column survives erasure, which is why it
-- exists instead of the reader querying the attribute directly.
UPDATE "subscribers"
   SET "sdkInstalledAt" = "firstSeenAt"
 WHERE "sdkInstalledAt" IS NULL
   AND "attributes" ? 'platform';
