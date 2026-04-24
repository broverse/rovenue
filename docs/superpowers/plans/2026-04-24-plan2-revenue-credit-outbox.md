# Plan 2 — Revenue + Credit Outbox Fan-out

Status: draft
Created: 2026-04-24
Branch: `plan/revenue-credit-outbox`
Follows: [Plan 1 — Kafka Analytics Foundation](./2026-04-24-kafka-analytics-foundation.md)
Spec: `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md` §13 (Opsiyon Y) + §14 (Kafka pivot)

---

## Context

Plan 1 delivered the EXPOSURE end-to-end pipeline:

```
experiment route  →  outbox_events (aggregateType=EXPOSURE)
                  →  outbox-dispatcher  →  rovenue.exposures (Redpanda)
                  →  exposures_queue    (CH Kafka Engine table)
                  →  mv_exposures_to_raw
                  →  raw_exposures      (ReplacingMergeTree on eventId)
                  →  mv_experiment_daily / _target (SummingMergeTree)
```

All infra the plan needs already exists and is production-proven on `feat/clickhouse-analytics`:

| Component                                       | State after Plan 1                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `outbox_events` table + `aggregate_type` enum   | `EXPOSURE`, `REVENUE_EVENT`, `CREDIT_LEDGER` already enumerated (migration 0013) |
| `outboxRepo.insert` / `.claimBatch` / `.markPublished` | Aggregate-agnostic — takes `aggregateType` as a parameter                   |
| `outbox-dispatcher` worker                      | `AGGREGATE_TO_TOPIC` already maps `REVENUE_EVENT → rovenue.revenue`, `CREDIT_LEDGER → rovenue.credit` |
| `assertTopic` / Kafka producer bootstrap        | Iterates every value of the map — new topics auto-created at worker start   |
| CH `_migrations` table + migrator script        | Applies `clickhouse/migrations/*.sql` in order                              |
| `verify-clickhouse` CLI                         | Schema-drift check, easy to extend with new table/engine entries            |

**Plan 1 left two pending items that Plan 2 must address or consciously defer:**

1. `outbox-dispatcher` TODO — quoted verbatim in Phase E.1 below. Plan 1 left a loop where a single poisoned topic or payload blocks the whole batch (re-claim every 500 ms forever). Plan 2 triples the number of topics, so leaving this unfixed would make a bad revenue payload halt exposures too. **We fix it here.**
2. Outbox retention / cleanup worker — still deferred. Plan 2 adds ~2 orders of magnitude more outbox rows (every purchase, every credit mutation), so we add a row-count alert stub but **do not** ship the cleanup worker (still Plan 3).

---

## Goals

1. Transactionally fan out `revenue_events` inserts to ClickHouse, producing a **daily MRR/ARR rollup** that is eventually consistent with the existing TimescaleDB `daily_mrr` continuous aggregate (tolerance: ±0.5 % at any 24 h boundary).
2. Transactionally fan out `credit_ledger` rows to ClickHouse, producing a **per-subscriber running-balance snapshot** usable for consumption-rate / top-spender analytics.
3. Migrate the dashboard MRR endpoint to a **dual-read** mode behind a feature flag, with parallel CH + Timescale queries and a drift log — no hard cutover.
4. Preserve Plan 1 semantics: the EXPOSURE path is untouched; no changes to `raw_exposures`, `mv_experiment_daily`, or their materialized views.

### Non-goals (deferred to Plan 3)

- Retention / TTL cleanup of `outbox_events` rows.
- Dashboard UI changes beyond the MRR endpoint swap (no new charts, no new pages).
- Observability dashboards beyond the existing `verify-clickhouse` CLI (Grafana boards stay deferred).
- Alerting beyond a CLI-based consumer-lag + outbox-backlog stub.
- LTV / churn / refund-rate MVs — the DDL is sketched in the "Future CH aggregates" appendix but not migrated in this plan.
- Credit balance-check read path migration (stays OLTP for transactional consistency with `creditLedger.balance`).
- Horizontal scale of the outbox dispatcher.

---

## Source of truth: unchanged

The spec's §13 Option Y decision matrix remains authoritative:

| Table               | Source of truth (OLTP / compliance)     | Analytics fan-out (this plan)                                                                           |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `revenue_events`    | Postgres hypertable (VUK 7-year retention) | `raw_revenue_events` ReplacingMergeTree + `mv_mrr_daily_target` SummingMergeTree                         |
| `credit_ledger`     | Postgres hypertable (append-only ledger; balance invariants) | `raw_credit_ledger` ReplacingMergeTree + `mv_credit_balance_target` AggregatingMergeTree                  |
| `outbox_events`     | Postgres — plumbing only                | n/a                                                                                                     |

**Hard rule:** every analytics-bound OLTP write lands in `revenue_events` or `credit_ledger` *first*, in the same transaction as the outbox row. ClickHouse is never written to directly by application code. Timescale stays; this plan adds fan-out, it does not remove a path.

### CQRS split for credits (explicit, for reviewer scrutiny)

- **Stays OLTP (Postgres)**: balance check during consumption (`findLatestBalance`), GDPR export, subscriber-transfer balance handoff. These require strict consistency with the running `balance` column; CH's eventual consistency window (seconds) would introduce double-spend windows.
- **Migrates to CH in Plan 3 (NOT this plan)**: subscriber-detail credit-history pagination (read-heavy, tolerates seconds of lag), top-spender leaderboards. (Consumption-rate aggregate moved **into Plan 2** as Task B.5 per Q5 sign-off.)

Plan 2 ships only the write-side fan-out and the aggregate MVs. Read-path migration is Plan 3.

---

## File structure after Plan 2

