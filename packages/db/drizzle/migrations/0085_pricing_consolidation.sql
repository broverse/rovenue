-- Pricing consolidation (2026-07-21 spec): 6-tier ladder -> 4
-- (free / indie / studio / enterprise), free threshold $5K,
-- indie repriced to $49 with the merged pro band. Separate file from
-- 0084 because Postgres cannot use a new enum value ('studio') in the
-- same transaction that added it.

-- 1. Retune surviving tiers.
UPDATE "billing_tier_limits" SET "mtr_max" = 5000 WHERE "tier" = 'free';--> statement-breakpoint
UPDATE "billing_tier_limits" SET
  "price_usd_cents" = CASE "cycle" WHEN 'monthly' THEN 4900 ELSE 49000 END,
  "mtr_min" = 5000,
  "mtr_max" = 50000,
  "events_limit" = 50000000,
  "sql_limit" = 2500,
  "retention_days" = 180,
  "audit_log_days" = 90
WHERE "tier" = 'indie';--> statement-breakpoint
UPDATE "billing_tier_limits" SET "mtr_min" = 250000 WHERE "tier" = 'enterprise';--> statement-breakpoint

-- 2. Studio inherits scale's bracket.
INSERT INTO "billing_tier_limits"
  ("tier", "cycle", "price_usd_cents", "stripe_price_id", "mtr_min", "mtr_max",
   "events_limit", "sql_limit", "retention_days", "audit_log_days")
VALUES
  ('studio', 'monthly', 39900, NULL, 50000, 250000, 250000000, NULL, 365, 365),
  ('studio', 'annual', 399000, NULL, 50000, 250000, 250000000, NULL, 365, 365)
ON CONFLICT ("tier", "cycle") DO NOTHING;--> statement-breakpoint

-- 3. Migrate any legacy subscriptions before deleting their limit rows
--    (pre-launch: expected 0 rows; UPDATEs are safety).
UPDATE "billing_subscriptions" SET "tier" = 'indie' WHERE "tier" = 'pro';--> statement-breakpoint
UPDATE "billing_subscriptions" SET "tier" = 'studio' WHERE "tier" = 'scale';--> statement-breakpoint
UPDATE "billing_subscriptions" SET "tier" = 'enterprise' WHERE "tier" = 'growth';--> statement-breakpoint

-- 4. Retire legacy reference rows.
DELETE FROM "billing_tier_limits" WHERE "tier" IN ('pro', 'scale', 'growth');
