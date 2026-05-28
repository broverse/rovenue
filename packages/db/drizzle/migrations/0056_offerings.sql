-- Rename product_groups → offerings + add accessId FK.
-- Pre-launch: any existing rows are wiped (the FK can't be added
-- as NOT NULL without a backfill source) and the table is rebuilt
-- empty under its new name.

TRUNCATE TABLE "product_groups";--> statement-breakpoint

ALTER TABLE "product_groups" RENAME TO "offerings";--> statement-breakpoint

ALTER TABLE "offerings"
  RENAME CONSTRAINT "product_groups_projectId_projects_id_fk"
    TO "offerings_projectId_projects_id_fk";--> statement-breakpoint

ALTER INDEX "product_groups_projectId_identifier_key"
  RENAME TO "offerings_projectId_identifier_key";--> statement-breakpoint

DROP INDEX "product_groups_projectId_isDefault_idx";--> statement-breakpoint

ALTER TABLE "offerings"
  ADD COLUMN "accessId" text NOT NULL;--> statement-breakpoint

ALTER TABLE "offerings"
  ADD CONSTRAINT "offerings_accessId_access_id_fk"
  FOREIGN KEY ("accessId") REFERENCES "public"."access"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "offerings_accessId_isDefault_idx"
  ON "offerings" USING btree ("accessId","isDefault");