```
packages/db/
├── clickhouse/migrations/
│   ├── 0001_init_schema.sql              # Plan 1
│   ├── 0002_exposures_kafka_engine.sql   # Plan 1
│   ├── 0003_mv_experiment_daily.sql      # Plan 1
│   ├── 0004_revenue_kafka_engine.sql     # NEW — Phase B.1
│   ├── 0005_credit_kafka_engine.sql      # NEW — Phase B.2
│   ├── 0006_mv_mrr_daily.sql             # NEW — Phase B.3
│   ├── 0007_mv_credit_balance.sql        # NEW — Phase B.4
│   └── 0008_mv_credit_consumption_daily.sql  # NEW — Phase B.5

apps/api/src/
├── services/
│   └── event-bus.ts                      # MODIFY — Phase A (add 2 helpers)
├── workers/
│   └── outbox-dispatcher.ts              # MODIFY — Phase E.1 (hot-loop fix)
└── routes/dashboard/
    └── metrics.ts                        # MODIFY — Phase D (dual-read)

packages/db/src/drizzle/repositories/
├── revenue-events.ts                     # MODIFY — Phase C.1 (co-write outbox)
└── credit-ledger.ts                      # MODIFY — Phase C.2 (co-write outbox)

apps/api/tests/
├── event-bus.test.ts                     # MODIFY — Phase A (extend)
├── outbox-revenue-credit.integration.test.ts   # NEW — Phase E.2
└── dashboard-mrr-dual-read.test.ts       # NEW — Phase D.3

packages/db/scripts/
└── verify-clickhouse.ts                  # MODIFY — Phase E.3 (new table asserts + lag row)
```

No changes to `packages/db/src/drizzle/schema.ts` — the enum values Plan 2 needs are already present.

---

## Cross-plan conventions (inherited from Plan 1)

Do not re-litigate; these are settled.

- **Same-tx safety**: every caller of `eventBus.publish*` passes a `tx: Db` binding. Business row + outbox row commit together or neither commits. Pattern reference: Plan 1 Phase D.2.
- **Event ID**: outbox row `id` (cuid2) is the canonical `eventId` that CH deduplicates on via `ReplacingMergeTree(_version)` on `eventId`. Same as Plan 1 §Phase E.1. The `eventId` travels through the Kafka payload → CH Kafka Engine → target table unchanged.
- **Topic naming**: `rovenue.<aggregate-suffix>` lowercase. `rovenue.exposures` (Plan 1), `rovenue.revenue`, `rovenue.credit` (Plan 2). No environment prefix — topics are per-cluster.
- **Migration numbering**: CH migrations are sequential, zero-padded to 4 digits. Plan 1 ended at `0003`; Plan 2 uses `0004`–`0007`.
- **Test containers**: same pattern as Plan 1 Phase G.1 — spin Redpanda + CH + Postgres via `@testcontainers/*`, apply CH migrations `0001`→`0007`, run dispatcher for a bounded window, assert target tables.

---

## Phase A — Outbox aggregate helpers

**Goal**: extend `event-bus` with two new helpers. Mirror `publishExposure`'s signature exactly. Dispatcher is already aggregate-agnostic (verified: `AGGREGATE_TO_TOPIC` in Plan 1 Phase D.3 maps both new aggregates).

### Task A.1: Add `publishRevenueEvent` + `publishCreditLedgerEntry`

**Files:**
- Modify: `apps/api/src/services/event-bus.ts`
- Modify: `apps/api/tests/event-bus.test.ts` (extend with two new `describe` blocks)

- [ ] **Step 1: Extend the bus**

Append to `apps/api/src/services/event-bus.ts` — do not touch the existing `publishExposure` export:

```ts
// =============================================================
// Revenue / credit fan-out (Plan 2)
// =============================================================
//
// Both helpers assume the OLTP business row (revenue_events or
// credit_ledger) has already been inserted on the same `tx` —
// see packages/db/src/drizzle/repositories/revenue-events.ts
// and credit-ledger.ts (Phase C). The outbox insert is the last
// statement of the repository's co-write wrapper so that
// Postgres' commit order matches arrival order on the dispatcher.

export interface PublishRevenueEventInput {
  revenueEventId: string;       // revenue_events.id (cuid2)
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: string;                 // revenueEventType enum value (INITIAL_PURCHASE | RENEWAL | REFUND | ...)
  store: string;                // 'APP_STORE' | 'PLAY_STORE' | 'STRIPE'
  amount: string;               // decimal(12,4) as string — preserves precision over JSON
  amountUsd: string;            // decimal(12,4) as string
  currency: string;             // ISO-4217
  eventDate: Date;
}

async function publishRevenueEvent(
  tx: Db,
  input: PublishRevenueEventInput,
): Promise<void> {
  const payload = {
    revenueEventId: input.revenueEventId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    productId: input.productId,
    type: input.type,
    store: input.store,
    amount: input.amount,
    amountUsd: input.amountUsd,
    currency: input.currency,
    eventDate: input.eventDate.toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "REVENUE_EVENT",
    aggregateId: input.revenueEventId,
    eventType: "revenue.event.recorded",
    payload,
  });
}

export interface PublishCreditLedgerEntryInput {
  creditLedgerId: string;       // credit_ledger.id
  projectId: string;
  subscriberId: string;
  type: string;                 // creditLedgerType enum (GRANT | DEBIT | REFUND | ADJUSTMENT | ...)
  amount: number;               // signed integer
  balance: number;              // running balance AFTER this row
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

async function publishCreditLedgerEntry(
  tx: Db,
  input: PublishCreditLedgerEntryInput,
): Promise<void> {
  const payload = {
    creditLedgerId: input.creditLedgerId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    type: input.type,
    amount: input.amount,
    balance: input.balance,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    createdAt: input.createdAt.toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "CREDIT_LEDGER",
    aggregateId: input.creditLedgerId,
    eventType: "credit.ledger.appended",
    payload,
  });
}

export const eventBus = {
  publishExposure,
  publishRevenueEvent,
  publishCreditLedgerEntry,
};
```

- [ ] **Step 2: Extend the test — two new describe blocks**

Append to `apps/api/tests/event-bus.test.ts`. Mirror the existing `publishExposure` test pattern exactly (mock `drizzle.outboxRepo.insert`, assert call shape):

