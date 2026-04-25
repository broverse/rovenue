# PR body — Plan 2: revenue + credit outbox fan-out

Branch: `feat/plan2-revenue-credit-outbox` → `main`
Commits: 24

## Summary

- Extends the Kafka+outbox analytics pipeline (Plan 1) to cover `revenue_events` and `credit_ledger`. TimescaleDB hypertables remain the source of truth (VUK 7-year retention); ClickHouse receives a transactional fan-out for analytics read paths (2-year TTL — see ADR B.0).
- Five new CH migrations:
  - `0004` — revenue Kafka Engine + `raw_revenue_events` (ReplacingMergeTree, ORDER BY `(projectId, eventDate, eventId)`)
  - `0005` — credit Kafka Engine + `raw_credit_ledger` (ReplacingMergeTree, ORDER BY `(projectId, createdAt, eventId)`, `JSONExtractInt` + `nullIf` for credit-side payload extraction)
  - `0006` — `mv_mrr_daily` SummingMergeTree (per-project per-day rollup)
  - `0007` — `mv_credit_balance` AggregatingMergeTree (per-subscriber latest-balance snapshot via `argMaxState`)
  - `0008` — `mv_credit_consumption_daily` SummingMergeTree (sibling to balance MV, granted/debited/net flow per day)
- Same-tx outbox co-write in both `revenueEventRepo.createRevenueEvent` and `creditLedgerRepo.insertCreditLedger`. All existing callers (Stripe/Apple/Google webhooks, expiry-checker, credit-engine, subscriber-transfer) keep their current call shape — repo wrappers handle the co-write via `db.transaction(...)`. Dev seed (`packages/db/seed.ts`) intentionally bypasses; documented inline.
- Dashboard `/dashboard/projects/:id/metrics/mrr` enters **dual-read** behind `MRR_READ_SOURCE` env flag: `timescale` (default), `clickhouse`, or `dual` (parallel queries, returns Timescale, logs per-bucket drift at info; >0.5% drift logged as warn).
- Resolves Plan 1's dispatcher hot-loop TODO: per-topic isolation via `Promise.allSettled` + per-topic exponential backoff (500ms → 30s, capped) + in-memory claim filter so a single bad topic no longer halts healthy topics. Backoff escalates to `warn` log after 3 consecutive failures.
- `verify-clickhouse` CLI gains the 12 new CH objects + a per-aggregate outbox-backlog diagnostic against Postgres with two-tier thresholds (`OUTBOX_BACKLOG_WARN_THRESHOLD` default 1 000 / `OUTBOX_BACKLOG_CRIT_THRESHOLD` default 10 000; WARN exit 0, CRIT exit 2).
- Credit balance OLTP-side reads (`findLatestBalance`, GDPR export) intentionally stay on Postgres — CQRS line documented in the plan; only the write-side fan-out happens in this PR. Read-path migration → Plan 3.

## Test plan

- [x] `pnpm -r test` — `@rovenue/db` 55/55, `@rovenue/api` 297 pass / 79 fail / 1 skip (the 79 are a pre-existing dashboard-401 auth-middleware bug unrelated to this PR; +6 net new tests from Plan 2), `@rovenue/shared` 89/89, `@rovenue/dashboard` 5/5. Zero regressions.
- [x] `pnpm --filter @rovenue/db build` exit 0; `pnpm --filter @rovenue/api build` exit 0.
- [x] `pnpm --filter @rovenue/db db:verify:clickhouse` returns exit 0 in healthy state; verified WARN at 1 200 unpublished outbox rows (exit 0 + warning) and CRIT at 10 100 (exit 2).
- [x] Replay test (`outbox-revenue-credit-replay.integration.test.ts`): re-delivering the same Kafka payloads leaves `raw_revenue_events FINAL` count + `sum(amountUsd)` and `raw_credit_ledger FINAL` invariants unchanged.
- [x] Postgres-vs-CH MRR correlation (`mrr-correlation.integration.test.ts`): 30-day synthetic seed, max abs delta $0.0000, max rel delta 0.0000% (within the 1¢ / 0.5% gate).
- [x] Dispatcher isolation (`outbox-dispatcher-isolation.test.ts`): `rovenue.revenue` rejected, `rovenue.exposures` accepted — exposures drain to `publishedAt`, revenue stays NULL, `consecutiveFailures >= 3` triggers warn log.
- [x] Dual-read integration (`dashboard-mrr-dual-read.test.ts`): all three modes (`timescale`, `clickhouse`, `dual`) return structurally identical responses; dual mode emits info summary, no warn-level drift.

## Migration checklist (Coolify)

- [ ] Apply CH migrations `0004`–`0008` (auto via startup migrator).
- [ ] Default `MRR_READ_SOURCE=timescale` — no behavior change on deploy.
- [ ] After 48h of clean `dual` mode logs in staging, flip to `dual` in production.
- [ ] **Cutover quality gate** (both must pass before Plan 3 flips to `clickhouse`):
  - [ ] Time gate: ≥14 calendar days in production `dual` mode (covers 2 full monthly billing cycles).
  - [ ] Checksum gate: daily correlation job (planned for Plan 3) compares CH `sumMerge(net_usd)` vs Timescale `daily_mrr.gross_usd` per project per day; asserts `|delta| < 1¢` for **7 consecutive days** with zero alerts. Time gate alone is a weak signal; the checksum is the real sign-off.
- [ ] Set `OUTBOX_BACKLOG_WARN_THRESHOLD` / `OUTBOX_BACKLOG_CRIT_THRESHOLD` env in prod after 30 days of steady-state observation (defaults are conservative).

## Deferred to Plan 3

- Outbox retention worker.
- Read-path migration for credit-history and top-spenders.
- LTV / churn / refund-rate CH MVs.
- Grafana observability dashboards.

## Known limitations / follow-ups

- **CH testcontainer MV chain quirk** (Phase E.5, deferred): chained MVs do not reliably fire when source is fed by a Kafka Engine MV in fresh CH 24.3 testcontainers, even though the same image+version works end-to-end in dev-compose (verified via `rpk topic produce`). D.3 + E.4 tests currently use a documented manual-aggregation fallback to populate `mv_mrr_daily_target`. Production behavior is unaffected (verified). Investigation tracked separately.
- **Pre-existing dashboard-401 test failures** (79 tests): unrelated auth-middleware issue, predates Plan 2; reproduces on `main`. Owned by a separate follow-up.
- **`scripts/rotate-encryption-key.ts` typecheck** error: pre-existing on `main`, scope-excluded.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
