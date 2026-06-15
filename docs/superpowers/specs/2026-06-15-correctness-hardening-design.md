# Correctness Hardening — Idempotency, State Machine & Money Accuracy

**Date:** 2026-06-15
**Status:** Design / spec (awaiting plan)
**Author:** review-driven (V. Furkan + Claude)

## Problem

A read-only review of the Rovenue backend found the platform broadly stable
(typecheck clean, 837 unit tests green, store-signature verification fails
closed, dashboard RBAC/IDOR discipline sound) but surfaced a cluster of real
correctness bugs concentrated on the **money / access path**. The common theme
is **broken idempotency and "exactly-once" guarantees** plus a **state machine
that is defined, tested, but never wired in**. Left unfixed, these silently
double-count revenue, resurrect refunded subscriptions, deliver duplicate
external side effects, and miscompute LTV/refund signals.

Scope decision (confirmed with user): **fix all findings**, sequenced by
priority. Two behavioral decisions are already settled:

- Illegal status transitions → **reject + write an audit-log entry** (keep
  current status; the transition is ignored, not applied).
- Single-transaction Apple refunds → **keep current full-chain access revoke**
  (this is intentional/conservative behavior, NOT a bug; documented here so it
  is not "fixed" later by mistake).

## Goals

1. Subscription status writes pass through the existing state machine; illegal
   transitions are rejected and audited.
2. Every webhook/job ingestion path that mutates money or access is idempotent
   under at-least-once delivery and concurrent replicas.
3. Money aggregates (LTV, refund signals, MRR decomposition) are arithmetically
   correct and internally consistent.
4. No regression to the 837 green unit tests; new behavior is test-covered.

## Non-Goals

- Changing the full-chain refund revoke semantics (see above).
- Re-architecting the outbox/dispatcher (its at-least-once + CH query-time
  dedup is already correct by design).
- Broad refactors unrelated to the findings.

---

## Findings & Fixes

Ordered by priority. Each fix is independently shippable.

### P0-1 — Wire the subscription state machine into the write path

**Bug:** `apps/api/src/services/subscription-state.ts` defines `TRANSITIONS`,
`validateTransition`, `allowedTransitions` — but grep confirms **zero
production call sites**. All status writes go straight into `upsertPurchase`
(`receipt-verify.ts:190`, `apple-webhook.ts`, `google-webhook.ts`,
`stripe-webhook.ts`) which overwrites `status` unconditionally. A late/out-of-
order `DID_RENEW` after a `REFUND` flips `REFUNDED → ACTIVE`, resurrecting
refunded revenue and re-granting access. The `TRANSITIONS` table already
encodes the intended rules (REFUNDED/REVOKED terminal; EXPIRED→ACTIVE/TRIAL
allowed for resubscribe) — it just isn't enforced.

**Fix:** Introduce a single guarded enforcement point that all status-changing
write paths go through. Within the caller's existing Drizzle transaction:

1. Read the current purchase row (by natural key: store + storeTransactionId)
   `FOR UPDATE` so concurrent webhooks serialize.
2. If no existing row → first insert, allowed (no `from` state).
3. If existing → `validateTransition(current.status, nextStatus)`:
   - **valid:** apply the status write (plus the other field updates:
     expiresDate, priceAmount, priceCurrency).
   - **invalid:** **do not** write `status`; still apply non-status field
     corrections (price/expiry can legitimately arrive late); write an
     `audit_logs` entry `rejected_status_transition` with `{ from, to, store,
     storeTransactionId, notificationType }` via the existing `audit()` helper
     (runs in the same tx, joins the per-project hash chain).

The guard lives next to `upsertPurchase` (e.g. `applyPurchaseStatusTransition`
in `repositories/purchases.ts`) so the four ingestion paths share one
implementation. Normalizers (`normalizeStatus`) are unchanged.