```ts
describe("eventBus.publishRevenueEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a REVENUE_EVENT outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishRevenueEvent>[0];
    await eventBus.publishRevenueEvent(tx, {
      revenueEventId: "rev_123",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      purchaseId: "pur_1",
      productId: "prod_pro",
      type: "INITIAL_PURCHASE",
      store: "STRIPE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledTimes(1);
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledWith(tx, {
      aggregateType: "REVENUE_EVENT",
      aggregateId: "rev_123",
      eventType: "revenue.event.recorded",
      payload: expect.objectContaining({
        revenueEventId: "rev_123",
        amountUsd: "9.9900",
      }),
    });
  });
});

describe("eventBus.publishCreditLedgerEntry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a CREDIT_LEDGER outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishCreditLedgerEntry>[0];
    await eventBus.publishCreditLedgerEntry(tx, {
      creditLedgerId: "led_1",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      type: "GRANT",
      amount: 100,
      balance: 100,
      referenceType: "PURCHASE",
      referenceId: "pur_1",
      createdAt: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledWith(tx, {
      aggregateType: "CREDIT_LEDGER",
      aggregateId: "led_1",
      eventType: "credit.ledger.appended",
      payload: expect.objectContaining({
        creditLedgerId: "led_1",
        amount: 100,
        balance: 100,
      }),
    });
  });
});
```

**Acceptance:**
- `pnpm --filter @rovenue/api test -- event-bus` shows 3 passing tests.
- `pnpm -r typecheck` passes.
- Verify `AGGREGATE_TO_TOPIC` in `outbox-dispatcher.ts` already contains both new keys (no code change there in this phase). `grep 'REVENUE_EVENT\|CREDIT_LEDGER' apps/api/src/workers/outbox-dispatcher.ts` returns both.

---

## Phase B — ClickHouse migrations

**Goal**: five new CH migrations (`0004`–`0008`) establishing the Kafka Engine tables + rollups. Follow the exact pattern of Plan 1's `0002` and `0003`.

### ADR B.0: CH retention horizon (2 years) vs Timescale (7 years)

Postgres TimescaleDB hypertables (`revenue_events`, `credit_ledger`) are the **VUK-compliant 7-year authoritative store**. ClickHouse `raw_*` tables intentionally carry a shorter 2-year TTL:

- Analytics query patterns are recent-dominated (MRR trends, churn, consumption rates). Deep-history drilldown falls back to Timescale.
- CH disk cost + merge pressure drop materially at 2y vs 7y.
- Materialized-view targets (`mv_mrr_daily_target`, `mv_credit_balance_target`, `mv_credit_consumption_daily_target`) hold pre-aggregated state and are **independent** of raw-table TTL — retention trim on raw does not affect aggregate correctness.
- If Plan 4+ ever needs deeper CH history, backfill via `INSERT ... SELECT FROM postgres_fdw` from Timescale; no data is lost.

Confirmed during Plan 2 sign-off on 2026-04-25.

### Task B.1: Migration 0004 — revenue Kafka Engine + `raw_revenue_events`

**Files:**
- Create: `packages/db/clickhouse/migrations/0004_revenue_kafka_engine.sql`

```sql
-- 0004_revenue_kafka_engine.sql
-- Kafka Engine ingestion for the rovenue.revenue topic.
-- Pipeline mirrors 0002 exactly, swapping payload shape:
--   rovenue.revenue (Redpanda)
--     -> rovenue.revenue_queue     (Kafka Engine table)
--     -> mv_revenue_to_raw         (materialized view)
--     -> rovenue.raw_revenue_events (ReplacingMergeTree target)
--
-- _version = toUnixTimestamp64Milli(ingestedAt) so that replayed
-- rows with a newer ingestedAt win the dedup race; business
-- fields (amountUsd, etc.) for the same revenueEventId never
-- drift because revenue_events is append-only in Postgres.

CREATE TABLE IF NOT EXISTS rovenue.revenue_queue
(
  eventId        String,      -- outbox id
  aggregateId    String,      -- revenueEventId (same as eventId's payload.revenueEventId)
  eventType      String,
  payload        String,      -- raw JSON, parsed in the MV
  ingestedAt     DateTime64(3) DEFAULT now64()
)
ENGINE = Kafka
SETTINGS
  kafka_topic_list        = 'rovenue.revenue',
  kafka_group_name        = 'rovenue-ch-revenue',
  kafka_format            = 'JSONEachRow',
  kafka_num_consumers     = 1,
  kafka_max_block_size    = 1048576,
  kafka_skip_broken_messages = 10;

CREATE TABLE IF NOT EXISTS rovenue.raw_revenue_events
(
  eventId          String,
  revenueEventId   String,
  projectId        String,
  subscriberId     String,
  purchaseId       String,
  productId        String,
  type             LowCardinality(String),
  store            LowCardinality(String),
  amount           Decimal(12, 4),
  amountUsd        Decimal(12, 4),
  currency         LowCardinality(String),
  eventDate        DateTime64(3),
  ingestedAt       DateTime64(3),
  _version         UInt64
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (projectId, eventDate, eventId)
PARTITION BY toYYYYMM(eventDate)
TTL toDateTime(eventDate) + INTERVAL 2 YEAR DELETE;  -- see ADR below; Timescale holds 7y authoritative

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_revenue_to_raw
TO rovenue.raw_revenue_events AS
SELECT
  eventId,
  JSONExtractString(payload, 'revenueEventId') AS revenueEventId,
  JSONExtractString(payload, 'projectId')      AS projectId,
  JSONExtractString(payload, 'subscriberId')   AS subscriberId,
  JSONExtractString(payload, 'purchaseId')     AS purchaseId,
  JSONExtractString(payload, 'productId')      AS productId,
  JSONExtractString(payload, 'type')           AS type,
  JSONExtractString(payload, 'store')          AS store,
  toDecimal128(JSONExtractString(payload, 'amount'),    4) AS amount,
  toDecimal128(JSONExtractString(payload, 'amountUsd'), 4) AS amountUsd,
  JSONExtractString(payload, 'currency')       AS currency,
  parseDateTime64BestEffort(JSONExtractString(payload, 'eventDate'), 3) AS eventDate,
  ingestedAt,
  toUnixTimestamp64Milli(ingestedAt)           AS _version
FROM rovenue.revenue_queue;
```

**Acceptance:**
- `pnpm --filter @rovenue/db db:clickhouse:migrate` prints `applying 0004_revenue_kafka_engine.sql` and exits 0.
- `docker compose exec clickhouse clickhouse-client --query "SHOW TABLES FROM rovenue"` lists `revenue_queue`, `raw_revenue_events`, `mv_revenue_to_raw`.

