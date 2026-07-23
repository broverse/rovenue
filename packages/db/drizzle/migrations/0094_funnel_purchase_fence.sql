-- Fencing token for the funnel payment lock.
--
-- The payment-intent endpoint held a Redis lock and checked
-- `stillHeld()` before writing, which is check-then-act: a holder whose
-- TTL expired mid-flight could still clobber the current holder's row
-- with stale Stripe ids. The buyer then pays against a client_secret the
-- row no longer describes and /confirm can never settle it.
--
-- Safety moves into SQL: every writer increments the token it read under
-- the lock, and upsertPending's ON CONFLICT guard refuses a write whose
-- token is not strictly greater than the stored one.
--
-- Existing rows default to 0, so the first write after this migration
-- (token 1) is accepted.
ALTER TABLE "funnel_purchases"
  ADD COLUMN "fence_token" integer NOT NULL DEFAULT 0;
