-- 0024_lifetime_revenue_one_time.sql
-- NON_RENEWING_PURCHASE joins the purchased bucket: it is money the
-- subscriber actually paid, so it belongs in lifetime value. Without this
-- the type introduced on 2026-09-04 would be recorded and then silently
-- dropped from every LTV rollup.
--
-- A query-time view, so this redefinition rewrites no data. Definition
-- carried over verbatim from 0014_refund_sign_robust_aggregates.sql
-- (the latest redefinition of this view — checked 0011/0012/0013/0016,
-- none of which redefine it after 0014), with only the purchased-bucket
-- IN list changed.
--
-- Statements must not be comment-prefixed on the same line as the
-- statement itself — the migrate splitter has dropped such statements
-- before ("applied but objects missing").
DROP VIEW IF EXISTS rovenue.v_revenue_lifetime_subscriber;

CREATE VIEW IF NOT EXISTS rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION', 'CREDIT_PURCHASE', 'NON_RENEWING_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(amt_cents, type IN ('REFUND', 'CHARGEBACK'))                                                                               AS lifetime_dollars_refunded_cents
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