### Task B.2: Migration 0005 — credit Kafka Engine + `raw_credit_ledger`

**Files:**
- Create: `packages/db/clickhouse/migrations/0005_credit_kafka_engine.sql`

```sql
-- 0005_credit_kafka_engine.sql
-- Same shape as 0004. credit_ledger has signed integer amount and
-- a running balance column that is the POST-mutation balance.
-- We preserve `balance` here so downstream aggregates can pick
-- the latest row per subscriber and trust it as the current state
-- (no SUM needed, matches Postgres invariant-by-construction).

CREATE TABLE IF NOT EXISTS rovenue.credit_queue
(
  eventId     String,
  aggregateId String,
  eventType   String,
  payload     String,
  ingestedAt  DateTime64(3) DEFAULT now64()
)
ENGINE = Kafka
SETTINGS
  kafka_topic_list        = 'rovenue.credit',
  kafka_group_name        = 'rovenue-ch-credit',
  kafka_format            = 'JSONEachRow',
  kafka_num_consumers     = 1,
  kafka_max_block_size    = 1048576,
  kafka_skip_broken_messages = 10;

CREATE TABLE IF NOT EXISTS rovenue.raw_credit_ledger
(
  eventId        String,
  creditLedgerId String,
  projectId      String,
  subscriberId   String,
  type           LowCardinality(String),
  amount         Int64,
  balance        Int64,
  referenceType  Nullable(String),
  referenceId    Nullable(String),
  createdAt      DateTime64(3),
  ingestedAt     DateTime64(3),
  _version       UInt64
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (projectId, createdAt, eventId)
PARTITION BY toYYYYMM(createdAt)
TTL toDateTime(createdAt) + INTERVAL 2 YEAR DELETE;  -- see ADR B.0; Timescale holds 7y authoritative

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_to_raw
TO rovenue.raw_credit_ledger AS
SELECT
  eventId,
  JSONExtractString(payload, 'creditLedgerId') AS creditLedgerId,
  JSONExtractString(payload, 'projectId')      AS projectId,
  JSONExtractString(payload, 'subscriberId')   AS subscriberId,
  JSONExtractString(payload, 'type')           AS type,
  toInt64OrZero(JSONExtractString(payload, 'amount'))  AS amount,
  toInt64OrZero(JSONExtractString(payload, 'balance')) AS balance,
  JSONExtractString(payload, 'referenceType')  AS referenceType,
  JSONExtractString(payload, 'referenceId')    AS referenceId,
  parseDateTime64BestEffort(JSONExtractString(payload, 'createdAt'), 3) AS createdAt,
  ingestedAt,
  toUnixTimestamp64Milli(ingestedAt)           AS _version
FROM rovenue.credit_queue;
```

**Acceptance:**
- Migrator prints `applying 0005_credit_kafka_engine.sql`.
- `SHOW TABLES FROM rovenue` now includes `credit_queue`, `raw_credit_ledger`, `mv_credit_to_raw`.

### Task B.3: Migration 0006 — `mv_mrr_daily` SummingMergeTree

**Files:**
- Create: `packages/db/clickhouse/migrations/0006_mv_mrr_daily.sql`

Daily per-project rollup: one row per `(projectId, day)` with MRR components. Matches the columns exposed by the existing Drizzle `daily_mrr` view (`projectId`, `bucket`, `gross_usd`, `event_count`, `active_subscribers`) so the dual-read in Phase D can compare like-for-like. The CH side also carries `refunds_usd` and `net_usd` for future ARR charts; dual-read only consumes the first three.

```sql
-- 0006_mv_mrr_daily.sql
-- Daily MRR rollup consumed by the dashboard metrics endpoint
-- in dual-read mode (Phase D). Schema superset of the Timescale
-- daily_mrr cagg: gross_usd + event_count + active_subscribers
-- are the compare-me columns; refunds_usd + net_usd are extra.
--
-- Active-subscriber count uses uniq-state so re-reads across the
-- retention horizon can re-aggregate without double-counting a
-- single subscriber who purchased on the same day twice.

CREATE TABLE IF NOT EXISTS rovenue.mv_mrr_daily_target
(
  projectId          String,
  day                Date,
  gross_usd          Decimal(18, 4),
  refunds_usd        Decimal(18, 4),
  net_usd            Decimal(18, 4),
  event_count        UInt64,
  subscribersHll     AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;  -- see ADR B.0; backfill from Timescale if deeper history needed

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_mrr_daily
TO rovenue.mv_mrr_daily_target AS
SELECT
  projectId,
  toDate(eventDate) AS day,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))      AS gross_usd,
  sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))           AS refunds_usd,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))
    - sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))       AS net_usd,
  count()                                                      AS event_count,
  uniqState(subscriberId)                                      AS subscribersHll
FROM rovenue.raw_revenue_events
GROUP BY projectId, day;
```

**Acceptance:**
- Migration applies cleanly.
- Smoke test: insert one outbox `REVENUE_EVENT` row via psql, wait 5 s, confirm `SELECT gross_usd, event_count FROM rovenue.mv_mrr_daily_target FINAL WHERE projectId='prj_smoke'` returns the expected amount.

### Task B.4: Migration 0007 — `mv_credit_balance` AggregatingMergeTree

**Files:**
- Create: `packages/db/clickhouse/migrations/0007_mv_credit_balance.sql`

Per-subscriber state: the *most recent* `balance` for each `(projectId, subscriberId)`. AggregatingMergeTree with `argMaxState(balance, createdAt)` gives us O(1) reads even across months of data. Consumption-rate charts land in a sibling MV — see Task B.5.

```sql
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
```

**Acceptance:**
- Migration applies cleanly.
- Smoke query:

  ```sql
  SELECT
    subscriberId,
    argMaxMerge(latestBalanceState) AS balance,
    sumMerge(totalGrantedState)     AS granted,
    sumMerge(totalDebitedState)     AS debited
  FROM rovenue.mv_credit_balance_target
  WHERE projectId = 'prj_smoke'
  GROUP BY subscriberId;
  ```

  returns the post-seed expected row.

### Task B.5: Migration 0008 — `mv_credit_consumption_daily` SummingMergeTree

