-- =============================================================
-- user_preferences — Phase 2 Account / Identity
-- =============================================================
--
-- One row per user (PK = userId) holding two opaque JSON blobs:
-- `notifications` (channel + event toggles) and `appearance`
-- (theme, density, number formatting). Both default to `{}` so
-- a freshly-signed-up user can read preferences before any
-- write has happened — the upsert path in the dashboard's PATCH
-- handler fills in keys as they're set.

CREATE TABLE "user_preferences" (
	"userId" text PRIMARY KEY NOT NULL,
	"notifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"appearance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
