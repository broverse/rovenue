-- Store-side event-time ordering for purchase status writes.
--
-- NOTE: drizzle-kit also emitted DDL for the paywall asset tables
-- (created by hand-written 0099), billing_tier_limits.
-- asset_storage_bytes_limit (0101), and purchases_status_expiresDate_idx
-- (0102) because those never entered its snapshot until now. That DDL is
-- trimmed here — the objects already exist on every migrated database —
-- and keeping them in this migration's snapshot stops future generates
-- from re-emitting them.
ALTER TABLE "purchases" ADD COLUMN "lastStoreEventAt" timestamp with time zone;
