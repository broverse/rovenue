/*
 * 0011_revenue_lifetime_subscriber.sql
 *
 * Per-subscriber lifetime $ purchased and $ refunded, in cents.
 * Feeds Refund Shield's aggregate-signals service (Task 12),
 * which the responder worker (Task 14) calls when answering an
 * Apple consumption-request webhook (Task 10/11). Keeping a
 * pre-aggregated per-subscriber merged row lets that hot path
 * resolve "lifetime $ purchased / refunded" in an O(1) lookup
 * instead of scanning raw_revenue_events.
 *
 * Source: rovenue.raw_revenue_events (see 0004). That table
 * stores amounts as Decimal(12,4) USD in `amountUsd`, and uses
 * `type` (not `eventType`) as the discriminator. Refund Shield
 * needs cents, so we multiply by 100 and cast to UInt64 here -
 * the SummingMergeTree merge path requires fixed-width integer
 * sums. Decimal(12,4) USD has 4 fractional digits, so
 * toUInt64(amountUsd * 100) loses sub-cent precision (e.g.
 * $5.4999 -> 549 cents). That's acceptable for the Apple
 * consumption-info bucketing in Task 7, which only cares about
 * coarse dollar bands.
 *
 * REFUND sign convention: verified empirically on the live dev
 * database (2026-05-28) that REFUND rows are stored as POSITIVE
 * amountUsd values (e.g. 5.00, not -5.00) - the Postgres
 * revenue-events repository inserts the magnitude, not a signed
 * delta. So a plain sum() keeps lifetime_dollars_refunded_cents
 * as a positive magnitude, matching the "refunded dollars"
 * semantics the responder worker expects. No abs() / negation
 * needed.
 *
 * Purchased bucket includes: INITIAL, RENEWAL, TRIAL_CONVERSION,
 * CREDIT_PURCHASE. CANCELLATION rows are state changes with
 * amount=0 and are excluded from both buckets.
 *
 * Engine choice: SummingMergeTree with plain UInt64 sum columns.
 * Matches the precedent in 0006_mv_mrr_daily.sql,
 * 0008_mv_credit_consumption_daily.sql, and the just-merged
 * 0010_sdk_sessions_daily.sql - this codebase only reaches for
 * AggregateFunction(...) state when distinct-counting (uniqState)
 * is required. Lifetime sums don't need HLL, so plain summed
 * columns keep merges cheap and reads trivial (no *Merge() needed
 * on the read path).
 *
 * ORDER BY (projectId, subscriberId) so the responder worker's
 * per-subscriber lookup hits the primary index directly. No
 * PARTITION / TTL: this is a lifetime per-subscriber rollup, not
 * a time series - we want every historical revenue event to keep
 * contributing to the merged row for as long as the subscriber
 * exists.
 *
 * Header uses block-comment syntax intentionally: the migrator's
 * statement splitter (split on /;\s*$/m) drops any chunk whose
 * trimmed text starts with "--", so a leading line-comment block
 * would silently swallow the first DDL statement.
 */

CREATE TABLE IF NOT EXISTS rovenue.revenue_lifetime_subscriber_tbl
(
  projectId                        String,
  subscriberId                     String,
  lifetime_dollars_purchased_cents UInt64,
  lifetime_dollars_refunded_cents  UInt64
)
ENGINE = SummingMergeTree
ORDER BY (projectId, subscriberId);

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.revenue_lifetime_subscriber_mv
TO rovenue.revenue_lifetime_subscriber_tbl AS
SELECT
  projectId,
  subscriberId,
  sumIf(toUInt64(amountUsd * 100), type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(toUInt64(amountUsd * 100), type = 'REFUND')                                                      AS lifetime_dollars_refunded_cents
FROM rovenue.raw_revenue_events
GROUP BY projectId, subscriberId;
