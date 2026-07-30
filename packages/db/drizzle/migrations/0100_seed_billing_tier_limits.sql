-- 0100_seed_billing_tier_limits.sql
--
-- The billing ladder is reference data, and no migration ever created it.
-- 0041 created the table, 0084 retyped a column, and 0085 UPDATEd rows that
-- it assumed already existed and INSERTed only the two `studio` rows. The
-- free / indie / enterprise rows came from `pnpm db:seed`, which is a
-- developer convenience that no deployment runs — the compose `migrate`
-- service applies migrations and nothing else.
--
-- So every database built purely from migrations ends up with 2 of the 8
-- rows: no free tier at all. That was invisible while the only databases
-- anyone had were long-lived ones carrying rows from an older seed run, and
-- it surfaced the moment a database could be built from scratch.
--
-- Values match packages/db/seed.ts's TIER_LIMITS, which is what
-- billing-tier-limits-seed.test.ts asserts against. `stripe_price_id` is
-- deliberately NULL: the live price id is environment-specific (the cloud
-- deployment injects STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID) and does not
-- belong hard-coded in the schema history.
--
-- ON CONFLICT DO NOTHING on the (tier, cycle) primary key, so this is inert
-- on every existing database — including ones whose values were later tuned
-- by hand. It seeds what is missing and overwrites nothing.

INSERT INTO "billing_tier_limits"
  ("tier", "cycle", "price_usd_cents", "stripe_price_id", "mtr_min", "mtr_max",
   "events_limit", "sql_limit", "retention_days", "audit_log_days")
VALUES
  ('free',       'monthly',      0, NULL,      0,   5000,   5000000,  100,   30,    7),
  ('free',       'annual',       0, NULL,      0,   5000,   5000000,  100,   30,    7),
  ('indie',      'monthly',   4900, NULL,   5000,  50000,  50000000, 2500,  180,   90),
  ('indie',      'annual',   49000, NULL,   5000,  50000,  50000000, 2500,  180,   90),
  ('studio',     'monthly',  39900, NULL,  50000, 250000, 250000000, NULL,  365,  365),
  ('studio',     'annual',  399000, NULL,  50000, 250000, 250000000, NULL,  365,  365),
  ('enterprise', 'monthly',      0, NULL, 250000,   NULL,      NULL, NULL, 1825, 1825),
  ('enterprise', 'annual',       0, NULL, 250000,   NULL,      NULL, NULL, 1825, 1825)
ON CONFLICT ("tier", "cycle") DO NOTHING;
