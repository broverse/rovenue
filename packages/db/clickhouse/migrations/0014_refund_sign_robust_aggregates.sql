-- 0014_refund_sign_robust_aggregates.sql
-- Refund sign convention bug. The source webhooks disagreed on the sign of
-- REFUND/CHARGEBACK `amountUsd`: Apple and Stripe stored it NEGATIVE while
-- Google (and the seed data the 0011 author empirically checked) stored it
-- POSITIVE. The canonical convention is POSITIVE — every read query nets via
-- `gross - sumIf(amountUsd, refund)`, the lifetime view casts to the unsigned
-- toUInt64, and a REFUND_REVERSED emits a positive REACTIVATION counterpart
-- that only cancels correctly when the refund is positive.
--
-- A negative refund therefore (a) overflowed `toUInt64(amountUsd * 100)` in
-- v_revenue_lifetime_subscriber — DB::Exception "Convert overflow" the instant
-- an Apple/Stripe refund landed — and (b) silently inflated net MRR / LTV
-- (gross - (negative) = gross + |refund|).
--
-- The webhooks are fixed to store positive (apple-webhook.ts / stripe-webhook.ts),
-- but rows already ingested with a negative sign remain. These views are made
-- sign-robust with abs() so the existing mixed-sign rows compute correctly with
-- no data backfill, and any future drift can never crash the unsigned cast.
-- Views are stateless -> DROP + re-CREATE. Supersedes the 0012 v_mrr_daily and
-- the 0013 v_revenue_lifetime_subscriber definitions.

-- Daily MRR — refund branches take abs() so a negative refund row contributes
-- its magnitude (refunds_usd stays positive; net subtracts the magnitude).
DROP VIEW IF EXISTS rovenue.v_mrr_daily;

CREATE VIEW IF NOT EXISTS rovenue.v_mrr_daily AS
SELECT
  projectId,
  toDate(eventDate) AS day,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))                                AS gross_usd,
  sumIf(abs(amountUsd), type IN ('REFUND', 'CHARGEBACK'))                               AS refunds_usd,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))
    - sumIf(abs(amountUsd), type IN ('REFUND', 'CHARGEBACK'))                           AS net_usd,
  count()                                                                              AS event_count,
  uniq(subscriberId)                                                                   AS active_subscribers
FROM rovenue.raw_revenue_events FINAL
GROUP BY projectId, day;

-- Per-subscriber lifetime revenue — Refund Shield hot path. abs() before the
-- unsigned cast prevents the Convert overflow; round() (from 0013) recovers
-- sub-cent precision; CHARGEBACK counts as a refund, matching v_mrr_daily.
-- Dedup via GROUP BY eventId (NOT FINAL) so the proj_by_subscriber projection
-- serves the per-(projectId, subscriberId) lookup as an index seek.
DROP VIEW IF EXISTS rovenue.v_revenue_lifetime_subscriber;

CREATE VIEW IF NOT EXISTS rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION', 'CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(amt_cents, type IN ('REFUND', 'CHARGEBACK'))                                                      AS lifetime_dollars_refunded_cents
FROM
(
  SELECT
    eventId,
    any(projectId)                              AS projectId,
    any(subscriberId)                           AS subscriberId,
    any(type)                                   AS type,
    any(toUInt64(round(abs(amountUsd) * 100)))  AS amt_cents
  FROM rovenue.raw_revenue_events
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;
