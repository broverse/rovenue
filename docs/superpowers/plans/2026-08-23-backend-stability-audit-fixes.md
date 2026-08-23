# Backend Stability Audit Fixes — Implementation Plan

> **STATUS 2026-08-24:** ALL 14 tasks implemented and committed on main
> (bbe40af6…), each with tests; full apps/api suite verification in this
> session. Task 5 was implemented as one-row-per-short-transaction (+
> savepoint + 20s Stripe client timeout) instead of a claim-column
> migration; Task 14 landed as migration 0103 (`purchases.lastStoreEventAt`)
> + `guardStatusWrite({ eventTime })` wired into Stripe/Apple/Google
> webhooks, receipt-verify, operator refunds, and the Google supersede
> path. Task 1 note: BullMQ 5.x guards its own Queue/Worker error events —
> the true crash vectors were the raw SSE/duplicate()/publisher
> connections, all now wrapped. P2 backlog below remains open.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 14 verified P0/P1 defects found by the 2026-08-23 six-domain backend audit (v1 routes, money path, workers, Redis, DB, analytics/billing) so every function is stable and working.

**Architecture:** Point fixes that mirror correct patterns already present elsewhere in the codebase (merge-aware resolve in stripe-webhook.ts, claim-then-send in send-email-worker.ts, delta-refund in applyChargeRefunded, id tiebreak in credit-ledger). No new subsystems.

**Tech Stack:** Hono + TS strict, Drizzle/Postgres, ioredis + BullMQ, ClickHouse, Vitest (+ testcontainers for integration).

**Spec:** The audit findings are reproduced inline per task below (file:line + failure scenario) — this document is self-contained.

## Global Constraints