**Edge note (open decision OD-1):** `normalizeAppleStatus` maps
`DID_FAIL_TO_RENEW` *without* a grace subtype to `ACTIVE`. A failed renewal
that is not in grace is billing-limbo, not active. Proposed change → map to
`GRACE_PERIOD` (keep access during Apple's billing-retry window). Flagged for
confirmation at spec review.

### P0-2 — Route Google / Stripe / billing webhooks through `claimWebhookEvent`

**Bug:** Apple uses the atomic single-flight `claimWebhookEvent`
(`ON CONFLICT DO UPDATE ... setWhere status NOT IN ('PROCESSING','PROCESSED')`,
returns `null` to all but one concurrent caller). Google (`google-webhook.ts:91`),
store-Stripe (`stripe-webhook.ts:112`), and billing-Stripe
(`billing/webhook-handlers/index.ts:101`) instead use `upsertWebhookEvent`
(a no-op `ON CONFLICT` that returns the existing row) and guard only with
`if (status === PROCESSED)`. They never check `PROCESSING`. With worker
`concurrency: 8` + BullMQ `attempts: 5`, two concurrent deliveries of the same
event both pass the guard and both run `createRevenueEvent` + access writes →
duplicated revenue events and double-applied `incrementRefundedAmount` (a
relative increment, so genuinely double-counts).

**Fix:** Replace the `upsertWebhookEvent`+`=== PROCESSED` pattern with
`claimWebhookEvent` in all three handlers. A `null` return means another worker
holds or finished the event → return early as duplicate (mirror Apple's
handling). Billing's `RECEIVED` status semantics fold into the claim's
`PROCESSING`. `claimWebhookEvent` already re-claims `FAILED`/`RECEIVED` rows so
BullMQ retries still re-process legitimately.

### P0-3 — Make outbound webhook delivery claim atomic across replicas

**Bug:** `webhook-delivery.ts:52` calls `claimPendingWebhooks` (which uses
`FOR UPDATE OF w SKIP LOCKED`) **outside any transaction**. Under autocommit the
row locks release the instant the SELECT returns, so the HTTP POST + status
UPDATE run unlocked. The worker has no instance gate (unlike the outbox
dispatcher), so two replicas polling the same cadence both claim the same
PENDING rows → duplicate deliveries to customer endpoints.

**Fix:** Convert the claim into an **atomic status-flip claim**: a single
statement that selects due rows `FOR UPDATE SKIP LOCKED` and immediately flips
them to an in-flight status (e.g. `DELIVERING`) `RETURNING` the payload — all in
one short transaction that commits before any HTTP I/O. Other replicas no longer
see those rows. The HTTP call and final status write happen after, outside the
lock. Add a **stale-claim reaper**: rows stuck in `DELIVERING` past a visibility
timeout (e.g. 5 min — a crashed replica) are returned to `PENDING`/`FAILED` for
redelivery. This preserves at-least-once (acceptable for webhooks; consumers
must dedupe on our signed `id`) while eliminating the concurrent double-claim.

**Sub-fix (P2, same file):** backoff off-by-one — `newAttempts >= MAX_ATTEMPTS`
dead-letters after 4 attempts, never reaching the 5th (12h) backoff entry. Align
the comparison/array so all `MAX_ATTEMPTS` attempts occur.

### P0-4 — `integration_deliveries` dedupe that actually dedupes

**Bug:** The dedupe relies on `onConflictDoNothing()` returning `undefined`, but
the unique index is `(connection_id, outbox_event_id, created_at)` with
`created_at = now()` — every insert gets a fresh timestamp so the conflict never
fires. On BullMQ retry-after-success or concurrent workers, Meta CAPI / TikTok
`deliver()` is called again → duplicate conversion events to ad platforms.

**Hard constraint:** `integration_deliveries` is `PARTITION BY RANGE
(created_at)` (pg_partman). **Postgres requires the partition key in every
unique index on a partitioned table** — so the agent-suggested fix of dropping
`created_at` to make the key `(connection_id, outbox_event_id)` is *impossible*.
A real fix must work around the partition constraint.

**Open decision OD-2 — choose dedupe strategy:**

- **(A) Provider-side idempotency keys (recommended).** Send a stable event id
  (the existing `event_key` / `outbox_event_id`) as the provider's native
  idempotency/dedup field — Meta CAPI `event_id`, TikTok `event_id`. Duplicate
  HTTP calls become harmless because the ad platform dedupes server-side. No
  schema change; combined with the BullMQ jobId dispatch dedup already present,
  this closes the retry-after-success gap directly. Verify each provider adapter
  actually emits the key.
- **(C) Separate unpartitioned dedup/claim table.** A small
  `integration_delivery_keys(connection_id, outbox_event_id) UNIQUE` table;
  insert-or-conflict there *before* calling the provider. Robust application-
  level single-flight, but adds a table + write per delivery.

Recommendation: **A** (cheapest, no migration, leverages provider guarantees),
falling back to C only if a target provider lacks event-level dedup.

### P1-5 — Email / push workers re-send on retry

**Bug:** `send-email-worker.ts` and `send-push-worker.ts` send via the provider
*then* write delivery-row status. A crash between send and `markDeliveryStatus`
(or a throw in the mark) makes BullMQ retry the whole job → duplicate
email/push. Neither reads current status to short-circuit. SES does not dedupe
on `correlationId`.

**Fix:** Before sending, read the delivery row; if already `sent`, short-circuit.
Mark an in-flight/`sent` state so a retry observes it. Where the provider
supports an idempotency key, pass the stable `deliveryId`. This is at-least-once
hardening, not exactly-once, but removes the common duplicate-on-retry window.

### P1-6 — `webhook_events` retention DELETE is unbounded

**Bug:** `deleteWebhookEventsOlderThan` issues one
`DELETE ... WHERE createdAt < cutoff .returning({ id })` — no batch/LIMIT, and
`.returning()` pulls every deleted id into Node memory just to produce a count.
On a busy project this is a long table-wide lock + WAL spike + potential OOM.

**Fix:** Batch like the sibling `outbox-cleanup` worker (e.g. 10k/batch, bounded
loop), use `rowCount`, drop `.returning()`.

### P1-7 — Cross-tenant injection on SDK public-key endpoints

**Bug A — `/v1/experiments/:id/expose` (`routes/v1/experiments.ts:65`):**
`experimentId`/`subscriberId`/`variantId` are taken from the caller and written
to the outbox stamped with the caller's `projectId`, with no check that the
experiment/subscriber belong to that project. Any shipped public key can poison
another tenant's experiment analytics (exposure counts, SRM, conversion
denominators). The sibling `/track` handler does it right (project-scoped
upsert first).

