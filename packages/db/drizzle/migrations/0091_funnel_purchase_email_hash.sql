-- 0091_funnel_purchase_email_hash.sql
--
-- `funnel_claim_tokens.email_hash` is the magic-link recovery path's only
-- key: a buyer who pays on a funnel page and never returns to that tab
-- installs days later, on another device, with no session id, and the
-- emailed link is the only way back to their purchase. Nothing ever wrote
-- that column, so `POST /v1/sdk/claim-via-email` could never match.
--
-- The address is known at payment-intent time (the route already builds
-- the Stripe Customer with it) and is gone by completion time —
-- `completeFunnelPurchase` has no email parameter, and giving it one by
-- retrieving the Stripe Customer would put a network call inside a
-- database transaction. So the hash is parked on the purchase row here
-- and copied onto the claim token when the purchase completes.
--
-- Only the hash. The plaintext stays in Stripe: the token table
-- deliberately holds a digest so a database leak is not an email leak,
-- and a plaintext column on the purchase row would undo that.
--
-- Nullable on purpose. Rows written before this migration have no hash
-- and must still complete and still mint a token — a NOT NULL here would
-- turn the recovery path into a hard requirement for purchases that
-- predate it.
--
-- No index: this column is never a lookup key. The lookup happens on
-- `funnel_claim_tokens.email_hash`, which already has
-- `funnel_claim_tokens_email_idx`.

ALTER TABLE "funnel_purchases"
  ADD COLUMN IF NOT EXISTS "email_hash" text;
