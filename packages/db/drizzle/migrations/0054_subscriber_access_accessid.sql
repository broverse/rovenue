DROP INDEX "subscriber_access_subscriberId_entitlementKey_idx";--> statement-breakpoint
ALTER TABLE "subscriber_access" ADD COLUMN "accessId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriber_access" ADD CONSTRAINT "subscriber_access_accessId_access_id_fk" FOREIGN KEY ("accessId") REFERENCES "public"."access"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriber_access_subscriberId_accessId_idx" ON "subscriber_access" USING btree ("subscriberId","accessId");--> statement-breakpoint
ALTER TABLE "subscriber_access" DROP COLUMN "entitlementKey";