- TypeScript strict; responses `{ data: T }` | `{ error: { code, message } }`; Zod for input.
- Postgres via Drizzle repositories only; raw `sql` must qualify columns (`"table"."col"`).
- No magic values — hoist literals into named constants.
- Outbox row in the same tx as domain writes; `audit()` inside caller's tx.
- Stay on the current branch (main). Conventional commits. No self-confirming tests (test with realistic data shapes — see Task 4's note about the fake `GPA.1` test).
- Verify with the real test runner; `apps/api` tests may need `DATABASE_URL` exported; some pre-existing red integration tests exist on main (integrations framework) — do not chase those.

---

## P0 tasks

### Task 1: Redis/BullMQ `error` handlers everywhere (crash prevention)

**Files:**
- Modify: `apps/api/src/lib/redis.ts` (add `attachRedisErrorLogger(conn, label)` helper or a `createManagedBullConnection()` wrapper)
- Modify (attach handler): every `createBullConnection()`/`new Redis`/`.duplicate()` site missing `.on("error")`:
  `workers/webhook-delivery.ts`, `webhook-retention.ts`, `webhook-reaper.ts`, `outbox-cleanup.ts`, `partition-maintenance.ts`, `scheduled-actions.ts`, `usage-cap-sweeper.ts`, `email.ts`, `funnel-abandoner.ts`, `funnel-token-expirer.ts`, `funnel-deferred-cleanup.ts`, `custom-domain-verifier.ts`, `custom-domain-cert-poller.ts`, `rovi-reaper.ts`, `rovi-retention.ts`, `refund-shield-responder.ts`, `expiry-checker.ts`, `services/webhook-processor.ts`, `services/fx.ts`, `integrations-boot.ts:39`, `routes/dashboard/integrations.ts:485-491`, `routes/v1/config-stream.ts:68`, `routes/dashboard/events-stream.ts:70`, `services/notifications/prefs-cache.ts:73`
- Also attach `.on("error")` on each BullMQ `Worker`/`Queue` instance in those files (BullMQ re-emits connection errors on the Worker/Queue; unhandled → process crash).

**Defect:** unhandled `'error'` events on ~18 ad-hoc ioredis connections + per-SSE clients crash the whole API process on any Redis blip.

**Fix pattern (already used in send-email-worker.ts:174 etc.):**
```ts
worker.on("error", (err) => log.error("worker error", { err: (err as Error).message }));
connection.on("error", (err) => log.error("redis error", { err: err.message }));
```
Prefer one helper in `lib/redis.ts` so the mistake can't recur:
```ts
export function attachRedisErrorLogger(conn: Redis, label: string): Redis {
  conn.on("error", (err: Error) => log.error(`${label} connection error`, { err: err.message }));
  return conn;
}
```

- [ ] Step 1: add helper; wire every listed site (grep `new Redis(`, `createBullConnection(`, `.duplicate(`, `new Worker(`, `new Queue(` under apps/api/src and verify each has an error handler after the change).
- [ ] Step 2: `pnpm --filter @rovenue/api exec vitest run src/workers --reporter=dot` (unit only) + `pnpm --filter @rovenue/api exec tsc --noEmit`.
- [ ] Step 3: Commit `fix(api): attach error handlers to every Redis/BullMQ connection so a Redis blip cannot crash the process`.

### Task 2: `billing/usage.ts` queries a dropped ClickHouse table

**Files:**
- Modify: `apps/api/src/services/billing/usage.ts:85-92`

**Defect:** `rovenue.mv_mrr_daily_target` was DROPped by CH migration 0012; `GET /dashboard/.../billing/usage` 500s and the usage-cap sweeper is inert whenever ClickHouse is configured.

**Fix:** query the replacement view (columns verified in 0014: `projectId`, `day`, `net_usd`):
```ts
const mtrCurrent = await chScalar(
  projectId,
  `SELECT toFloat64(sum(net_usd)) AS v
     FROM rovenue.v_mrr_daily
    WHERE projectId = {projectId:String}
      AND day >= toDate({start:String}) AND day < toDate({end:String})`,
  { start: isoStart, end: isoEnd },
);
```

- [ ] Step 1: write a failing unit test (mock `queryAnalytics`, assert the SQL references `v_mrr_daily` and not the dropped table) OR at minimum grep-assert no reference to `mv_mrr_daily_target` remains outside migrations.
- [ ] Step 2: apply, `tsc --noEmit`, run billing unit tests.
- [ ] Step 3: Commit `fix(billing): read MTR from v_mrr_daily — mv_mrr_daily_target was dropped in CH migration 0012`.

### Task 3: platform billing `charge.refunded` double-counts multi-step refunds

**Files:**
- Modify: `apps/api/src/services/billing/webhook-handlers/handle-charge-refunded.ts:23`
- Test: sibling of `claim.test.ts` in the same dir.

**Defect:** `charge.amount_refunded` is Stripe's cumulative total; `incrementRefundedAmount` is additive → two partial refunds over-state `billing_invoices.refundedAmount`.

**Fix (mirror `applyChargeRefunded`, stripe-webhook.ts:982-995):**
```ts
const cumulativeRefunded = charge.amount_refunded ?? 0;
const latestRefund = charge.refunds?.data?.[0];
const refundedMinor = latestRefund?.amount ?? cumulativeRefunded;
const delta = (refundedMinor / 100).toFixed(4);
```

- [ ] Step 1: failing test — event with `amount_refunded: 700` and `refunds.data[0].amount: 400` must increment by 4.0000, not 7.0000.
- [ ] Step 2: implement, tests green.
- [ ] Step 3: Commit `fix(billing): charge.refunded records the per-refund delta, not Stripe's cumulative total`.

### Task 4: Google Play merchant refund sends purchase token as `orderId`

**Files:**
- Modify: `apps/api/src/services/refunds/refund-transaction.ts:112,155-159`
- Modify: `apps/api/src/services/refunds/refund-transaction.test.ts` (replace the self-confirming `GPA.1` fixture with a purchase-token-shaped `storeTransactionId`)

**Defect:** for PLAY_STORE purchases `storeTransactionId` is always the purchase token; `androidpublisher.orders.refund` requires a `GPA.xxxx` order id → every dashboard-initiated Google refund fails (`store_error`).

**Fix:** before calling `orders.refund`, resolve the real order id: fetch `purchases.subscriptionsv2.get(packageName, token)` and take `effectiveGoogleOrderId` (already implemented in `google-mappers.ts` — reuse it; for one-time products use `purchases.products.get(...).orderId`). Fall back to error `order_id_unresolved` if absent.

- [ ] Step 1: failing test — PLAY_STORE purchase with token-shaped `storeTransactionId`; assert `orders.refund` is invoked with the `GPA...` id returned by the mocked `subscriptionsv2.get`.
- [ ] Step 2: implement; keep `revoke: true` semantics unchanged.
- [ ] Step 3: Commit `fix(refunds): resolve the real Google order id before orders.refund — storeTransactionId is the purchase token`.

### Task 5: HTTP calls inside claimed-batch transactions (scheduled-actions, refund-shield)

**Files:**
- Modify: `apps/api/src/workers/scheduled-actions.ts:43-76,181-196`
- Modify: `apps/api/src/workers/refund-shield-responder.ts:127-178`
- Tests: existing `scheduled-actions.integration.test.ts`, `refund-shield-responder.test.ts` must stay green; add coverage that a claimed row is finalized outside the claiming tx.

**Defect:** `claimDueBatch`(200 rows)/`claimPendingResponses`(50 rows) + a loop of live Stripe/Apple HTTP calls run inside ONE `db.transaction` → row locks + a pooled connection held for the whole batch duration (Stripe default timeout ~80s/call); pool starvation + stuck ticks.

**Fix (pattern already used by webhook-delivery.ts):** claim in a short tx that also flips rows to an in-flight status (or relies on the existing claimed-at marker used by that table's reaper); commit; loop outside any tx; per-row terminal status write in its own short tx; per-row try/catch so one bad row doesn't poison the batch. Check each table's claim contract first (`packages/db/src/drizzle/repositories/scheduled-actions.ts:102-104` documents lock-until-commit — the repo function's contract must be updated to a status-claim instead of lock-claim, with a reaper path for rows claimed by a crashed process; if a claimed-status + `claimedAt` timeout re-claim column does not exist, add it via migration mirroring `webhook_deliveries`' claim columns).

- [ ] Step 1: read both repos; decide claim-column shape; write migration if needed.
- [ ] Step 2: restructure both workers; failing-then-green tests.
- [ ] Step 3: Commit `fix(workers): claim scheduled-actions/refund-shield batches in a short tx — no HTTP inside held row locks`.

## P1 tasks

### Task 6: merge-chain bypass in 5 SDK write paths

**Files:**
- Modify: `apps/api/src/services/subscriber-config.ts:34-55`; `routes/v1/events.ts:151-158`; `routes/v1/sdk-sessions.ts:107-115`; `routes/v1/experiments.ts:93-100,177-184`; `routes/v1/subscribers.ts:130-178`
- Reference implementation: `services/stripe/stripe-webhook.ts:1108-1159` (`resolveSubscriberByRovenueId` first; create only when both resolve and direct find return null; never resurrect dead-ended/anonymized rows).

**Defect:** bare `upsertSubscriber`/`findSubscriberAttributesByRovenueId` hit the soft-deleted row after a `/v1/subscribers/transfer` merge (unique index is full, not partial) → flags/experiments/attribution permanently fork onto a dead subscriber.

**Fix:** extract a small shared helper (e.g. `resolveOrCreateSubscriberByRovenueId(tx, projectId, rovenueId, attrs?)` in `lib/` if not already covered by `resolve-or-create-subscriber.ts` — check first; it may just need reusing) and swap it in at all 5 sites.

- [ ] Step 1: failing integration-style test: transfer A→B, then POST attributes/track for A's rovenueId; assert the write lands on B (mergedInto target), not the soft-deleted row.
- [ ] Step 2: implement all 5 sites via the shared helper.
- [ ] Step 3: Commit `fix(api): SDK write paths resolve the subscriber merge chain before upserting — no more writes to soft-deleted rows`.

### Task 7: `payment_method.detached` never dispatches

**Files:**
- Modify: `apps/api/src/services/billing/webhook-handlers/index.ts:62-68`
- Test: same dir.

**Defect:** Stripe nulls `PaymentMethod.customer` during detach → `extractCustomerId` returns null → handler never runs; detached cards linger in `billing_payment_methods`.

**Fix:**
```ts
function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data.object as { customer?: string | { id: string } | null };
  const prev = (event.data.previous_attributes as { customer?: string | { id: string } | null } | undefined)?.customer;
  const cust = obj.customer ?? prev ?? null;
  if (!cust) return null;
  return typeof cust === "string" ? cust : cust.id;
}
```

- [ ] Step 1: failing test — `payment_method.detached` event with `data.object.customer: null` + `previous_attributes.customer: "cus_x"` resolves the project and calls the handler.
- [ ] Step 2: implement. Commit `fix(billing): resolve payment_method.detached customer from previous_attributes`.

### Task 8: Redis error skips the DB fallback (funnels + custom domains)

**Files:**
- Modify: `apps/api/src/services/funnel/runtime-cache.ts:19-22` (read+write), `apps/api/src/services/custom-domains/host-resolver.ts:37-73`
- Pattern: `services/flag-engine.ts:105-125` (try/catch, log, fall through to DB).

**Defect:** unguarded `redis.get/set` throws before the `?? loadFromDb()` fallback evaluates → funnel page/session + host lookup 500 during any Redis blip (money path).

- [ ] Step 1: failing unit test with a rejecting redis mock — function must still return the DB value.
- [ ] Step 2: wrap in try/catch (return null on read error; ignore write error), matching flag-engine.
- [ ] Step 3: Commit `fix(api): funnel runtime cache and host resolver fall back to Postgres on Redis errors`.

### Task 9: audit hash chain tiebreak

**Files:**
- Modify: `apps/api/src/lib/audit.ts:312-323` — `.orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))`
- Pattern: `packages/db/src/drizzle/repositories/credit-ledger.ts:70-76`.

**Defect:** same-millisecond serialized writes can pick the wrong chain tip → forked chain / false `broken_link`.

- [ ] Step 1: add tiebreak + a unit test writing two entries with a frozen clock and asserting the third links to the second.
- [ ] Step 2: Commit `fix(api): deterministic audit-chain tip lookup — id tiebreak for same-millisecond writes`.

### Task 10: integrations-deliver dead-letter on attempts exhaustion

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts:178-197,470-477`
- Pattern: `send-email-worker.ts:138-172` (`failed` handler checks `job.attemptsMade >= attempts`).

**Defect:** in-processor `attempt >= INTEGRATIONS_DELIVER_ATTEMPTS` is dead code (BullMQ increments `attemptsMade` after the final attempt); exhausted retriable failures never reach `dead_letter`/audit/Sentry/live-event.

**Fix:** in `worker.on("failed")`, when `job.attemptsMade >= (job.opts.attempts ?? INTEGRATIONS_DELIVER_ATTEMPTS)`, run the same finalization as the direct dead-letter branch (`updateDeliveryStatus("dead_letter")`, `auditDeadLetter`, `captureSentry`, `publishLiveEvent`), idempotently.

- [ ] Step 1: failing test — retriable failure with attemptsMade at the cap in the failed-handler path finalizes the row as `dead_letter`.
- [ ] Step 2: implement; remove or fix the dead in-processor branch (keep one source of truth).
- [ ] Step 3: Commit `fix(integrations): exhausted retries finalize deliveries as dead_letter — the in-processor check never fired`.

### Task 11: invitation email single-flight claim

**Files:**
- Modify: `apps/api/src/workers/email.ts:59-97`, `packages/db/src/drizzle/repositories/invitations.ts` (claim function)
- Pattern: `send-email-worker.ts:62-71` (`claimDeliveryForSend`).

**Defect:** no atomic pre-send claim → crash between provider send and `patchSendResult`, or a stalled-job reprocess, sends the invite twice.

**Fix:** add `claimInvitationForSend(db, id)` (conditional UPDATE ... WHERE not-yet-claimed RETURNING) and bail when it returns nothing; persist result after send as today.

- [ ] Step 1: failing test — second concurrent/reprocessed run is a no-op.
- [ ] Step 2: implement + commit `fix(api): single-flight claim before invitation email send`.

### Task 12: Apple `DID_CHANGE_RENEWAL_PREF` (immediate upgrade) handler

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts:320-349` (dispatch switch + new `applyRenewalPrefChange`)
- Test: apple-webhook tests alongside existing renewal tests.

**Defect:** immediate cross-grade notification is ignored → no new-tier purchase row, no access grant, no upgrade revenue until next DID_RENEW.

**Fix:** `case DID_CHANGE_RENEWAL_PREF:` with subtype `UPGRADE` → treat `signedTransactionInfo` like `applySubscribed`/`applyRenewal` (upsert purchase, grant accessIds, emit dedupe-keyed revenue event); other subtypes (`DOWNGRADE`, none = plan-change-at-renewal) only record the pending change (no state/revenue effect now). Optionally mark the prior transaction superseded using `isUpgraded`.

- [ ] Step 1: failing test — UPGRADE notification creates the new product's purchase + access + one revenue event; replay is a no-op; DOWNGRADE subtype changes nothing now.
- [ ] Step 2: implement + commit `fix(apple): handle DID_CHANGE_RENEWAL_PREF UPGRADE — grant and count the immediate cross-grade`.

### Task 13: Google `linkedPurchaseToken` — expire the superseded purchase

**Files:**
- Modify: `apps/api/src/services/google/google-webhook.ts:304-305` and `services/receipt-verify.ts:490-491` (shared helper)

**Defect:** old-token purchase row stays ACTIVE with its frozen expiry after upgrade/downgrade; access engine unions all rows → old tier stays granted up to a full period.

**Fix:** when `linkedPurchaseToken` present, look up the purchase by (projectId, PLAY_STORE, oldToken) and, via `guardStatusWrite`, transition it to EXPIRED (with `expiresDate = now` semantics used elsewhere), then `syncAccess` in the same flow. Idempotent on replay.

- [ ] Step 1: failing test — replacement notification expires the old row and revokes its accessIds while the new row grants the new ones.
- [ ] Step 2: implement + commit `fix(google): expire the linkedPurchaseToken predecessor so replaced subscriptions stop granting the old tier`.

### Task 14: stale-event regression guard (event-time ordering)

**Files:**
- Migration: add `lastStoreEventAt timestamptz` to `purchases` (drizzle migration via `pnpm db:migrate:generate`)
- Modify: `apps/api/src/services/subscription-transition-guard.ts:66-129` (optional `eventTime` param: withhold status write when `eventTime < lastStoreEventAt`; stamp `lastStoreEventAt` on applied writes)
- Thread from callers: Stripe `event.created`, Apple `signedDate`, Google RTDN `publishTime`/`eventTimeMillis`.

**Defect:** legal-but-stale transitions (retry-reordered `ACTIVE` after `GRACE_PERIOD`) silently regress state and re-grant access to delinquent subscribers.

**Fix semantics:** only *status* writes are withheld on stale events (non-status field syncs may still apply); missing `eventTime` (older rows/backfill) behaves as today (no regression risk added).

- [ ] Step 1: failing integration test — apply GRACE_PERIOD@t2 then ACTIVE@t1 (t1<t2): status stays GRACE_PERIOD; ACTIVE@t3 applies.
- [ ] Step 2: implement + commit `fix(api): purchase status writes reject store events older than the last applied one`.

## P2 backlog (fix opportunistically, not required for this batch)

- `apple-webhook.ts:493-497` — don't stamp `refundDate` when the guarded status write is withheld (one-line, fold into Task 12's file if touched).
- `config-stream.ts` subscribe-before-initial-evaluate gap (self-heals; note only).
- `metrics/ltv-prediction.ts:40-72` unbounded CH scan — add MAX_DAYS clamp like siblings.
- `metrics/charts.ts:523-540` missing `FINAL` (currently harmless with `uniq`) — add for consistency.
- SSE per-connection Redis clients: multiplex via one shared subscriber per process (larger refactor; separate plan).
- Magic-link nonce Redis errors → explicit 503 instead of generic 500.
- Dead code: `subscriber-transfer.ts`'s unkeyed `anonymizeSubscriber` — delete (real path is `gdpr/anonymize-subscriber.ts`).

## Self-review notes

- Every task cites the verified file:line from the audit and an existing in-repo reference pattern; no invented APIs except Task 5/14's claim/`lastStoreEventAt` columns, which are explicitly called out as migrations.
- Tasks are independent; order chosen P0→P1 by blast radius. Task 5 and 14 are the two that add schema — do them with fresh attention, not batched with others.