**Files:**
- Create: `packages/db/clickhouse/migrations/0008_mv_credit_consumption_daily.sql`

Sibling to `mv_credit_balance` (snapshot state). This MV answers **"how much credit did subscribers grant vs debit per day?"** — consumption-rate charts, leaderboards, velocity trends. Separate MV from the balance snapshot so each answers one question at native speed; mixing them into one aggregate makes both slow.

```sql
-- 0008_mv_credit_consumption_daily.sql
-- Daily per-project credit flow (granted vs debited, event count,
-- unique-subscriber HLL). SummingMergeTree for O(1) rollup reads;
-- pair with uniqMerge(subscribersHll) for distinct-subscriber queries.

CREATE TABLE IF NOT EXISTS rovenue.mv_credit_consumption_daily_target
(
  projectId        String,
  day              Date,
  granted_credits  Int64,
  debited_credits  Int64,
  net_flow         Int64,
  event_count      UInt64,
  subscribersHll   AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;  -- see ADR B.0

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_consumption_daily
TO rovenue.mv_credit_consumption_daily_target AS
SELECT
  projectId,
  toDate(createdAt)                                    AS day,
  sumIf(amount, amount > 0)                            AS granted_credits,
  sumIf(-amount, amount < 0)                           AS debited_credits,
  sum(amount)                                          AS net_flow,
  count()                                              AS event_count,
  uniqState(subscriberId)                              AS subscribersHll
FROM rovenue.raw_credit_ledger
GROUP BY projectId, day;
```

**Acceptance:**
- Migration applies cleanly.
- Smoke query after seeding 5 credit events across two days:

  ```sql
  SELECT
    day,
    sum(granted_credits) AS granted,
    sum(debited_credits) AS debited,
    sum(net_flow)        AS net,
    uniqMerge(subscribersHll) AS unique_subs
  FROM rovenue.mv_credit_consumption_daily_target
  WHERE projectId = 'prj_smoke'
  GROUP BY day
  ORDER BY day;
  ```

  returns one row per day with grant + debit sums matching the seed.

---

## Phase C — OLTP write-path instrumentation

**Goal**: wire `revenue_events` and `credit_ledger` inserts to the outbox **in the same transaction** as the OLTP write. Callers (webhook processor, credit engine, receipt routes, subscriber transfer, Stripe handler) do not change — the repo wrappers handle the co-write.

### Task C.0: Caller inventory (read-only)

Before modifying the repos, confirm the full caller list with a grep. Current known callers (from existing codebase, inventoried while drafting):

| Caller                                           | Writes to      | Notes                                                 |
| ------------------------------------------------ | -------------- | ----------------------------------------------------- |
| `services/webhook-processor.ts`                  | both           | Stripe + Apple + Play webhook fan-out                 |
| `services/credit-engine.ts`                      | `creditLedger` | Consumption debits                                    |
| `services/subscriber-transfer.ts`                | `creditLedger` | Balance transfer on subscriber merge                  |
| `routes/v1/receipts.ts`                          | both           | Server-to-server receipt redemption                   |
| `services/stripe/*` (payment intent handler)     | `revenueEvents`| Direct Stripe payment insert                          |

Run before implementation:

```bash
grep -rn "revenueEventsRepo\.insert\|drizzle\.revenueEventsRepo" apps/api/src/ packages/
grep -rn "creditLedgerRepo\.insert\|drizzle\.creditLedgerRepo"   apps/api/src/ packages/
```

Every hit must either (a) pass through the modified repo in Task C.1/C.2, or (b) be explicitly documented as a read-only call. Insert callers that bypass the repo must be corrected **in this phase** — no exceptions. Append the actual caller list to the PR description when finishing.

### Task C.1: Co-write outbox in `revenue-events` repo

**Files:**
- Modify: `packages/db/src/drizzle/repositories/revenue-events.ts`
- Add test: `packages/db/src/drizzle/repositories/revenue-events.test.ts` (extend if exists)

The existing repo exposes some variant of `insert(tx, row)`. Refactor so that the function is explicitly transactional: if the caller already holds a `tx`, we append the outbox write to it; if the caller passes a raw `Db`, we wrap both writes in a fresh transaction. Import `eventBus.publishRevenueEvent` from `apps/api/src/services/event-bus.ts` is a layer inversion — **do not** do that. Instead, the repo calls `outboxRepo.insert` directly with the same shape `publishRevenueEvent` produces (the event-bus helper exists for *application-layer* callers; the repo does not go through it):

```ts
// revenue-events.ts — sketch of the change
async function insert(dbOrTx: Db, row: NewRevenueEvent): Promise<RevenueEvent> {
  return runInTx(dbOrTx, async (tx) => {
    const [inserted] = await tx
      .insert(revenueEvents)
      .values(row)
      .returning();

    await outboxRepo.insert(tx, {
      aggregateType: "REVENUE_EVENT",
      aggregateId: inserted.id,
      eventType: "revenue.event.recorded",
      payload: {
        revenueEventId: inserted.id,
        projectId: inserted.projectId,
        subscriberId: inserted.subscriberId,
        purchaseId: inserted.purchaseId,
        productId: inserted.productId,
        type: inserted.type,
        store: inserted.store,
        amount: inserted.amount,
        amountUsd: inserted.amountUsd,
        currency: inserted.currency,
        eventDate: inserted.eventDate.toISOString(),
      },
    });

    return inserted;
  });
}
```

`runInTx(dbOrTx, fn)` is the existing helper used by the outbox repo in Plan 1 — re-use, do not duplicate.

**Acceptance:**
- `pnpm --filter @rovenue/db test -- revenue-events` passes.
- New test case: `insert rolls back the outbox row if the revenue row fails (e.g. bad FK)` — use a non-existent `purchaseId`; assert both tables are empty after the attempted insert.
- New test case: `insert writes exactly one outbox row per revenue row`.

### Task C.2: Co-write outbox in `credit-ledger` repo

**Files:**
- Modify: `packages/db/src/drizzle/repositories/credit-ledger.ts`
- Add test: `packages/db/src/drizzle/repositories/credit-ledger.test.ts`

Same pattern as C.1, payload shape from `publishCreditLedgerEntry` in Phase A.

