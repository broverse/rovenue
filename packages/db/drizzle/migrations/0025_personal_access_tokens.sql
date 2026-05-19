-- =============================================================
-- personal_access_tokens — Phase 2 Account / Identity
-- =============================================================
--
-- Per-user API tokens issued from the dashboard's account page.
-- Plaintext is shown once at creation time; the API auth path
-- only ever sees `tokenHash` (SHA-256, mirroring api_keys.keySecretHash).
-- The `prefix` column keeps the public "rvn_pat_<first>…<last>"
-- string so revoked tokens stay identifiable in the dashboard
-- without ever recovering the plaintext.

CREATE TABLE "personal_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"tokenHash" text NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_access_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_access_tokens_userId_idx" ON "personal_access_tokens" USING btree ("userId");
