ALTER TABLE "subscribers" ADD COLUMN "apple_app_account_token" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscribers_apple_app_account_token" ON "subscribers" USING btree ("projectId","apple_app_account_token") WHERE "subscribers"."apple_app_account_token" IS NOT NULL;
