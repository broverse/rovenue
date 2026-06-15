-- 0013_lifetime_revenue_rounding_consistency.sql
-- Two issues in v_revenue_lifetime_subscriber (0012):
--   1. toUInt64(amountUsd * 100) TRUNCATES toward zero. amountUsd is Decimal(12,4)
--      (not Float), so whole-cent prices like $19.99 are already exact (1999) and
--      were never mis-counted; the truncation only loses value on sub-cent (3rd/4th
--      decimal) amounts, e.g. $5.4999 -> 549 instead of 550. round() before the
--      UInt64 cast makes those round-half-to-even instead of truncating.
--   2. The view counted only type = 'REFUND' as a refund and omitted CHARGEBACK
--      (and REACTIVATION on the purchase side), while the sibling v_mrr_daily
--      (0012) correctly treats CHARGEBACK as a refund. That made LTV / Refund
--      Shield disagree with MRR and dropped chargebacks from net lifetime value.
-- Views are stateless, so DROP + re-CREATE. The per-eventId GROUP BY dedup
-- (NOT FINAL) is intentional so the proj_by_subscriber projection serves the
-- per-(projectId, subscriberId) lookup as an index seek — preserved verbatim.

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
    any(projectId)                         AS projectId,
    any(subscriberId)                      AS subscriberId,
    any(type)                              AS type,
    any(toUInt64(round(amountUsd * 100)))  AS amt_cents
  FROM rovenue.raw_revenue_events
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;
