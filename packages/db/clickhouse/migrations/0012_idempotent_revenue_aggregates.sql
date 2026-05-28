-- 0012_idempotent_revenue_aggregates.sql
-- Replace the additive money rollups (SummingMergeTree / AggregatingMergeTree
-- sum-state) with query-time views over the deduped raw ReplacingMergeTree
-- tables, so an at-least-once duplicate delivery (same eventId) is collapsed
-- BEFORE it is ever summed. The Kafka->raw ingestion MVs (0004 mv_revenue_to_raw,
-- 0005 mv_credit_to_raw) are already idempotent and are left untouched.
-- See docs/superpowers/specs/2026-05-29-idempotent-revenue-aggregates-design.md

-- Drop the broken rollups (materialized view first, then its target table).
DROP VIEW IF EXISTS rovenue.mv_mrr_daily;
DROP TABLE IF EXISTS rovenue.mv_mrr_daily_target;

DROP VIEW IF EXISTS rovenue.mv_credit_consumption_daily;
DROP TABLE IF EXISTS rovenue.mv_credit_consumption_daily_target;

DROP VIEW IF EXISTS rovenue.mv_credit_balance;
DROP TABLE IF EXISTS rovenue.mv_credit_balance_target;

DROP VIEW IF EXISTS rovenue.revenue_lifetime_subscriber_mv;
DROP TABLE IF EXISTS rovenue.revenue_lifetime_subscriber_tbl;

-- Daily MRR — query-time over deduped raw. FINAL collapses duplicate eventIds
-- before summation; uniq() replaces the former uniqState/uniqMerge pair.
CREATE VIEW IF NOT EXISTS rovenue.v_mrr_daily AS
SELECT
  projectId,
  toDate(eventDate) AS day,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))                                AS gross_usd,
  sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))                                    AS refunds_usd,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))
    - sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))                                AS net_usd,
  count()                                                                              AS event_count,
  uniq(subscriberId)                                                                   AS active_subscribers
FROM rovenue.raw_revenue_events FINAL
GROUP BY projectId, day;

-- Daily credit flow — query-time over deduped raw.
CREATE VIEW IF NOT EXISTS rovenue.v_credit_consumption_daily AS
SELECT
  projectId,
  toDate(createdAt) AS day,
  sumIf(amount, amount > 0)   AS granted_credits,
  sumIf(-amount, amount < 0)  AS debited_credits,
  sum(amount)                 AS net_flow,
  count()                     AS event_count,
  uniq(subscriberId)          AS active_subscribers
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, day;

-- Per-subscriber credit balance snapshot — analytics read only (the
-- authoritative entitlement balance is served from Postgres, not this view).
CREATE VIEW IF NOT EXISTS rovenue.v_credit_balance AS
SELECT
  projectId,
  subscriberId,
  argMax(balance, createdAt)  AS latest_balance,
  sumIf(amount, amount > 0)   AS total_granted,
  sumIf(-amount, amount < 0)  AS total_debited,
  max(createdAt)              AS last_activity_at
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, subscriberId;

-- Per-subscriber lifetime revenue — Refund Shield hot path. Dedup via
-- GROUP BY eventId (NOT FINAL) so the proj_by_subscriber projection can serve
-- the per-(projectId, subscriberId) lookup as an index seek. Business fields
-- for a given eventId are immutable (Postgres revenue_events is append-only),
-- so any() of the deduped row is safe.
CREATE VIEW IF NOT EXISTS rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(amt_cents, type = 'REFUND')                                                       AS lifetime_dollars_refunded_cents
FROM
(
  SELECT
    eventId,
    any(projectId)                  AS projectId,
    any(subscriberId)               AS subscriberId,
    any(type)                       AS type,
    any(toUInt64(amountUsd * 100))  AS amt_cents
  FROM rovenue.raw_revenue_events
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;

-- Projection so the lifetime per-subscriber lookup is an index seek rather than
-- a project-wide scan. Applies to all future inserts; no MATERIALIZE needed on
-- an empty table.
ALTER TABLE rovenue.raw_revenue_events
  ADD PROJECTION IF NOT EXISTS proj_by_subscriber
  (SELECT * ORDER BY (projectId, subscriberId));