**Bug B — `/v1/sdk/sessions` (`routes/v1/sdk-sessions.ts:71`):** `subscriberId`
from the body is produced to Kafka untrusted, corrupting the engagement
aggregates that feed Refund Shield decisioning.

**Fix:** Both handlers resolve/verify the subscriber within `project.id` (mirror
`/track` and `/me`), and `expose` asserts `experiment.projectId === project.id`
before publishing.

### P1-8 — Money rounding & lifetime/MRR consistency (ClickHouse)

**Bug:** Migration 0012 `v_revenue_lifetime_subscriber` uses
`toUInt64(amountUsd * 100)` — binary-float multiply then truncate, losing a cent
(`$19.99 → 1998¢`). It also counts only `type = 'REFUND'` as a refund and omits
`CHARGEBACK` (and `REACTIVATION`), whereas `v_mrr_daily` correctly treats
`CHARGEBACK` as a refund — so LTV and MRR disagree, and chargebacks vanish from
net lifetime value.

**Fix:** New CH migration replacing the affected view(s): use
`toUInt64(round(amountUsd * 100))`; include `CHARGEBACK` in the refund side (and
`REACTIVATION` in the revenue side) so lifetime value reconciles with MRR. Cover
with the existing CH integration-test harness. (Note: CH `AS e FINAL` alias rule
and integration-env mutation apply — see project conventions.)

