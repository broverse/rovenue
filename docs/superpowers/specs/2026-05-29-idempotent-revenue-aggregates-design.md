# Idempotent Revenue Aggregates — Design

**Date:** 2026-05-29
**Status:** Approved (design phase)
**Related:** `docs/architecture/outbox-dispatcher.md`, memory `outbox_revenue_double_count_risk`, `clickhouse_summing_aggregatefunction`

## Problem

The transactional outbox dispatcher is **at-least-once** (the `claimBatch` tx commits before `producer.send`, and `markPublished` is a separate post-ack tx — a crash in between re-publishes; additionally `runOutboxDispatcher()` runs in every API instance). At-least-once is inherent to the outbox pattern and cannot be made exactly-once without distributed transactions.

The raw ClickHouse tables tolerate this: `raw_revenue_events` and `raw_credit_ledger` are `ReplacingMergeTree` keyed on `eventId`, so a duplicate delivery collapses on read-with-dedup. **But** the additive money rollups are fed by materialized views that fire per inserted block *before* the Replacing merge, so a duplicate `eventId` double-counts their summed columns, and `FINAL` on a Summing/Aggregating engine cannot undo it (it merges by sort key, not by `eventId`).

Affected aggregates (verified against migrations `0006`/`0007`/`0008`/`0011`):

| Object | Engine | Double-counted columns | Safe columns |
|---|---|---|---|
| `mv_mrr_daily_target` | SummingMergeTree | `gross_usd`, `refunds_usd`, `net_usd`, `event_count` | `subscribersHll` (`uniqState`) |
| `mv_credit_consumption_daily_target` | SummingMergeTree | `granted_credits`, `debited_credits`, `net_flow`, `event_count` | `subscribersHll` (`uniqState`) |
| `mv_credit_balance_target` | AggregatingMergeTree | `totalGrantedState`, `totalDebitedState` (`sumState`) | `latestBalanceState` (`argMaxState`), `lastActivityAt` |
| `revenue_lifetime_subscriber_tbl` | SummingMergeTree | `lifetime_dollars_purchased_cents`, `lifetime_dollars_refunded_cents` | — |

`revenue_lifetime_subscriber_tbl` feeds Refund Shield's Apple consumption-request responder via `services/refund-shield/aggregate-signals.ts` (plain `sum(...)`), so duplicates can skew automated refund decisions.

**No production data exists yet**, so we can drop and rebuild ClickHouse objects freely — no backfill.

## Approach (chosen: A — make ClickHouse idempotent at the read/aggregate layer)

The two raw `ReplacingMergeTree` tables are the **single source of truth**. Every money figure derives from them through a deduplication step, so a duplicate `eventId` is collapsed *before* it is ever summed. The Kafka→raw ingestion MVs (`0004` `mv_revenue_to_raw`, `0005` credit equivalent) are **left untouched** — they are already idempotent (Replacing on `eventId`). We replace only the four additive rollups.

The previously-`uniqState`/`argMaxState` columns become plain `uniq`/`argMax` computed at read time — these were already correct, and computing them live is simpler.

### Two deduplication mechanisms

ClickHouse generally **does not use a `PROJECTION` when a query requests `FINAL`** (FINAL forces reading and merging base-table parts). This drives the choice of dedup mechanism per view:

1. **`FINAL` over the raw table** — used by the **date-bounded time-series** views (`mrr_daily`, `credit_consumption_daily`) and the per-subscriber `credit_balance` view. These are filtered by `projectId` (+ day range), so `FINAL` operates over a bounded set of partitions; no projection is needed.

2. **Explicit `GROUP BY eventId` dedup** (no `FINAL`) — used by the **per-subscriber lifetime** view (Refund Shield hot path). Because the business fields for a given `eventId` are immutable (Postgres `revenue_events` is append-only), deduping with `... GROUP BY eventId` and `any()` of the stable fields yields exactly one row per event without `FINAL`. Because this avoids `FINAL`, ClickHouse **can** use a `(projectId, subscriberId)` projection on `raw_revenue_events` to serve the responder's per-subscriber filter as an index seek, preserving the O(1)-ish hot-path latency the dedicated table previously gave.

### Components

**New migration(s) (`0012`+):** for each of the four rollups, `DROP` the old materialized view + target table, then `CREATE` the replacement. (Order: drop MV first, then target table.)

1. **`v_mrr_daily`** (regular `VIEW`):
   ```sql
   SELECT projectId, toDate(eventDate) AS day,
     sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK'))                                   AS gross_usd,
     sumIf(amountUsd, type IN ('REFUND','CHARGEBACK'))                                        AS refunds_usd,
     sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')) - sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')) AS net_usd,
     count()                                                                                  AS event_count,
     uniq(subscriberId)                                                                       AS active_subscribers
   FROM rovenue.raw_revenue_events FINAL
   GROUP BY projectId, day
   ```

2. **`v_credit_consumption_daily`** (regular `VIEW`): analogous, over `raw_credit_ledger FINAL`, `GROUP BY projectId, toDate(createdAt)`, with `sumIf(amount, amount>0)` / `sumIf(-amount, amount<0)` / `sum(amount)` / `count()` / `uniq(subscriberId)`.

