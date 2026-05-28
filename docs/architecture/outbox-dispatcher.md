# Outbox dispatcher: delivery semantics & horizontal-scaling contract

## 1. Overview

Domain writes co-write a row into `outbox_events` inside the **same Postgres
transaction** as the business mutation (no dual-write). A dispatcher worker
polls for unpublished rows, publishes them to Kafka/Redpanda, and marks them
published. ClickHouse ingests each topic via a Kafka Engine queue table + a
materialized view into a `ReplacingMergeTree` raw table; further materialized
views roll those raw tables up into daily/lifetime aggregates.

Path:

```
domain tx ──> outbox_events ──[dispatcher]──> Kafka/Redpanda topic
                                                    │
                                          Kafka Engine queue table
                                                    │  (MV)
                                          raw_*_events (ReplacingMergeTree)
                                                    │  (MV, fires per insert block)
                                          mv_*_daily / lifetime (SummingMergeTree…)
```

## 2. Delivery semantics: AT-LEAST-ONCE

The dispatcher is **at-least-once**, not exactly-once. The claim and the
publish-acknowledgement live in **separate transactions**:

- `claimBatch` (`packages/db/src/drizzle/repositories/outbox.ts:35`) selects
  unpublished rows with `FOR UPDATE SKIP LOCKED` (`.for("update", {
  skipLocked: true })`, line 48). In `runOnce`
  (`apps/api/src/workers/outbox-dispatcher.ts:160`) this claim runs inside its
  own `db.transaction(...)` that **commits and releases the row locks before
  anything is published to Kafka** (lines 160–162).
- Kafka publish happens afterwards (`producer.send`, line 198).
- `markPublished` (`outbox.ts:51`) flips `publishedAt = NOW()` in a **second,
  separate transaction** (`outbox-dispatcher.ts:255`), only after the Kafka ack.

Therefore, if the process dies **after the Kafka ack but before
`markPublished` commits**, the row is still `publishedAt IS NULL` and is
re-claimed and **re-published** on the next tick / restart. Duplicate Kafka
messages with the same `eventId` are an expected, normal outcome.