```ts
async function append(dbOrTx: Db, row: NewCreditLedgerRow): Promise<CreditLedgerRow> {
  return runInTx(dbOrTx, async (tx) => {
    const [inserted] = await tx
      .insert(creditLedger)
      .values(row)
      .returning();

    await outboxRepo.insert(tx, {
      aggregateType: "CREDIT_LEDGER",
      aggregateId: inserted.id,
      eventType: "credit.ledger.appended",
      payload: {
        creditLedgerId:  inserted.id,
        projectId:       inserted.projectId,
        subscriberId:    inserted.subscriberId,
        type:            inserted.type,
        amount:          inserted.amount,
        balance:         inserted.balance,
        referenceType:   inserted.referenceType,
        referenceId:     inserted.referenceId,
        createdAt:       inserted.createdAt.toISOString(),
      },
    });

    return inserted;
  });
}
```

**Acceptance:**
- `pnpm --filter @rovenue/db test -- credit-ledger` passes.
- Rollback test symmetric to C.1.
- Concurrency sanity: two parallel `append` calls for the same subscriber produce two outbox rows and two ledger rows, balance invariants preserved (covered by existing credit-ledger concurrency test; just confirm it still passes).

### Task C.3: Caller sanity run

No caller code changes — but run the full API test suite to confirm no caller was bypassing the repo:

```bash
pnpm --filter @rovenue/api test
```

Any test that directly inserts into `revenue_events` / `credit_ledger` via raw drizzle (test fixtures, seeders) must be reviewed: if it simulates production code, route through the repo; if it's a pure CH integration test that pre-seeds OLTP state, document the bypass in a test-level comment.

---

## Phase D — Dashboard MRR endpoint dual-read

**Goal**: no hard cutover. The endpoint reads from **both** Timescale's `daily_mrr` cagg and CH's `mv_mrr_daily_target` (Task B.3), returns whichever is authoritative per a feature flag, and logs drift when both are available. Once drift is observed to be <0.5 % over a 14-day window in production, Plan 3 flips the flag to CH-primary and Plan 4 removes the Timescale branch.

### Task D.1: Feature flag in env schema

**Files:**
- Modify: `apps/api/src/lib/env.ts` (or wherever zod env schema lives)

Add:

```ts
MRR_READ_SOURCE: z.enum(["timescale", "clickhouse", "dual"]).default("timescale"),
```

- `timescale` (default, safe): current behavior.
- `clickhouse`: read from CH only, no Timescale query.
- `dual`: issue both queries in parallel, return Timescale result (unchanged user experience), log per-bucket drift at `info` level. **This is the rollout mode for Plan 2.**

### Task D.2: Read adapter

**Files:**
- Modify: `apps/api/src/routes/dashboard/metrics.ts`
- Create: `apps/api/src/services/metrics/mrr-adapter.ts`

Extract the current Timescale read into `mrr-adapter.timescaleListDailyMrr(input)`. Add `mrr-adapter.clickhouseListDailyMrr(input)` that queries:

```sql
SELECT
  toStartOfDay(day)               AS bucket,
  toString(gross_usd)             AS gross_usd,
  toUInt64(event_count)           AS event_count,
  uniqMerge(subscribersHll)       AS active_subscribers
FROM rovenue.mv_mrr_daily_target FINAL
WHERE projectId = {projectId:String}
  AND day >= {from:Date}
  AND day <  {to:Date}
GROUP BY projectId, day, gross_usd, event_count
ORDER BY day ASC
```

Response normalizer returns the existing `{ data: { points: [...] } }` shape — strings for `gross_usd` to preserve decimal precision (matches current Timescale path).

Dispatcher function in the route handler:

```ts
const mode = env.MRR_READ_SOURCE;
if (mode === "timescale") return timescaleListDailyMrr(input);
if (mode === "clickhouse") return clickhouseListDailyMrr(input);

// dual mode: run both, compare, return Timescale to preserve behavior
const [ts, ch] = await Promise.allSettled([
  timescaleListDailyMrr(input),
  clickhouseListDailyMrr(input),
]);
if (ts.status === "rejected") throw ts.reason;
if (ch.status === "fulfilled") {
  logDriftPerBucket(input.projectId, ts.value, ch.value); // info-level, structured
}
return ts.value;
```

`logDriftPerBucket` computes `abs(ts.gross_usd - ch.gross_usd) / ts.gross_usd` per bucket and logs any bucket exceeding 0.5 % at `warn`. All-bucket drift summary at `info`.

### Task D.3: Integration test for dual mode

**Files:**
- Create: `apps/api/tests/dashboard-mrr-dual-read.test.ts`

Spin Postgres + Timescale + Redpanda + CH via testcontainers (reuse the fixture from Plan 1 Phase G.1). Seed 5 revenue events across two days via the repo (triggers outbox → CH), wait for CH MV to converge, run migration 0005 for Timescale cagg, call the route with `MRR_READ_SOURCE=dual`, assert:

1. Response shape matches current Timescale-only response (snapshot).
2. No drift warning emitted (both sources agree within tolerance).
3. Switching env to `clickhouse` returns structurally identical response.
4. Switching env to `timescale` returns unchanged response (regression guard).

**Acceptance:**
- Test passes.
- Manual smoke via `curl` in all three modes returns identical `points[].gross_usd` for a seeded project.

---

## Phase E — Hardening (includes Plan 1 TODO fix)

### Task E.1: Dispatcher hot-loop fix (Plan 1 TODO)

**Files:**
- Modify: `apps/api/src/workers/outbox-dispatcher.ts`
- Create: `apps/api/tests/outbox-dispatcher-isolation.test.ts`

The exact TODO from Plan 1 (`apps/api/src/workers/outbox-dispatcher.ts`):

```ts
// TODO(plan-phase-G): per-topic isolation + exponential backoff.
// Today a single permanently-broken topic (or bad payload) causes
// the whole batch to re-fetch every 500ms forever. Switch to
// Promise.allSettled + per-topic failure tracking so healthy
// topics keep draining while the sick one backs off.
```

Plan 2 doubles the topic count and introduces payloads with financial data — the hot-loop risk is no longer acceptable. Fix strategy:

