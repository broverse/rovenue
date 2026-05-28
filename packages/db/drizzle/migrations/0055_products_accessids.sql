ALTER TABLE "products" ADD COLUMN "accessIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "entitlementKeys";