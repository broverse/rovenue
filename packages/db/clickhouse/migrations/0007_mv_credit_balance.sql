-- 0007_mv_credit_balance.sql
-- Per-subscriber latest credit balance (AggregatingMergeTree).
-- argMax(balance, createdAt) returns the balance of the most
-- recent ledger row; the MV pre-aggregates partial states so
-- read-side queries only need a FINAL + -Merge combinator.
--
-- This is snapshot state, not a running log. Running-log (consumption
-- rate) lives in the sibling MV mv_credit_consumption_daily (Task B.5).

CREATE TABLE IF NOT EXISTS rovenue.mv_credit_balance_target
(
  projectId           String,
  subscriberId        String,
  latestBalanceState  AggregateFunction(argMax, Int64, DateTime64(3)),
  totalGrantedState   AggregateFunction(sum, Int64),
  totalDebitedState   AggregateFunction(sum, Int64),
  lastActivityAt      SimpleAggregateFunction(max, DateTime64(3))
)
ENGINE = AggregatingMergeTree
ORDER BY (projectId, subscriberId);

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_balance
TO rovenue.mv_credit_balance_target AS
SELECT
  projectId,
  subscriberId,
  argMaxState(balance, createdAt)                    AS latestBalanceState,
  sumState(if(amount > 0, amount, toInt64(0)))       AS totalGrantedState,
  sumState(if(amount < 0, -amount, toInt64(0)))      AS totalDebitedState,
  max(createdAt)                                     AS lastActivityAt
FROM rovenue.raw_credit_ledger
GROUP BY projectId, subscriberId;