1. **Group batch by topic before publish.** The current group-by exists; keep it.
2. **Publish per-topic with `Promise.allSettled`.** A failed topic marks only its rows as unflushed; healthy topics mark their rows `publishedAt`.
3. **Per-topic backoff state**: `Map<topic, { consecutiveFailures: number; nextAttemptAt: number }>`. Exponential: `min(30_000, 500 * 2^failures)` ms. Reset to 0 on success.
4. **Claim filter**: when claiming a batch, skip rows whose `aggregateType` maps to a topic currently backing off. This prevents re-claiming the same 250 poison rows on every poll.
5. Log `warn` when a topic enters backoff with `consecutiveFailures >= 3` (actionable alert signal).

New test: `outbox-dispatcher-isolation.test.ts` — publish to a mock producer that rejects `rovenue.revenue` but accepts `rovenue.exposures`. Enqueue 5 EXPOSURE rows + 5 REVENUE_EVENT rows. Assert after 3 poll cycles: 5 EXPOSURE rows have `publishedAt` set, 5 REVENUE_EVENT rows still NULL, `rovenue.revenue` has backoff state with `consecutiveFailures >= 3`.

**Acceptance:**
- Above test passes.
- Existing Plan 1 dispatcher test (`outbox-dispatcher.integration.test.ts`) still passes — no regression.
- The TODO comment block is replaced by a 3-line comment describing the implemented isolation policy.

### Task E.2: Cross-aggregate replay idempotency

**Files:**
- Create: `apps/api/tests/outbox-revenue-credit.integration.test.ts`

End-to-end with testcontainers:

1. Spin Postgres + Redpanda + CH, apply CH migrations `0001`→`0007`.
2. Via the repos (Phase C), append 3 revenue events and 3 credit ledger rows for a single subscriber.
3. Run the dispatcher until backlog = 0.
4. Assert CH counts: `raw_revenue_events` has 3 rows, `raw_credit_ledger` has 3 rows, `mv_mrr_daily_target` sums match, `mv_credit_balance_target` latest balance matches the last credit row.
5. **Replay**: re-insert the same 6 outbox rows (same `eventId`) bypassing the repo (simulates at-least-once re-delivery). Run dispatcher.
6. Assert counts unchanged: `ReplacingMergeTree` on `eventId` deduplicates. Use `SELECT count() FROM raw_revenue_events FINAL` and `... FROM raw_credit_ledger FINAL`.
7. Assert MRR rollup unchanged (no double-counting).
8. Assert credit balance unchanged (argMax state idempotent under identical re-sends).

This mirrors the EXPOSURE replay test from Plan 1 Phase G (commit `81fafda test(api): replay idempotency — ReplacingMergeTree on eventId`); goal is to prove the same guarantee holds for the two new aggregates.

### Task E.3: Extend `verify-clickhouse` CLI

**Files:**
- Modify: `packages/db/scripts/verify-clickhouse.ts`

Append to the `EXPECTED_TABLES` array:

```ts
{ name: "revenue_queue",           engine: "Kafka" },
{ name: "raw_revenue_events",      engine: "ReplacingMergeTree" },
{ name: "mv_revenue_to_raw",       engine: "MaterializedView" },
{ name: "credit_queue",            engine: "Kafka" },
{ name: "raw_credit_ledger",       engine: "ReplacingMergeTree" },
{ name: "mv_credit_to_raw",        engine: "MaterializedView" },
{ name: "mv_mrr_daily_target",     engine: "SummingMergeTree" },
{ name: "mv_mrr_daily",            engine: "MaterializedView" },
{ name: "mv_credit_balance_target", engine: "AggregatingMergeTree" },
{ name: "mv_credit_balance",       engine: "MaterializedView" },
{ name: "mv_credit_consumption_daily_target", engine: "SummingMergeTree" },
{ name: "mv_credit_consumption_daily",        engine: "MaterializedView" },
```

Add a new diagnostic section: **outbox backlog per aggregate**. SQL:

```sql
SELECT "aggregateType", count()
FROM outbox_events
WHERE "publishedAt" IS NULL
GROUP BY "aggregateType";
```

This runs against Postgres (reuse the existing Pg connection from `verify-timescale.ts`, or simply run it via `psql` subshell). Print per-aggregate backlog. Two-tier thresholds:

- **WARN** (exit 0, print warning): any aggregate backlog ≥ `OUTBOX_BACKLOG_WARN_THRESHOLD` (default **1 000**).
- **CRIT** (exit 2, page-worthy): any aggregate backlog ≥ `OUTBOX_BACKLOG_CRIT_THRESHOLD` (default **10 000**).

Steady-state should be ~0 (dispatcher drains continuously). 1k sustained is the "investigate" signal; 10k is "wake someone up". Thresholds re-tuned after 30 days of production data.

Also extend the Kafka consumer-lag section (already present in Plan 1 Phase G.3) to include the two new consumer groups `rovenue-ch-revenue` and `rovenue-ch-credit`. The existing `SELECT ... FROM system.kafka_consumers` query returns all groups; just pretty-print per-group.

**Acceptance:**
- `pnpm --filter @rovenue/db db:verify:clickhouse` returns 0 in a healthy state.
- Manually stopping the dispatcher and inserting >1 000 outbox rows surfaces a WARN (exit 0, warning printed); >10 000 triggers CRIT (exit 2). Restart dispatcher and confirm exit 0 with no warnings after backlog drains.

### Task E.4: Postgres-vs-CH MRR correlation test

**Files:**
- Create: `apps/api/tests/mrr-correlation.integration.test.ts`

End-to-end: seed 30 days of synthetic revenue events (varied amounts, some refunds). Compute MRR per day from Postgres (Timescale cagg OR a direct aggregate query as ground truth) and from CH `mv_mrr_daily_target`. Assert max per-bucket relative delta ≤ 0.5 %, absolute delta ≤ $0.01 (rounds to same cents).

If this fails it means payload precision is being lost somewhere — likely the `amountUsd: string` serialization (intentional to preserve decimal precision over JSON). This is the canary for any future change that might silently corrupt revenue aggregates.

---

## Phase F — Final baseline + PR