### P2-9 — MRR decomposition buckets

**Bug:** `mrr-decomposition.ts:29` puts INITIAL+TRIAL_CONVERSION in `new`,
REACTIVATION (only) in `expansion`, REFUND+CHARGEBACK in `churned` — `RENEWAL`
lands in no bucket, so the decomposition never reconciles to the net MRR delta,
and "expansion" is mislabeled winback.

**Fix:** Re-bucket so the components sum to the MRR delta: account for RENEWAL,
and label reactivation/winback distinctly from true expansion. Exact bucket
definitions to be pinned in the plan against `v_mrr_daily`.

### P2-10 — Rate limiter trusts spoofable `X-Forwarded-For`

**Bug:** `rate-limit.ts:26` keys on `x-forwarded-for.split(',')[0]` with no
trusted-proxy hop count, so a client rotating the header defeats the global
pre-auth IP limiter (authenticated `/v1` + dashboard limiters key on
apiKeyId/userId and are fine).

**Fix:** Derive client IP from a configured trusted-proxy depth
(`TRUSTED_PROXY_COUNT` env, conservative default for the Coolify/Caddy deploy),
taking the Nth-from-last hop. Document the env in `.env.example`.

---

## Cross-cutting design notes

- **One enforcement point per concern.** P0-1 centralizes status transitions;
  P0-2 standardizes all stores on `claimWebhookEvent`; P1-5 standardizes
  send-then-mark into claim-then-send. We are removing per-path divergence, the
  root cause of most findings.
- **At-least-once stays the model.** We are not chasing exactly-once. We make
  the *effects* idempotent (claims, provider idempotency keys, status guards) so
  duplicate deliveries are harmless.
- **Audit chain.** Rejected transitions use the existing in-tx `audit()` so the
  rejection commits/rolls back atomically with the domain write and joins the
  per-project SHA-256 hash chain.

## Testing strategy

- **P0-1:** unit tests for the guard (valid transition applies; REFUNDED→ACTIVE
  rejected + audit row written; non-status fields still update on rejection;
  first-insert allowed). Integration test for concurrent out-of-order webhooks.
- **P0-2:** concurrency integration test mirroring the existing Apple
  `apple-webhook.concurrency.integration.test.ts` for Google + Stripe + billing.
- **P0-3:** integration test — two simulated pollers claim disjoint row sets;
  stale `DELIVERING` reaper returns crashed claims.
- **P0-4:** test that a second `deliver()` for the same `(connection, outbox
  event)` sends the same provider idempotency key (A) / is blocked (C).
- **P1-5:** retry after simulated post-send crash does not re-send.
- **P1-6:** retention deletes in bounded batches; row count correct.
- **P1-7:** expose/sessions reject or scope cross-tenant ids.
- **P1-8/P2-9:** CH integration tests for rounding + lifetime/MRR reconciliation.
- Full suite (`pnpm test`) green; no regression to the 837 unit tests.

## Sequencing

P0-1 → P0-2 → P0-3 → P0-4 (the four correctness-critical idempotency/state
fixes), then P1-5 → P1-6 → P1-7 → P1-8, then P2-9 → P2-10. Each lands as its own
commit with tests; the plan will break these into ordered tasks.

## Resolved decisions

- **OD-1 (resolved):** Map Apple `DID_FAIL_TO_RENEW` without a grace subtype to
  `GRACE_PERIOD` (was `ACTIVE`). Keeps access during Apple's billing-retry window
  and stops counting billing-limbo subs as active revenue.
- **OD-2 (resolved):** `integration_deliveries` dedupe via **provider-side
  idempotency keys (A)** — send the stable `outbox_event_id` as Meta CAPI /
  TikTok `event_id`. No schema change. Postgres forbids a unique index without
  the partition key, so the index can never enforce 2-column dedupe; the
  existing `(connection_id, outbox_event_id, created_at)` unique index is
  misleading and will be simplified/removed since it guarantees nothing.