3. **`v_credit_balance`** (regular `VIEW`): over `raw_credit_ledger FINAL`, `GROUP BY projectId, subscriberId`, with `argMax(balance, createdAt) AS latest_balance`, `sumIf(amount, amount>0) AS total_granted`, `sumIf(-amount, amount<0) AS total_debited`, `max(createdAt) AS last_activity_at`. **No projection:** this view serves dashboard *analytics* reads (aggregate/listing), not a per-subscriber hot path — the authoritative entitlement balance is served from Postgres (`credit_ledger` latest row), not ClickHouse — so a `projectId`-bounded `FINAL` scan is acceptable. (If a single-subscriber CH balance lookup later proves hot, add a `(projectId, subscriberId)` projection + switch that path to `GROUP BY eventId` dedup, same pattern as the lifetime view.)

4. **`v_revenue_lifetime_subscriber`** (regular `VIEW`, projection-friendly dedup — **no `FINAL`**):
   ```sql
   SELECT projectId, subscriberId,
     sumIf(amt_cents, type IN ('INITIAL','RENEWAL','TRIAL_CONVERSION','CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
     sumIf(amt_cents, type = 'REFUND')                                                    AS lifetime_dollars_refunded_cents
   FROM (
     SELECT eventId,
            any(projectId)    AS projectId,
            any(subscriberId) AS subscriberId,
            any(type)         AS type,
            any(toUInt64(amountUsd * 100)) AS amt_cents
     FROM rovenue.raw_revenue_events
     GROUP BY eventId
   )
   GROUP BY projectId, subscriberId
   ```
   The responder query in `aggregate-signals.ts` adds `WHERE projectId = … AND subscriberId = …`, pushed into the inner scan.

**New projection on `raw_revenue_events`** (migration `0012`+):
```sql
ALTER TABLE rovenue.raw_revenue_events
  ADD PROJECTION proj_by_subscriber (
    SELECT * ORDER BY (projectId, subscriberId)
  );
-- (no MATERIALIZE needed pre-data; it applies to all future inserts)
```
Serves the per-subscriber lifetime lookup as an index seek (only because that path avoids `FINAL`).

**Read-path updates (7 files):** repoint to the new views and drop now-obsolete `FINAL` / `*Merge` combinators:
- `apps/api/src/services/metrics/mrr.ts` (currently `FROM mv_mrr_daily_target FINAL` + `uniqMerge`)
- `apps/api/src/services/metrics/credits.ts`
- `apps/api/src/services/metrics/overview.ts`
- `apps/api/src/routes/dashboard/metrics.ts`
- `apps/api/src/routes/dashboard/leaderboards.ts`
- `apps/api/src/services/refund-shield/aggregate-signals.ts`
- `apps/api/src/services/notifications/digest-kpi.ts`

Each task in the plan updates one read path against its new view, preserving the response shape the dashboard/responder already expects (column aliases chosen above match where practical; rename references where they differ).

**Verification:**
- Update `packages/db/scripts/verify-clickhouse.ts` parity checks to reference the new views.
- New idempotency regression test (ClickHouse integration): insert the **same `eventId` twice** into `raw_revenue_events` / `raw_credit_ledger`, then assert each view (`v_mrr_daily`, `v_revenue_lifetime_subscriber`, `v_credit_consumption_daily`, `v_credit_balance`) counts the event **once** (money totals not doubled). This is the regression that the old SummingMergeTree rollups would fail.

### Data flow

`revenue_events` (Postgres, append-only) → outbox → Kafka `rovenue.revenue` → `revenue_queue` (Kafka Engine) → `mv_revenue_to_raw` → `raw_revenue_events` (ReplacingMergeTree, dedup on `eventId`) → **query-time views** (`FINAL` or `GROUP BY eventId`) → API read paths. Duplicate delivery adds a redundant raw row that the dedup step collapses; no aggregate sees it twice.

### Error handling / edge cases

- **Duplicate `eventId`, identical fields:** collapsed by `FINAL` / `GROUP BY eventId`. Safe.
- **Duplicate `eventId`, differing `_version`:** `FINAL` keeps highest `_version`; `GROUP BY eventId` + `any()` is acceptable because business fields are immutable per `eventId`.
- **REFUND sign:** REFUND rows store positive `amountUsd` (verified 2026-05-28, per `0011` header) — plain `sum`/`sumIf` keeps "refunded dollars" as a positive magnitude. Preserved.
- **Sub-cent precision:** lifetime cents still use `toUInt64(amountUsd*100)` — unchanged from `0011`.

### Out of scope

- The **single-leader dispatcher gate** (option C) — deferred; can be added later as operational hygiene. The CH idempotency fix is what makes revenue *correct*; the gate only reduces duplicate *rate*.
- Postgres-side changes — none needed.
- Reintroducing pre-aggregated rollup *tables* for read performance — not needed at current scale; if a time-series view later gets slow, a refreshable-MV rollup over deduped raw can be added (CH 24.3 refreshable MVs are experimental).

## Performance trade-off (accepted)

Time-series views run `FINAL` + `GROUP BY` over the relevant partitions per query instead of reading a pre-summed rollup. Acceptable at self-hosted scale; date filters bound the scan. The per-subscriber lifetime hot path keeps index-seek latency via the `(projectId, subscriberId)` projection + `GROUP BY eventId` (no `FINAL`). Documented so a future scale issue has a clear next step (refreshable-MV rollup).
