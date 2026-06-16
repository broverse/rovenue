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
                                                    │  (query-time VIEW; dedup via FINAL / GROUP BY eventId)
                                          v_mrr_daily / v_credit_* / v_revenue_lifetime_subscriber
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
eventId via ReplacingMergeTree" — true at the raw layer, and as of migration
`0012` the money/credit aggregates also collapse duplicates before summation;
see §4.)

## 3. Horizontal-scaling hazard — gated by the single-dispatcher contract

The dispatcher run is **gated by `OUTBOX_DISPATCHER_ENABLED`** (default
`true`):

```
apps/api/src/index.ts:255   if (env.OUTBOX_DISPATCHER_ENABLED) void runOutboxDispatcher();
```

In `docker-compose.yml` exactly one service runs it: a **dedicated
`dispatcher` service** pinned to `replicas: 1` whose entrypoint is
`apps/api/src/workers/outbox-dispatcher-process.ts`. Every other service —
`api` and all auxiliary workers — sets `OUTBOX_DISPATCHER_ENABLED=false`.
`dispatcher-guard.test.ts` asserts this contract in CI (api + workers `false`,
a dedicated `dispatcher` service `true` at one replica).

The *hazard* this guards against: if the dispatcher ran in **more than one
instance**, every instance would run its own loop. `SKIP LOCKED` prevents two
dispatchers from claiming the *same* row in the *same instant*, but because the
claim tx commits before publish, a row published by instance A but not yet
`markPublished` is fully claimable by instance B — so the same `eventId` is
**published to Kafka more than once, concurrently**. Combined with §2 this
multiplies the duplicate *rate*. Since migration `0012` (§4) this no longer
corrupts any aggregate — it only adds redundant collapsed rows and wasted
ingest work — so it is an efficiency hazard, not a correctness one. Extracting
the dispatcher into its own one-replica service is what lets `api` scale
horizontally without tripping it (the other in-process API workers are BullMQ
jobId-idempotent or `FOR UPDATE SKIP LOCKED`, safe across replicas).

## 4. Why it is safe downstream — raw layer and aggregates

Duplicate Kafka delivery is safe **only if every downstream consumer collapses
duplicates on the event id**. ClickHouse does this at the raw-table layer
(`ReplacingMergeTree`) and — as of migration `0012` (2026-05-29) — at the
money/credit aggregate layer too, which is now query-time `FINAL` / `GROUP BY
eventId` over those deduped raw tables rather than additive materialized views.

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

### Money/credit aggregates — dedup-safe as of migration `0012` (2026-05-29)

These aggregates **used to** double-count. A ClickHouse materialized view fires
on **each insert block written to its source table**, *before* the
`ReplacingMergeTree` dedup merge runs, so the former additive rollup MVs
(`SummingMergeTree` / `AggregatingMergeTree` `sumState` columns) read
`FROM raw_revenue_events` / `FROM raw_credit_ledger` at MV-trigger time and
**added a duplicate delivery's insert block a second time**. `FINAL` on a
summed/aggregated rollup only finishes pending same-key merges; it could not
remove a duplicate's contribution, because the duplicate had already been
folded into the sum as a distinct insert.

Migration `0012` **drops those four additive rollups and replaces each with a
query-time `VIEW`** over the deduped raw `ReplacingMergeTree` tables. A
duplicate `eventId` is now collapsed **before** any summation, so the
at-least-once dispatcher (§2) — and even a misconfigured multi-dispatcher
deployment (§3) — **can no longer inflate revenue or credit totals**:

| View (replaces) | Dedup mechanism | What it serves |
|---|---|---|
| `rovenue.v_mrr_daily` (was `mv_mrr_daily_target`, `0006`) | `FROM raw_revenue_events FINAL` collapses the duplicate `eventId` before `sumIf`/`count`; `uniq(subscriberId)` for active subs | daily MRR — `gross_usd`, `refunds_usd`, `net_usd`, `event_count`, `active_subscribers` counted once |
| `rovenue.v_revenue_lifetime_subscriber` (was `revenue_lifetime_subscriber_tbl`, `0011`) | inner `GROUP BY eventId` (immutable business fields → `any()`), then per-subscriber sum; `proj_by_subscriber` projection serves the lookup as an index seek | Refund Shield's Apple consumption-request responder — `lifetime_dollars_purchased_cents` / `lifetime_dollars_refunded_cents` counted once |
| `rovenue.v_credit_consumption_daily` (was `mv_credit_consumption_daily_target`, `0008`) | `FROM raw_credit_ledger FINAL` before `sumIf`/`count` | daily credit flow — `granted_credits`, `debited_credits`, `net_flow`, `event_count` counted once |
| `rovenue.v_credit_balance` (was `mv_credit_balance_target`, `0007`) | `FROM raw_credit_ledger FINAL` before `argMax`/`sumIf` | per-subscriber `latest_balance` / `total_granted` / `total_debited` counted once |

The three read paths that touched the old rollups (`services/metrics/mrr.ts`,
`services/metrics/credits.ts`, `services/refund-shield/aggregate-signals.ts`)
now read these views; a duplicate-`eventId` regression test
(`apps/api/tests/revenue-aggregates-idempotency.integration.test.ts`) guards
the property. See
`docs/superpowers/specs/2026-05-29-idempotent-revenue-aggregates-design.md`.

**Consequence:** MRR / net revenue / lifetime $ purchased+refunded / daily
credit flow / credit balance are now correct under duplicate delivery, and
Refund Shield's lifetime-$ signal can no longer be skewed by re-delivery. The
delivery layer itself is unchanged (still at-least-once, §2), so a duplicate
still *occurs*; it is simply collapsed before it can affect a total.

## 5. Horizontal scaling — single-leader gate IMPLEMENTED

Option 1 below is now **in place**: the dispatcher is gated by
`OUTBOX_DISPATCHER_ENABLED` and runs only in the dedicated `dispatcher`
service (§3). The API is therefore free to scale to N replicas
(`API_REPLICAS`) — see `docs/operations/deployment-rehberi.md` §11.

The two designs that were considered:

1. **Exactly one dispatcher.** ✅ Implemented — the dispatcher runs in a single
   dedicated worker process (`outbox-dispatcher-process.ts`, `replicas: 1`),
   not in every API replica. `apps/api/src/index.ts:255` gates the in-process
   start behind `OUTBOX_DISPATCHER_ENABLED`, which compose forces `false`
   everywhere except the `dispatcher` service.
2. **Shard claims** by a hash of `aggregateId` so each dispatcher owns a
   disjoint slice (the worker comment at `outbox-dispatcher.ts:80-81` names this
   as the eventual multi-dispatcher scale path). **Not needed yet** — a single
   dispatcher comfortably handles current volume; revisit only if outbox
   publish throughput becomes the bottleneck.

Note the §4 aggregate double-count that *previously* made single-instance a
hard correctness blocker is independently **resolved** by migration `0012`:
the money/credit aggregates collapse duplicate `eventId`s before summation, so
even an accidental multi-dispatcher deployment (§3) can no longer corrupt
revenue/credit totals — it only produces redundant collapsed rows and wasted
ingest work. The single-dispatcher contract now bounds the duplicate *rate*
for efficiency; correctness no longer depends on it.

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
