-- Google purchase-token second pass (ROADMAP §11).
--
-- The token was previously transient: normalize.ts carried it in memory,
-- handed it to Phase B's store call, and discarded it. A row imported
-- from an export with no token column was written history-only
-- (androidNoToken, verifiedAt null) with no way to ever re-verify it.
-- This column is where a later enrichment pass puts the token so Phase B
-- can pick the row up.
--
-- Nullable and additive: expand-phase only.
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "googlePurchaseToken" text;--> statement-breakpoint

-- Partial: only PLAY_STORE rows that still lack a token are enrichment
-- candidates, which is a small and shrinking slice of the table.
CREATE INDEX IF NOT EXISTS "purchases_google_token_enrichment_idx" ON "purchases" USING btree ("subscriberId","productId") WHERE "purchases"."store" = 'PLAY_STORE' AND "purchases"."googlePurchaseToken" IS NULL;
