-- 0092_apple_pay_domain.sql
--
-- Task 10 (funnel on-page payment): Apple Pay only appears in the funnel
-- paywall's payment sheet if the domain SERVING the page is registered as
-- a payment method domain on the connected account taking the charge.
-- Registration happens on connect; these two columns record what came
-- back.
--
-- `apple_pay_domain_status` deliberately stores Stripe's OWN verdict for
-- Apple Pay on that domain, not "did we make an API call":
--
--   unregistered  nothing has been attempted for this connection
--   active        Stripe reports apple_pay.status = "active" -> the wallet
--                 will actually be offered
--   inactive      the domain object exists but Stripe reports apple_pay
--                 as inactive (usually the domain is not serving Stripe's
--                 verification file yet). Registered, but Apple Pay will
--                 NOT appear.
--   failed        the Stripe call itself errored
--
-- The `inactive` value is the point of the column. Recording "registered"
-- on a 200 would claim Apple Pay works on exactly the accounts where it
-- silently does not.

ALTER TABLE "project_stripe_connections"
  ADD COLUMN IF NOT EXISTS "apple_pay_domain_status" text NOT NULL DEFAULT 'unregistered';
ALTER TABLE "project_stripe_connections"
  ADD COLUMN IF NOT EXISTS "apple_pay_domain_checked_at" timestamptz;
