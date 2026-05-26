-- =============================================================
-- twoFactor — Better Auth twoFactor plugin
-- =============================================================
--
-- Adds the `twoFactor` table (TOTP secret + AES-encrypted backup
-- codes) and a `twoFactorEnabled` flag on `user`. The plugin runs
-- in `allowPasswordless: true` mode since the deployment is
-- OAuth-only and there is no credential password to gate on.

ALTER TABLE "user"
  ADD COLUMN "twoFactorEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "twoFactor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL,
  "verified" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "twoFactor"
  ADD CONSTRAINT "twoFactor_userId_user_id_fk"
  FOREIGN KEY ("userId") REFERENCES "public"."user"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" USING btree ("secret");