### Task F.1: Full suite run

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter @rovenue/db db:verify:timescale
pnpm --filter @rovenue/db db:verify:clickhouse
```

All green.

### Task F.2: Baseline snapshot

Same convention as Plan 1 Phase H.1: commit a text snapshot of the CH schema, outbox migrations, and env default. Location: `docs/superpowers/baselines/2026-04-24-plan2-baseline.txt`. Contents:

- `clickhouse-client --query "SHOW CREATE TABLE rovenue.<each new table>"` for all new tables/MVs.
- `psql ... -c "\d outbox_events"` (shape unchanged, snapshotted for PR reviewer sanity).
- Current `MRR_READ_SOURCE` default value.

### Task F.3: PR body template

```bash
gh pr create --title "feat(ch): revenue + credit outbox fan-out (Plan 2)" --body "$(cat <<'EOF'
## Summary

- Extends the Kafka+outbox analytics pipeline (Plan 1) to cover `revenue_events` and `credit_ledger`. TimescaleDB hypertables remain the source of truth (VUK 7-year retention); ClickHouse receives a transactional fan-out for analytics read paths.
- Ships five new CH migrations: `0004` (revenue Kafka Engine + raw_revenue_events), `0005` (credit Kafka Engine + raw_credit_ledger), `0006` (mv_mrr_daily SummingMergeTree), `0007` (mv_credit_balance AggregatingMergeTree), `0008` (mv_credit_consumption_daily SummingMergeTree).
- Dashboard MRR endpoint enters **dual-read** mode behind `MRR_READ_SOURCE` env flag. Default remains Timescale; `dual` mode runs both and logs drift; `clickhouse` mode is ready for Plan 3's cutover.
- Fixes the Plan 1 Phase G TODO: outbox-dispatcher now has per-topic isolation + exponential backoff so a single bad topic no longer halts healthy ones.
- `verify-clickhouse` CLI gains per-aggregate outbox backlog + consumer-lag for revenue/credit groups.
- Credit balance reads (findLatestBalance, GDPR export) intentionally stay on Postgres — CQRS line documented in the plan.

## Test plan

- [x] `pnpm -r test` passes (adds event-bus helpers, repo co-write, dispatcher isolation, cross-aggregate replay, MRR correlation, dual-read).
- [x] `pnpm --filter @rovenue/db db:verify:clickhouse` passes with backlog + consumer-lag diagnostics for 3 aggregates.
- [x] Manual smoke: seed 30 days of synthetic revenue via the repo, hit `/dashboard/projects/:id/metrics/mrr` in `dual` mode — drift log shows ≤0.5 % per bucket.
- [x] Replay test: re-dispatching the same outbox rows leaves CH counts and MRR rollup unchanged.

## Migration checklist (Coolify)

- [ ] Apply CH migrations `0004`-`0008` (auto via startup migrator).
- [ ] Default `MRR_READ_SOURCE=timescale` — no behavior change.
- [ ] After 48h of clean `dual` mode logs in staging, flip to `dual` in production.
- [ ] **Cutover quality gate** (both must pass before Plan 3 flips to `clickhouse`):
  - [ ] **Time gate**: ≥14 calendar days in production `dual` mode (covers 2 full monthly billing cycles).
  - [ ] **Checksum gate**: daily correlation job (`apps/api/scripts/mrr-checksum.ts`, stub in Phase E.4) compares CH `sumMerge(net_usd)` vs Timescale `daily_mrr.gross_usd` per project per day; asserts `|delta| < 1¢` for **7 consecutive days** with zero alerts. Time gate alone is a weak signal; the checksum is the real sign-off.

## Deferred to Plan 3
- Outbox retention worker.
- Read-path migration for credit-history and top-spenders.
- LTV / churn / refund-rate CH MVs.
- Grafana observability dashboards.
EOF
)"
```

**Do not push; do not open PR — that is the user's call after review.**

---

## Future CH aggregates (appendix — NOT in this plan)

Sketched for reviewer context; none of these ship in Plan 2.

### LTV per subscriber (AggregatingMergeTree)

```sql
CREATE TABLE rovenue.mv_subscriber_ltv_target
(
  projectId     String,
  subscriberId  String,
  ltvUsdState   AggregateFunction(sum, Decimal(18, 4)),
  firstEventAt  SimpleAggregateFunction(min, DateTime64(3)),
  lastEventAt   SimpleAggregateFunction(max, DateTime64(3))
)
ENGINE = AggregatingMergeTree
ORDER BY (projectId, subscriberId);
```

### Refund rate + churn rate (MV over raw_revenue_events)

Needs subscriber cohort join with a still-to-be-decided `subscribers` CH table. Deferred.

### Top spenders leaderboard

Same MV as LTV, just read-path ordering by `sumMerge(ltvUsdState)` descending with a LIMIT.

---

## Sign-off (resolved 2026-04-25)

1. **Q1 — `amount` serialization as string in outbox payload**: ✅ **Confirmed.** JSON number precision drift (IEEE 754) is unacceptable on the financial hot path. String + `toDecimal128(..., 4)` on CH ingest.
2. **Q2 — CH raw-table retention**: 🔄 **Reduced to 2 years** (see ADR B.0). Timescale remains 7-year VUK-authoritative. Backfill from Timescale if deeper CH history ever required.
3. **Q3 — Outbox backlog alert thresholds**: 🔄 **Two-tier**: `OUTBOX_BACKLOG_WARN_THRESHOLD` default 1 000 (WARN, exit 0), `OUTBOX_BACKLOG_CRIT_THRESHOLD` default 10 000 (CRIT, exit 2). Re-tune after 30d production data.
4. **Q4 — `dual` mode cutover window**: ✅ **14 days kept, quality gate added.** Cutover to `clickhouse` requires **both** time gate (≥14 calendar days in `dual`) **and** checksum gate (`|CH_MRR - Timescale_MRR| < 1¢` for 7 consecutive days). See Migration checklist.
5. **Q5 — Credit consumption-rate aggregate**: 🔄 **Moved into Plan 2 as Task B.5.** `mv_credit_balance` stays snapshot-only (`SimpleAggregateFunction(max)` for `lastActivityAt`); sibling `mv_credit_consumption_daily` SummingMergeTree handles flow/velocity.
