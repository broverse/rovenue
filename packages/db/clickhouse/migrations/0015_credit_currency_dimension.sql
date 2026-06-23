-- 0015_credit_currency_dimension.sql
-- Add a per-currency dimension to the credit analytics pipeline.
-- The outbox payload (credit.ledger.appended) already carries currencyId
-- (Plan 1). Here we: add currencyId to the raw ReplacingMergeTree table,
-- recreate the Kafka->raw MV to extract it, and recreate the query-time
-- views with currencyId in their GROUP BY. The views still read
-- raw_credit_ledger FINAL so at-least-once duplicate deliveries (same eventId)
-- collapse before aggregation — no incremental rollup is reintroduced.

ALTER TABLE rovenue.raw_credit_ledger
  ADD COLUMN IF NOT EXISTS currencyId String AFTER subscriberId;

-- An MV's SELECT cannot be ALTERed; drop and recreate to add the extraction.
--
-- ⚠️ LIVE-CH HAZARD (see MEMORY: clickhouse_mv_recreate_kafka_gap): mv_credit_to_raw
-- ingests from the Kafka Engine table rovenue.credit_queue (consumer group
-- rovenue-ch-credit). On an empty topic — a FRESH install applying migrations in
-- order — this DROP→CREATE is safe. But on a LIVE system with credit traffic, the
-- Kafka offset advances during the gap with no MV attached, so every credit event
-- consumed between DROP and CREATE is permanently lost from raw_credit_ledger.
-- If this migration (or any future recreation of mv_credit_to_raw) is ever applied
-- to a live ClickHouse: FIRST pause the rovenue-ch-credit consumer group (DETACH the
-- credit_queue table or stop ingestion), then apply, then backfill raw_credit_ledger
-- from Postgres credit_ledger for the gap window before resuming. 0016 leaves its
-- ingestion MV untouched for exactly this reason; this one had to recreate it to add
-- the currencyId column, so the pause-and-backfill discipline is mandatory on live.
DROP VIEW IF EXISTS rovenue.mv_credit_to_raw;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_to_raw
TO rovenue.raw_credit_ledger AS
SELECT
  eventId,
  JSONExtractString(payload, 'creditLedgerId')                              AS creditLedgerId,
  JSONExtractString(payload, 'projectId')                                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                                AS subscriberId,
  JSONExtractString(payload, 'currencyId')                                  AS currencyId,
  JSONExtractString(payload, 'type')                                        AS type,
  JSONExtractInt(payload, 'amount')                                         AS amount,
  JSONExtractInt(payload, 'balance')                                        AS balance,
  nullIf(JSONExtractString(payload, 'referenceType'), '')                   AS referenceType,
  nullIf(JSONExtractString(payload, 'referenceId'),   '')                   AS referenceId,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'createdAt'), 3
  )                                                                         AS createdAt,
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.credit_queue;

-- Daily per-currency credit flow — query-time over deduped raw.
DROP VIEW IF EXISTS rovenue.v_credit_consumption_daily;

CREATE VIEW IF NOT EXISTS rovenue.v_credit_consumption_daily AS
SELECT
  projectId,
  currencyId,
  toDate(createdAt) AS day,
  sumIf(amount, amount > 0)   AS granted_credits,
  sumIf(-amount, amount < 0)  AS debited_credits,
  sum(amount)                 AS net_flow,
  count()                     AS event_count,
  uniq(subscriberId)          AS active_subscribers
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, currencyId, day;

-- Per-(subscriber, currency) balance snapshot — analytics read only.
DROP VIEW IF EXISTS rovenue.v_credit_balance;

CREATE VIEW IF NOT EXISTS rovenue.v_credit_balance AS
SELECT
  projectId,
  subscriberId,
  currencyId,
  argMax(balance, createdAt)  AS latest_balance,
  sumIf(amount, amount > 0)   AS total_granted,
  sumIf(-amount, amount < 0)  AS total_debited,
  max(createdAt)              AS last_activity_at
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, subscriberId, currencyId;
