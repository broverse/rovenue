-- 0102_purchases_status_expiresDate_idx.sql
--
-- The expiry sweeper (apps/api expiry-checker) no longer bounds its scan
-- with a 24h lookback window — that window silently skipped any purchase
-- that missed its sweep (worker down for longer than a day, or a
-- per-candidate error on an earlier run), leaving it ACTIVE forever. The
-- sweep is now bounded by status instead:
--
--   "status" IN (sweepable, non-terminal) AND "expiresDate" <= now()
--
-- The existing purchases_expiresDate_idx (full, expiresDate only) would
-- walk every historical EXPIRED row for that predicate. This partial
-- index carries only rows in a sweepable status — rows leave it the
-- moment the sweeper (or a webhook) moves them to a terminal status, so
-- it stays small in steady state and the sweep is a cheap range scan.
--
-- Status list mirrors EXPIRY_SWEEP_STATUSES in the expiry-checker worker
-- and the partial index declared on `purchases` in drizzle/schema.ts.

CREATE INDEX "purchases_status_expiresDate_idx"
  ON "purchases" ("status", "expiresDate")
  WHERE "status" IN ('TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'PAUSED');
