-- 0090_funnel_purchase_payment.sql
--
-- Task 6 (funnel on-page payment): funnel_purchases needs a place to
-- record the Stripe PaymentIntent created for a one-time price (the
-- subscription path already had stripe_subscription_id) and the
-- subscriber a paid session resolves to once Task 7 links the two.
-- Both are added now rather than deferred to Task 10 because Tasks
-- 6-7 write them.

ALTER TABLE "funnel_purchases"
  ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text;
ALTER TABLE "funnel_purchases"
  ADD COLUMN IF NOT EXISTS "subscriber_id" text;
