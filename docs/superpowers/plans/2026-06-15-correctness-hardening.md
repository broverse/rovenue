# Correctness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the idempotency, state-machine, and money-accuracy bugs found in the backend review so revenue and access can no longer be double-counted, resurrected, or miscomputed.

**Architecture:** Each fix removes a per-path divergence by funnelling a concern through one enforcement point: status writes through the existing state machine; all store webhooks through the atomic `claimWebhookEvent`; outbound delivery through an atomic status-flip claim; ad-platform deliveries made harmless via provider idempotency keys. At-least-once stays the delivery model — we make the *effects* idempotent.

**Tech Stack:** Hono + TypeScript, Drizzle ORM (Postgres 16, pg_partman), ClickHouse views, BullMQ, Kafka/Redpanda, Vitest (+ testcontainers for `*.integration.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-15-correctness-hardening-design.md`

**Conventions:**
- TDD: write the failing test, see it fail, implement, see it pass, commit.
- Stay on the current branch (do not create/switch branches).
- Conventional commits.
- Run unit tests: `pnpm --filter @rovenue/api exec vitest run <path>`
- CH integration tests mutate `env` (frozen at import) and use `AS e FINAL` (never `FINAL AS e`).

---

## File Map

| File | Responsibility | Tasks |
|------|----------------|-------|
| `apps/api/src/services/subscription-state.ts` | state machine + normalizers | T1 |
| `packages/db/src/drizzle/repositories/purchases.ts` | guarded status read + helper | T1 |
| `apps/api/src/services/receipt-verify.ts`, `apple/apple-webhook.ts`, `google/google-webhook.ts`, `stripe/stripe-webhook.ts` | call guard | T1 |
| `apps/api/src/services/google/google-webhook.ts`, `stripe/stripe-webhook.ts`, `billing/webhook-handlers/index.ts` | use `claimWebhookEvent` | T2 |
| `apps/api/src/workers/webhook-delivery.ts`, `packages/db/src/drizzle/repositories/outgoing-webhooks.ts`, `packages/db/src/drizzle/enums.ts` | atomic delivery claim + backoff | T3 |
| `apps/api/src/services/integrations/providers/*` | provider idempotency key | T4 |
| `apps/api/src/workers/send-email-worker.ts`, `send-push-worker.ts`, `packages/db/src/drizzle/repositories/notification-deliveries.ts` | already-sent guard | T5 |
| `apps/api/src/workers/webhook-retention.ts`, `packages/db/src/drizzle/repositories/webhook-events.ts` | batched retention | T6 |
| `apps/api/src/routes/v1/experiments.ts`, `routes/v1/sdk-sessions.ts` | cross-tenant scoping | T7 |
| `packages/db/clickhouse/migrations/0013_*.sql` | rounding + lifetime/MRR consistency | T8 |
| `apps/api/src/services/metrics/mrr-decomposition.ts` | reconcile buckets | T9 |
| `apps/api/src/middleware/rate-limit.ts`, `.env.example` | trusted-proxy IP | T10 |

---

## Task 1 (P0-1): Enforce the subscription state machine on status writes

**Files:**
- Modify: `apps/api/src/services/subscription-state.ts` (normalizer edge OD-1)
- Create helper in: `packages/db/src/drizzle/repositories/purchases.ts`
- Modify call sites: `apps/api/src/services/receipt-verify.ts`, `services/apple/apple-webhook.ts`, `services/google/google-webhook.ts`, `services/stripe/stripe-webhook.ts`
- Test: `apps/api/tests/subscription-state-guard.test.ts`, `apps/api/src/services/apple/apple-webhook.transition-guard.integration.test.ts`

### 1a. Normalizer fix (OD-1)

- [ ] **Step 1: Write failing test** in `apps/api/tests/subscription-state-guard.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalizeAppleStatus, validateTransition } from "../src/services/subscription-state";
import { APPLE_NOTIFICATION_TYPE, APPLE_NOTIFICATION_SUBTYPE } from "../src/services/apple/apple-types";

describe("normalizeAppleStatus DID_FAIL_TO_RENEW (OD-1)", () => {
  it("maps a non-grace failed renewal to GRACE_PERIOD, not ACTIVE", () => {
    expect(
      normalizeAppleStatus(APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW, undefined),
    ).toBe("GRACE_PERIOD");
  });
  it("still maps the grace subtype to GRACE_PERIOD", () => {
    expect(
      normalizeAppleStatus(
        APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW,
        APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD,
      ),
    ).toBe("GRACE_PERIOD");
  });
});

describe("validateTransition terminal states", () => {
  it("rejects REFUNDED -> ACTIVE", () => {
    expect(validateTransition("REFUNDED", "ACTIVE")).toBe(false);
  });
  it("allows EXPIRED -> ACTIVE (resubscribe)", () => {
    expect(validateTransition("EXPIRED", "ACTIVE")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify the DID_FAIL_TO_RENEW case fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/subscription-state-guard.test.ts`
Expected: FAIL — returns "ACTIVE" not "GRACE_PERIOD".

- [ ] **Step 3: Fix the normalizer** in `subscription-state.ts`, the `DID_FAIL_TO_RENEW` branch:

```ts
    case APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW:
      // No grace subtype still means billing-retry limbo, not active
      // revenue. Keep access during Apple's retry window (OD-1).
      return STATUS.GRACE_PERIOD;
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @rovenue/api exec vitest run tests/subscription-state-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/subscription-state.ts apps/api/tests/subscription-state-guard.test.ts
git commit -m "fix(subscriptions): map non-grace DID_FAIL_TO_RENEW to GRACE_PERIOD"
```

### 1b. Guarded status read + transition helper

The four ingestion paths each write `status`. Centralize the rule: read current
status `FOR UPDATE` in the caller's tx, validate, strip `status` from the patch
when invalid, and audit the rejection.

- [ ] **Step 1: Add a status reader to `purchases.ts`** (after `upsertPurchase`):

```ts
import { sql } from "drizzle-orm";

/**
 * Reads the current status of a purchase by natural key, taking a
 * row lock so concurrent webhook deliveries of the same transaction
 * serialize. Returns null when the row does not yet exist (first
 * insert — no prior state to guard).
 */
export async function lockPurchaseStatusByStoreTransaction(
  db: DbOrTx,
  store: Store,
  storeTransactionId: string,
): Promise<{ id: string; status: Purchase["status"] } | null> {
  const rows = await db
    .select({ id: purchases.id, status: purchases.status })
    .from(purchases)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    )
    .for("update");
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Add the guard helper** in `apps/api/src/services/subscription-state.ts` (it already owns `validateTransition`):

```ts
export interface TransitionDecision {
  /** true when the status write should be applied. */
  apply: boolean;
  from: PurchaseStatus | null;
  to: PurchaseStatus;
}

/**
 * Decides whether `to` may be written given the current `from`.
 * A null `from` (row not yet present) is always allowed (first insert).
 */
export function decideTransition(
  from: PurchaseStatus | null,
  to: PurchaseStatus,
): TransitionDecision {
  if (from === null) return { apply: true, from, to };
  return { apply: validateTransition(from, to), from, to };
}
```

- [ ] **Step 3: Write failing unit test** in `apps/api/tests/subscription-state-guard.test.ts` (append):

```ts
import { decideTransition } from "../src/services/subscription-state";

describe("decideTransition", () => {
  it("allows first insert (null from)", () => {
    expect(decideTransition(null, "ACTIVE")).toEqual({ apply: true, from: null, to: "ACTIVE" });
  });
  it("rejects REFUNDED -> ACTIVE", () => {
    expect(decideTransition("REFUNDED", "ACTIVE").apply).toBe(false);
  });
  it("allows ACTIVE -> GRACE_PERIOD", () => {
    expect(decideTransition("ACTIVE", "GRACE_PERIOD").apply).toBe(true);
  });
});
```

- [ ] **Step 4: Run, verify pass** (helper already written)

Run: `pnpm --filter @rovenue/api exec vitest run tests/subscription-state-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/purchases.ts apps/api/src/services/subscription-state.ts apps/api/tests/subscription-state-guard.test.ts
git commit -m "feat(subscriptions): add transition guard helpers (decideTransition + locked status read)"
```

### 1c. Wire the guard into the receipt-verify write path

`receipt-verify.ts` currently calls `upsertPurchase` with `update.status` set
unconditionally (around line 190).

- [ ] **Step 1: Write failing integration test** `apps/api/tests/receipt-verify-transition.test.ts` that verifies a refunded purchase is not flipped back to ACTIVE by a later verify, and an audit row is written. Use the existing receipt-verify unit harness (mock `drizzle.*`). Skeleton:

```ts
import { describe, it, expect, vi } from "vitest";
// Arrange: existing purchase row status REFUNDED; stub
// lockPurchaseStatusByStoreTransaction -> { id, status: "REFUNDED" }.
// Act: run the verify path that resolves to status ACTIVE.
// Assert: upsertPurchase called WITHOUT status in update; audit() called
// with action "rejected_status_transition".
```

- [ ] **Step 2: Run, verify it fails** (status currently always written)

Run: `pnpm --filter @rovenue/api exec vitest run tests/receipt-verify-transition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `receipt-verify.ts`, before the `upsertPurchase` call, inside the same tx:

```ts
import { decideTransition } from "./subscription-state";
import { audit } from "../lib/audit";

const current = await drizzle.purchaseRepo.lockPurchaseStatusByStoreTransaction(
  tx,
  "APP_STORE",
  transaction.transactionId,
);
const decision = decideTransition(current?.status ?? null, status);

const update = {
  expiresDate: transaction.expiresDate ? new Date(transaction.expiresDate) : null,
  ...(transaction.price != null && { priceAmount: (transaction.price / 1_000_000).toString() }),
  ...(transaction.currency != null && { priceCurrency: transaction.currency }),
  ...(decision.apply ? { status } : {}),
};

if (!decision.apply) {
  await audit(tx, {
    projectId,
    action: "rejected_status_transition",
    targetType: "purchase",
    targetId: current?.id ?? transaction.transactionId,
    metadata: { from: decision.from, to: decision.to, store: "APP_STORE", source: "receipt-verify" },
  });
}
```

Then pass `update` into the existing `upsertPurchase({ ..., update })`. (Verify the exact `audit()` signature in `apps/api/src/lib/audit.ts:240` — pass the tx as first arg so it joins the in-tx hash chain.)

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @rovenue/api exec vitest run tests/receipt-verify-transition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/receipt-verify.ts apps/api/tests/receipt-verify-transition.test.ts
git commit -m "fix(subscriptions): guard status transitions in receipt-verify"
```

### 1d. Wire the guard into apple/google/stripe webhook write paths

Apply the same pattern at each remaining status-write site:
`apple-webhook.ts` (renewal/expire/refund handlers that call `upsertPurchase` /
`updatePurchase` / `updatePurchaseByStoreTransaction`), `google-webhook.ts`,
`stripe-webhook.ts`. The Apple refund **chain** revoke
(`updatePurchasesByOriginalTransaction`) is intentionally left as-is (spec
non-goal) — guard only the single-transaction status writes.

- [ ] **Step 1: Write failing integration test** `apps/api/src/services/apple/apple-webhook.transition-guard.integration.test.ts`: seed a REFUNDED purchase, deliver a late `DID_RENEW`, assert status stays REFUNDED and an audit row exists. (Mirror the existing `apple-webhook.concurrency.integration.test.ts` harness.)

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/apple/apple-webhook.transition-guard.integration.test.ts`
Expected: FAIL (status becomes ACTIVE).

- [ ] **Step 3: Implement** — at each single-transaction status write in `apple-webhook.ts`, `google-webhook.ts`, `stripe-webhook.ts`, insert the `lockPurchaseStatusByStoreTransaction` → `decideTransition` → conditional-status + audit pattern from 1c (using the store value `"APP_STORE"`/`"PLAY_STORE"`/`"STRIPE"` respectively and the webhook's `notificationType`/`eventType` in audit metadata).

- [ ] **Step 4: Run, verify pass + no regression**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/apple src/services/google src/services/stripe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple apps/api/src/services/google apps/api/src/services/stripe
git commit -m "fix(subscriptions): guard status transitions across apple/google/stripe webhooks"
```

---

## Task 2 (P0-2): Route Google / Stripe / billing webhooks through `claimWebhookEvent`

**Files:**
- Modify: `apps/api/src/services/google/google-webhook.ts:91`, `services/stripe/stripe-webhook.ts:112`, `services/billing/webhook-handlers/index.ts:101`
- Test: `apps/api/src/services/google/google-webhook.concurrency.integration.test.ts` (+ stripe + billing equivalents)

- [ ] **Step 1: Write failing concurrency integration test** for Google (mirror `apple-webhook.concurrency.integration.test.ts`): fire two concurrent deliveries of the same `storeEventId`; assert exactly one `revenue_events` row is created.

```ts
// two concurrent calls to processGoogleNotification(sameStoreEventId)
const [a, b] = await Promise.all([process(), process()]);
const oneDuplicate = [a, b].filter((r) => r.status === "duplicate").length;
expect(oneDuplicate).toBe(1);
expect(await countRevenueEvents(storeEventId)).toBe(1);
```

- [ ] **Step 2: Run, verify it fails** (today both can pass the PROCESSED-only guard)

Run: `pnpm --filter @rovenue/api exec vitest run src/services/google/google-webhook.concurrency.integration.test.ts`
Expected: FAIL — two revenue rows / zero duplicates.

- [ ] **Step 3: Implement** — in `google-webhook.ts` replace the `upsertWebhookEvent` + `if (status === PROCESSED)` block with:

```ts
const webhookEvent = await drizzle.webhookEventRepo.claimWebhookEvent(drizzle.db, {
  projectId: opts.projectId,
  source: WebhookSource.GOOGLE,
  eventType: kind,
  storeEventId,
  payload: JSON.parse(JSON.stringify(payload)),
});
if (!webhookEvent) {
  log.info("event already claimed/processed, skipping", { storeEventId, kind });
  return { status: "duplicate", kind };
}
```

Apply the same swap in `stripe-webhook.ts` and `billing/webhook-handlers/index.ts` (drop the `status: "RECEIVED"`/`PROCESSING` arg — `claimWebhookEvent` sets `PROCESSING` itself; a `null` return is the duplicate path).

- [ ] **Step 4: Run, verify pass** (Google, Stripe, billing)

Run: `pnpm --filter @rovenue/api exec vitest run src/services/google src/services/stripe src/services/billing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/google apps/api/src/services/stripe apps/api/src/services/billing
git commit -m "fix(webhooks): use atomic claimWebhookEvent for google/stripe/billing ingestion"
```

---

## Task 3 (P0-3): Atomic outbound-webhook delivery claim + backoff off-by-one

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts` (add `DELIVERING` status), `packages/db/src/drizzle/repositories/outgoing-webhooks.ts` (`claimPendingWebhooks`, reaper), `apps/api/src/workers/webhook-delivery.ts`
- Test: `apps/api/src/workers/webhook-delivery.claim.integration.test.ts`, `apps/api/src/workers/webhook-delivery.test.ts`

### 3a. Atomic status-flip claim

- [ ] **Step 1: Write failing integration test** `webhook-delivery.claim.integration.test.ts`: insert 3 PENDING rows; call `claimPendingWebhooks` twice "concurrently" (two connections); assert the two claims return **disjoint** row sets (no row in both), and all claimed rows have status `DELIVERING`.

- [ ] **Step 2: Run, verify it fails** (today the lock releases at autocommit; both can see all rows)

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/webhook-delivery.claim.integration.test.ts`
Expected: FAIL — overlapping claims.

- [ ] **Step 3: Add `DELIVERING` to the outgoing-webhook status enum** in `enums.ts`, generate the Drizzle migration:

Run: `pnpm db:migrate:generate` then review the generated SQL adds the enum value.

- [ ] **Step 4: Rewrite `claimPendingWebhooks`** as an atomic claim (flip status in the same statement so the row is invisible to other replicas after commit):

```ts
export async function claimPendingWebhooks(
  db: DbOrTx,
  now: Date,
  batchSize: number,
): Promise<PendingWebhookRow[]> {
  const result = await db.execute(sql`
    WITH due AS (
      SELECT w.id
      FROM ${outgoingWebhooks} w
      WHERE w.status = 'PENDING'
         OR (w.status = 'FAILED' AND w."nextRetryAt" <= ${now})
      ORDER BY w."createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE OF w SKIP LOCKED
    )
    UPDATE ${outgoingWebhooks} w
    SET status = 'DELIVERING', "claimedAt" = ${now}
    FROM due
    WHERE w.id = due.id
    RETURNING w.id, w.url, w.payload, w.attempts, w."projectId",
      (SELECT p."webhookSecret" FROM projects p WHERE p.id = w."projectId") AS "projectWebhookSecret"
  `);
  return (result as unknown as { rows: PendingWebhookRow[] }).rows ?? [];
}
```

Add a `claimedAt timestamptz` column to the `outgoingWebhooks` schema + migration. The CTE+UPDATE is one statement (atomic): the row is `DELIVERING` before any HTTP runs, so a second replica's `WHERE status IN ('PENDING','FAILED')` won't re-select it.

- [ ] **Step 5: Run, verify the claim test passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/webhook-delivery.claim.integration.test.ts`
Expected: PASS — disjoint claims.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle apps/api/src/workers/webhook-delivery.ts
git commit -m "fix(webhooks): atomic status-flip claim for outbound delivery across replicas"
```

### 3b. Stale-claim reaper

- [ ] **Step 1: Write failing test**: a row stuck in `DELIVERING` with `claimedAt` older than the visibility timeout (5 min) is returned to `PENDING` by `reclaimStaleDeliveries(db, now)`.

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement `reclaimStaleDeliveries`** in `outgoing-webhooks.ts`:

```ts
const STALE_CLAIM_MS = 5 * 60_000;
export async function reclaimStaleDeliveries(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const r = await db
    .update(outgoingWebhooks)
    .set({ status: "PENDING", claimedAt: null })
    .where(and(eq(outgoingWebhooks.status, "DELIVERING"), lt(outgoingWebhooks.claimedAt, cutoff)));
  return r.rowCount ?? 0;
}
```

Call it at the top of each `deliverWebhooks()` tick in `webhook-delivery.ts`.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -am "fix(webhooks): reclaim stale DELIVERING rows after visibility timeout"
```

### 3c. Backoff off-by-one

- [ ] **Step 1: Write failing test** in `webhook-delivery.test.ts`: a row at `attempts = 4` that fails again is scheduled with the 5th (12h) backoff, and dead-letters only after `MAX_ATTEMPTS` (5) attempts.

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Fix** — change the dead-letter check from `newAttempts >= MAX_ATTEMPTS` to `newAttempts > MAX_ATTEMPTS` (or index the backoff array by `attempts` and dead-letter when `attempts >= BACKOFF_SCHEDULE_MS.length`). Ensure the 12h entry is reachable.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -am "fix(webhooks): deliver all MAX_ATTEMPTS attempts (backoff off-by-one)"
```

---

## Task 4 (P0-4): Provider idempotency keys for ad-platform deliveries

**Files:**
- Modify: `apps/api/src/services/integrations/providers/*` (Meta CAPI, TikTok adapters)
- Modify: `packages/db/src/drizzle/schema.ts` + migration — drop the misleading `integration_deliveries_dedupe_uidx`
- Test: `apps/api/src/services/integrations/providers/*.test.ts`

- [ ] **Step 1: Write failing test** asserting the Meta CAPI adapter sends `event_id = outboxEventId` (and TikTok `event_id = outboxEventId`) in its HTTP payload, so duplicate deliveries are deduped server-side.

```ts
it("sends stable event_id for provider-side dedup", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  await deliverMetaCapi({ ...ctx, outboxEventId: "evt_123" }, fetchMock);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.data[0].event_id).toBe("evt_123");
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/integrations/providers`
Expected: FAIL — no event_id / wrong value.

- [ ] **Step 3: Implement** — thread `outboxEventId` into each provider `deliver()` and set the provider's native idempotency field (Meta CAPI `event_id`, TikTok Events `event_id`). The fanout already carries `outbox_event_id`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Drop the misleading unique index.** It can never dedupe (partition key forces `created_at` in the key). Replace it with a plain non-unique index for query performance:

```sql
DROP INDEX IF EXISTS integration_deliveries_dedupe_uidx;
CREATE INDEX integration_deliveries_conn_event_idx
  ON integration_deliveries (connection_id, outbox_event_id, created_at);
```

Update the Drizzle schema `dedupeUidx` → `connEventIdx` (`index(...)` not `uniqueIndex(...)`). Remove the now-dead `onConflictDoNothing()` duplicate-detection assumption in `workers/integrations-deliver.ts` (the BullMQ jobId dispatch dedup + provider event_id are the dedupe layers now).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/integrations packages/db/src/drizzle apps/api/src/workers/integrations-deliver.ts
git commit -m "fix(integrations): dedupe ad-platform deliveries via provider event_id; drop unenforceable unique index"
```

---

## Task 5 (P1-5): Already-sent guard for email/push workers

**Files:**
- Modify: `packages/db/src/drizzle/repositories/notification-deliveries.ts` (add `findDeliveryById`), `apps/api/src/workers/send-email-worker.ts`, `send-push-worker.ts`
- Test: `apps/api/src/workers/send-email-worker.integration.test.ts`

- [ ] **Step 1: Add `findDeliveryById`** to `notification-deliveries.ts`:

```ts
export async function findDeliveryById(
  db: DbOrTx,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: notificationDeliveries.id, status: notificationDeliveries.status })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id));
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Write failing test**: re-running a job whose delivery row is already `sent` does NOT call `mailer.send` again.

```ts
it("does not re-send when delivery already sent", async () => {
  // seed delivery row status "sent"; run worker job; expect mailer.send not called
  expect(mailer.send).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run, verify it fails.**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/send-email-worker.integration.test.ts`
Expected: FAIL — send called.

- [ ] **Step 4: Implement** — at the top of the email job (after the suppression check, before `incrementDeliveryAttempts`):

```ts
const existing = await notificationDeliveryRepo.findDeliveryById(deps.db, data.deliveryId);
if (existing && (existing.status === "sent" || existing.status === "suppressed")) {
  log.info("delivery already terminal, skipping resend", { deliveryId: data.deliveryId, status: existing.status });
  return;
}
```

Mirror in `send-push-worker.ts` before its `transport.send` at line 111.

- [ ] **Step 5: Run, verify pass. Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/notification-deliveries.ts apps/api/src/workers/send-email-worker.ts apps/api/src/workers/send-push-worker.ts apps/api/src/workers/send-email-worker.integration.test.ts
git commit -m "fix(notifications): skip resend when delivery row already terminal"
```

---

## Task 6 (P1-6): Batched webhook_events retention

**Files:**
- Modify: `packages/db/src/drizzle/repositories/webhook-events.ts` (`deleteWebhookEventsOlderThan`)
- Test: `apps/api/tests/webhook-retention.test.ts`

- [ ] **Step 1: Write failing test**: with 25 rows older than cutoff and a batch size of 10, deletion happens in bounded batches and returns count 25 without `.returning()` materialization. (Assert via a spy that the delete is called multiple times, or that a configurable `batchSize` param exists and the total deleted equals 25.)

- [ ] **Step 2: Run, verify it fails** (current single unbounded delete).

Run: `pnpm --filter @rovenue/api exec vitest run tests/webhook-retention.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — mirror the `outbox-cleanup` batch pattern:

```ts
export async function deleteWebhookEventsOlderThan(
  db: DbOrTx,
  cutoff: Date,
  batchSize = 10_000,
  maxBatches = 1_000,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await db.execute(sql`
      DELETE FROM ${webhookEvents}
      WHERE id IN (
        SELECT id FROM ${webhookEvents}
        WHERE "createdAt" < ${cutoff}
        ORDER BY "createdAt" ASC
        LIMIT ${batchSize}
      )
    `);
    const n = (r as unknown as { rowCount: number }).rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}
```

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -am "fix(webhooks): batch webhook_events retention delete (bounded locks, no returning())"
```

---

## Task 7 (P1-7): Cross-tenant scoping on SDK public-key endpoints

**Files:**
- Modify: `apps/api/src/routes/v1/experiments.ts` (`/:id/expose`), `routes/v1/sdk-sessions.ts`
- Test: `apps/api/src/routes/v1/experiments.expose.integration.test.ts`, `routes/v1/sdk-sessions.test.ts`

### 7a. Experiment expose ownership + subscriber scoping

- [ ] **Step 1: Write failing test**: posting to `/:id/expose` with an `experimentId` belonging to another project returns 404 (not found), and a `subscriberId` is resolved within the caller's project.

- [ ] **Step 2: Run, verify it fails** (today it writes any ids verbatim).

- [ ] **Step 3: Implement** — in the expose handler, before `publishExposure`:

```ts
const experiment = await drizzle.experimentRepo.findByIdInProject(
  drizzle.db, experimentId, project.id,
);
if (!experiment) throw new HTTPException(404, { message: "experiment not found" });

const subscriber = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
  projectId: project.id,
  rovenueId: input.subscriberId,
  createAttributes: {},
});
// publish with subscriber.id (project-owned), not the raw body id
```

(If `findByIdInProject` does not exist on the experiment repo, add it — `WHERE id = ? AND projectId = ?`.)

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -am "fix(experiments): scope /expose to the authenticated project (experiment + subscriber)"
```

### 7b. SDK sessions subscriber scoping

- [ ] **Step 1: Write failing test**: `/v1/sdk/sessions` resolves `subscriberId` within the project before producing to Kafka (a foreign id is mapped to a project-owned subscriber, not produced verbatim).

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** — resolve the subscriber within `project.id` (mirror `/me`/`/track` `upsertSubscriber`) and use the resolved `subscriber.id` as the Kafka key/payload `subscriberId`.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git commit -am "fix(refund-shield): scope sdk-session telemetry subscriberId to the project"
```

---

## Task 8 (P1-8): ClickHouse money rounding + lifetime/MRR consistency

**Files:**
- Create: `packages/db/clickhouse/migrations/0013_lifetime_revenue_rounding_consistency.sql`
- Test: `apps/api/tests/revenue-aggregates-idempotency.integration.test.ts` (extend) or new CH integration test

- [ ] **Step 1: Write failing CH integration test**: insert a `$19.99` INITIAL and a CHARGEBACK; assert `v_revenue_lifetime_subscriber` reports `lifetime_dollars_purchased_cents = 1999` (rounded, not 1998) and that the CHARGEBACK is subtracted in the refunded total. Use `AS e FINAL` aliasing and mutate `env` per CH test convention.

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @rovenue/api exec vitest run tests/revenue-aggregates-idempotency.integration.test.ts`
Expected: FAIL — 1998 / chargeback ignored.

- [ ] **Step 3: Write the migration** `0013_lifetime_revenue_rounding_consistency.sql`:

```sql
-- 0013_lifetime_revenue_rounding_consistency.sql
-- Fix sub-cent truncation (round, don't truncate) and reconcile the lifetime
-- view with v_mrr_daily: CHARGEBACK counts as a refund; REACTIVATION counts as
-- revenue. Views are stateless — safe to DROP + CREATE.
DROP VIEW IF EXISTS rovenue.v_revenue_lifetime_subscriber;

CREATE VIEW IF NOT EXISTS rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION', 'CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(amt_cents, type IN ('REFUND', 'CHARGEBACK'))                                                      AS lifetime_dollars_refunded_cents
FROM
(
  SELECT
    eventId,
    any(projectId)                         AS projectId,
    any(subscriberId)                      AS subscriberId,
    any(type)                              AS type,
    any(toUInt64(round(amountUsd * 100)))  AS amt_cents
  FROM rovenue.raw_revenue_events
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;
```

- [ ] **Step 4: Apply + run, verify pass**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate && pnpm --filter @rovenue/api exec vitest run tests/revenue-aggregates-idempotency.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/clickhouse/migrations/0013_lifetime_revenue_rounding_consistency.sql apps/api/tests/revenue-aggregates-idempotency.integration.test.ts
git commit -m "fix(analytics): round cents and reconcile lifetime revenue with MRR (chargeback/reactivation)"
```

---

## Task 9 (P2-9): Reconcile MRR decomposition buckets

**Files:**
- Modify: `apps/api/src/services/metrics/mrr-decomposition.ts`
- Test: `apps/api/tests/mrr-decomposition.test.ts`

- [ ] **Step 1: Write failing test**: given INITIAL + RENEWAL + REACTIVATION + REFUND events, the decomposition components reconcile to the net MRR delta from `v_mrr_daily` (new + renewal/retained − churned = net), and RENEWAL is no longer dropped.

- [ ] **Step 2: Run, verify it fails** (RENEWAL currently in no bucket).

Run: `pnpm --filter @rovenue/api exec vitest run tests/mrr-decomposition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — extend `MrrDecomposition` + SQL so the buckets sum to net. Add a `retainedUsd` (RENEWAL) bucket and keep `reactivation` distinct from true `expansion`:

```ts
export interface MrrDecomposition {
  newUsd: string;        // INITIAL, TRIAL_CONVERSION
  retainedUsd: string;   // RENEWAL
  reactivationUsd: string;// REACTIVATION (winback)
  churnedUsd: string;    // REFUND, CHARGEBACK
}
// SQL:
//   sumIf(amountUsd, type IN ('INITIAL','TRIAL_CONVERSION')) AS new_usd,
//   sumIf(amountUsd, type = 'RENEWAL')                       AS retained_usd,
//   sumIf(amountUsd, type = 'REACTIVATION')                  AS reactivation_usd,
//   sumIf(amountUsd, type IN ('REFUND','CHARGEBACK'))        AS churned_usd
```

Update the dashboard consumer + i18n keys for the new fields (search `expansionUsd` usages in `apps/dashboard`). Verify net = new + retained + reactivation − churned matches `v_mrr_daily.net_usd`.

- [ ] **Step 4: Run, verify pass. Step 5: Commit**

```bash
git add apps/api/src/services/metrics/mrr-decomposition.ts apps/api/tests/mrr-decomposition.test.ts apps/dashboard
git commit -m "fix(analytics): reconcile MRR decomposition buckets (account for renewal; split reactivation)"
```

---

## Task 10 (P2-10): Trusted-proxy client IP for rate limiting

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts` (`clientIp`), `.env.example`
- Test: `apps/api/tests/rate-limit-clientip.test.ts`

- [ ] **Step 1: Write failing test**: with `TRUSTED_PROXY_COUNT=1`, `clientIp` returns the second-from-last `X-Forwarded-For` hop (not the spoofable first), and ignores extra attacker-prepended hops.

```ts
it("takes the hop N-from-last given TRUSTED_PROXY_COUNT", () => {
  process.env.TRUSTED_PROXY_COUNT = "1";
  // XFF: "attacker, real-client, proxy"  -> trusted depth 1 -> "real-client"
  expect(clientIp(reqWith("evil, 1.2.3.4, 10.0.0.1"))).toBe("1.2.3.4");
});
```

- [ ] **Step 2: Run, verify it fails** (current code takes `[0]`).

Run: `pnpm --filter @rovenue/api exec vitest run tests/rate-limit-clientip.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — derive IP from the configured trusted-proxy depth:

```ts
const TRUSTED_PROXY_COUNT = Number(process.env.TRUSTED_PROXY_COUNT ?? "0");
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) {
      const idx = Math.max(0, hops.length - 1 - TRUSTED_PROXY_COUNT);
      return hops[idx];
    }
  }
  return c.req.header("x-real-ip") ?? "unknown";
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Document** in `.env.example`:

```
# Number of trusted reverse proxies in front of the API (Coolify/Caddy = 1).
# Used to pick the real client IP from X-Forwarded-For for rate limiting.
TRUSTED_PROXY_COUNT=1
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/rate-limit.ts .env.example apps/api/tests/rate-limit-clientip.test.ts
git commit -m "fix(security): derive rate-limit client IP from trusted-proxy depth"
```

---

## Final verification

- [ ] Run the full API unit suite — no regression to the 837 green tests:

Run: `pnpm --filter @rovenue/api exec vitest run --exclude '**/*.integration.test.ts'`
Expected: all previously-green tests still pass; new tests green.

- [ ] Typecheck:

Run: `pnpm --filter @rovenue/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] Run touched integration suites against testcontainers (Docker required):

Run: `pnpm --filter @rovenue/api exec vitest run src/services/apple src/services/google src/workers/webhook-delivery.claim.integration.test.ts tests/revenue-aggregates-idempotency.integration.test.ts`
Expected: PASS.

---

## Self-review notes (coverage map)

| Spec finding | Task |
|---|---|
| P0-1 state machine + OD-1 | T1 |
| P0-2 claimWebhookEvent | T2 |
| P0-3 atomic delivery claim + backoff | T3 |
| P0-4 provider idempotency (OD-2) | T4 |
| P1-5 email/push resend | T5 |
| P1-6 retention batch | T6 |
| P1-7 expose/sessions cross-tenant | T7 |
| P1-8 CH rounding + lifetime/MRR | T8 |
| P2-9 MRR decomposition | T9 |
| P2-10 rate-limit XFF | T10 |
| Refund full-chain revoke | intentionally unchanged (spec non-goal) |