(The dispatcher's own header comment claims "ClickHouse de-duplicates on
eventId via ReplacingMergeTree" — that is only *partially* true; see §4.)

## 3. Horizontal-scaling hazard

The dispatcher is started **unconditionally in every API instance**:

```
apps/api/src/index.ts:253   void runOutboxDispatcher();
```

There is **no leader election and no single-instance guard**. The repository
comment at `outbox.ts:18-20` and the worker comment at
`outbox-dispatcher.ts:80-81` both explicitly state the design is
**single-instance** and that `SKIP LOCKED` is only "future-proofing".

If the API is scaled to **more than one instance**, every instance runs its
own dispatcher loop. `SKIP LOCKED` prevents two dispatchers from claiming the
*same* row in the *same instant*, but because the claim tx commits before
publish, a row published by instance A but not yet `markPublished` is fully
claimable by instance B — so the same `eventId` is **published to Kafka more
than once, concurrently**. Combined with §2 this multiplies duplicate
delivery.

## 4. Why it is only *conditionally* safe — and where it is NOT

Duplicate Kafka delivery is safe **only if every downstream consumer collapses
duplicates on the event id**. ClickHouse does this **only at the raw-table
layer**, not at the aggregate layer.

### Raw event tables — dedup-safe (ReplacingMergeTree on the event id)

| Table | Engine | ORDER BY (dedup key) | Version |
|---|---|---|---|
| `rovenue.raw_revenue_events` | `ReplacingMergeTree(_version)` | `(projectId, eventDate, eventId)` | `_version` = ingest ms |
| `rovenue.raw_credit_ledger`  | `ReplacingMergeTree(_version)` | `(projectId, createdAt, eventId)` | `_version` = ingest ms |
| `rovenue.raw_exposures`* | `ReplacingMergeTree(insertedAt)` | `(projectId, experimentId, exposedAt, eventId)` | `insertedAt` |

(*see `0002_exposures_kafka_engine.sql`.)

A duplicate delivery inserts a second row with the **same `eventId`** and a
newer `_version`. Read paths that query these tables **with `FINAL`** collapse
the duplicate and are dedup-safe. The revenue/credit read services do use
`FINAL`, e.g. `apps/api/src/services/metrics/overview.ts`,
`.../charts.ts`, `.../transactions.ts`, `.../digest-kpi.ts`,
`routes/dashboard/leaderboards.ts`, `services/cohorts.ts` — all
`FROM rovenue.raw_revenue_events FINAL`.

### ⚠️ Aggregate rollup tables — NOT dedup-safe under duplicate delivery

A ClickHouse materialized view fires on **each insert block written to its
source table**, *before* the `ReplacingMergeTree` dedup merge runs. The
revenue/credit rollup MVs read `FROM raw_revenue_events` /
`FROM raw_credit_ledger` (no `FINAL` in the MV's SELECT — `FINAL` is not
applied at MV-trigger time anyway), so a duplicate delivery produces a **second
insert block** that the rollup **adds again**:

| Aggregate target | Engine | What double-counts on duplicate delivery |
|---|---|---|
| `rovenue.mv_mrr_daily_target` (`0006`) | `SummingMergeTree`, `ORDER BY (projectId, day)` | `gross_usd`, `refunds_usd`, `net_usd`, `event_count` are **summed twice**. (`subscribersHll` = `AggregateFunction(uniq)` is idempotent — a re-seen subscriberId does not change the HLL.) |
| `rovenue.revenue_lifetime_subscriber_tbl` (`0011`) | `SummingMergeTree`, `ORDER BY (projectId, subscriberId)` | `lifetime_dollars_purchased_cents` / `lifetime_dollars_refunded_cents` **summed twice** — feeds Refund Shield's Apple consumption-request responder. |
| `rovenue.mv_credit_consumption_daily_target` (`0008`) | `SummingMergeTree`, `ORDER BY (projectId, day)` | `granted_credits`, `debited_credits`, `net_flow`, `event_count` **summed twice** (`subscribersHll` idempotent). |
| `rovenue.mv_credit_balance_target` (`0007`) | `AggregatingMergeTree`, `ORDER BY (projectId, subscriberId)` | `latestBalanceState` (`argMaxState(balance, createdAt)`) is **idempotent** (same value). `totalGrantedState` / `totalDebitedState` (`sumState`) **double-count**. |

`FINAL` on a `SummingMergeTree`/`AggregatingMergeTree` only finishes pending
same-key merges; it does **not** remove a duplicate's contribution, because the
duplicate was already folded into the sum as a distinct insert. The
`SummingMergeTree + AggregateFunction(uniq)` pattern is *correct for what it
does* (distinct counts dedup; sums do not) — the gap is specifically the
**summed money/credit columns**, which have no event-id idempotency.

**Consequence:** with more than one dispatcher (or a crash between Kafka ack
and `markPublished`), MRR / net revenue / lifetime $ purchased+refunded / daily
credit flow can be **over-reported**. Refund Shield's lifetime-$ signal is on
this path, so over-counting could change automated refund decisions.

**Required fix before relying on these aggregates under duplicate delivery
(choose one):**

1. Guarantee single delivery operationally (see §5), **or**
2. Re-base the money/credit aggregates on the deduplicated raw layer — e.g.
   read aggregates from `... FINAL` at query time instead of a pre-summed MV,
   or rebuild the rollups as `AggregatingMergeTree` over an idempotent,
   event-id-keyed state (e.g. `argMaxState`/`uniq`-based) rather than additive
   `sum`.

## 5. Requirement before horizontal scaling — HARD REQUIREMENT

Before scaling the API to more than one instance, **one** of the following MUST
be true:

1. **Exactly one dispatcher.** Run the dispatcher in a single dedicated worker
   process (not in every API replica), or add leader election so only one
   instance runs `runOutboxDispatcher()`. Today `apps/api/src/index.ts:253`
   starts it everywhere — this must be gated. **OR**
2. **Shard claims** by a hash of `aggregateId` so each dispatcher owns a
   disjoint slice (the worker comment at `outbox-dispatcher.ts:80-81` names this
   as the intended Plan-3 scale path). **AND**
3. Regardless of the above, the §4 aggregate double-count must be addressed,
   because a single-instance dispatcher can still re-deliver after a crash
   (§2). Single-instance only bounds the *rate* of duplicates; it does not make
   them impossible.

Do **not** add API replicas while the dispatcher is started unconditionally and
the summed aggregates remain non-idempotent.

## 6. Outgoing webhooks (lower severity)

Customer-facing webhook delivery is **single-flight** and does not share the
outbox's hazard:

- Delivery runs through BullMQ with **`concurrency: 1`**
  (`apps/api/src/workers/webhook-delivery.ts:317`) and a **shared repeatable
  `jobId: "webhook-delivery-repeatable"`** (line 300), so at most one delivery
  job runs at a time.
- Each delivery sends an **`x-rovenue-event-id`** header so receivers can
  dedup on their side (`apps/api/src/workers/webhook-delivery.ts:131`).
  (The separate integrations fan-out worker
  `apps/api/src/workers/integrations-deliver.ts` runs at `concurrency: 10` but
  carries its own dead-letter dedup, covered by
  `integrations-deliver.dead-letter-dedup.test.ts`.)

This is documented for completeness; it is not part of the scaling hazard
above.
