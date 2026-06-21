# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every verified finding from `SECURITY_AUDIT.md` at RevenueCat/Adapty production quality — not MVP patches, but durable fixes with DB-level invariants, observability, and tests.

**Architecture:** Six independent workstreams. Each produces working, tested software on its own and can be reviewed/merged separately. W1 (ledger) and W2 (webhook reliability) are the money-/correctness-critical ones and ship first.

**Tech Stack:** Hono + TypeScript (strict), Drizzle ORM, PostgreSQL 16 (pg_partman partitioned hot tables), Redis + BullMQ, Vitest (unit + `*.integration.test.ts` against dev Postgres on host port 5433), Zod 3 for API input.

## Global Constraints

- TypeScript strict everywhere; Zod for all external input; responses are `{ data: T }` (`ok()`) or `{ error: { code, message } }` (`fail()`) from `apps/api/src/lib/response.ts`.
- Postgres access via Drizzle repositories only (`packages/db/src/drizzle/repositories`); raw SQL only via the `sql` template, and qualify columns in correlated subqueries.
- All IDs are cuid2; timestamps UTC `timestamptz`. Refund `amountUsd` stored POSITIVE.
- Migrations: next free Postgres number is **0081** (last is `0080_grey_reaper.sql`). Use `pnpm db:migrate:generate` for schema-derived migrations; hand-write data/constraint migrations with a descriptive name (`0081_<slug>.sql`) and add the journal entry. Next ClickHouse number is **0016**.
- Conventional commits. Each task ends green (`pnpm --filter @rovenue/api test` for API; `pnpm --filter @rovenue/db build` for db).
- Integration tests need dev Postgres up (`docker compose up -d postgres`, host port 5433) and follow the existing pattern: `const RUN_ID = Date.now()`, unique seeded IDs, `afterAll` cleanup. See `apps/api/src/workers/webhook-delivery.reaper.integration.test.ts` as the canonical template.
- New env vars: add to `apps/api/src/lib/env.ts` Zod schema (+ `.env.example`); production-required vars go in the `superRefine` prod block.

---

## Design Decisions (made for this plan — production-grade, not MVP)

These resolve the "you decide" mandate. Each task below implements one.

| Finding | Decision | Rationale (RevenueCat/Adapty bar) |
|---|---|---|
| **F1** | Add `claimedAt` lease to `webhook_events`; `claimWebhookEvent` reclaims a stale `PROCESSING` row past a 5-min lease and returns a discriminated result. Handlers **throw a retryable error on fresh `PROCESSING`** (not "duplicate") and skip only on `PROCESSED`. Add an inbound-webhook reaper worker (mirror of the proven `reclaimStaleDeliveries`) that resets orphaned rows and emits an alertable metric. | Inbound store events are money events. A worker killed during a rolling deploy must never silently drop a renewal/refund. The lease+reclaim pattern is already battle-tested for outgoing webhooks — reuse it. |
| **F2/F7** | Replace the implicit "unset → skip" bypass with one explicit `ALLOW_UNVERIFIED_WEBHOOKS` flag (default `false`, forbidden in prod). Google requires `PUBSUB_PUSH_AUDIENCE` whenever creds exist; Apple jose fallback only runs when the flag is on. Default = **fail closed everywhere**. | A staging box pointed at real store data must not accept forged events. One loud, auditable flag beats an accidental "I forgot to set the audience" bypass. |
| **F3** | Make `referenceId` **required** on the spend endpoint; always dedupe; also mount the `idempotency` middleware on spend + grant routes. Bump API/SDK minor + changelog. | RevenueCat/Adapty require a transaction identifier for consumable spend. Spend is secret-key (server-to-server) only, so the breaking change touches controlled callers. Two layers: durable DB dedup (referenceId) + response replay (Idempotency-Key). |
| **F4** | Migration adds `CHECK (balance >= 0)` and a `BEFORE UPDATE OR DELETE` trigger that raises, enforcing append-only at the DB. | The single most important financial invariant must not rest on two callers being disciplined forever. Ledger holds no PII, so an append-only trigger doesn't fight GDPR anonymize. |
| **F5** | `insertCreditLedger` stops opening its own transaction; it requires the caller's `tx`. Standalone callers wrap explicitly. Removes the nested savepoint. | Eliminates the fragile nested-tx pattern so a future edit can't commit the outer tx (and release the advisory lock) without the ledger row. |
| **F6** | Keep replay guard fail-open (DB claim gate is authoritative) but emit `webhook_replay_guard_failopen_total` and log at `warn`. | Availability > dedup is the right call given the authoritative DB gate; we just make Redis outages observable/alertable. |
| **F8** | Wrap `/billing/stripe/webhook` and `/webhooks/ses-events` with `endpointRateLimit`. Add Redis `SET NX` dedup on SES `MessageId`. | Parity with store webhooks; stop unauthenticated CPU burn and SNS replay. |
| **F9** | Allowlist `SubscribeURL` host to `sns.*.amazonaws.com` before fetch. | Defense-in-depth behind the existing signature gate. |
| **F10** | Per-IP `endpointRateLimit` on funnel session + answer creation; replace `answer: z.unknown()` with a bounded recursive schema + 16 KB byte cap. | Public unauthenticated surface must be abuse-resistant. |
| **F15** | Return a stable generic validation message to clients; log the full ZodError server-side with safe field paths. | Don't leak schema shape; keep operator debuggability. |
| **F16** | `secure: env.NODE_ENV === "production"` on the funnel cookie. | Standard cookie hardening. |
| **F11/F12/F13/F14** | CI: add `pnpm audit --prod --audit-level=high` (blocking) + gitleaks. Prod Docker image runs compiled JS via `node`, not `tsx`. Bump `drizzle-kit`/`tsx`, dedupe esbuild. Generate the test `ENCRYPTION_KEY` at runtime. | Close the supply-chain blind spot and shrink the production attack surface. |
| **F19/F20** | CH SDK-session daily → idempotent query-time view. CH `rovenue` user network ACL scoped to the compose subnet. | Analytics accuracy + least-privilege. |

---

# Workstream W1 — Credit Ledger Hardening

**Files:**
- Create: `packages/db/drizzle/migrations/0081_credit_ledger_invariants.sql`
- Modify: `packages/db/src/drizzle/schema.ts` (creditLedger table — add `check`)
- Modify: `packages/db/src/drizzle/repositories/credit-ledger.ts:117-160` (`insertCreditLedger` — require tx)
- Modify: `apps/api/src/services/credit-engine.ts` (pass tx through)
- Modify: `packages/shared/src/dashboard.ts:2165` (`spendVirtualCurrencyRequestSchema` — require referenceId)
- Modify: `apps/api/src/routes/v1/virtual-currencies.ts:78-123` (mount idempotency, always dedupe)
- Test: `apps/api/src/services/credit-engine.invariants.integration.test.ts`, `packages/shared/src/virtual-currencies.test.ts`

**Interfaces:**
- Produces: `insertCreditLedger(tx: DbOrTx, entry: CreditLedgerEntry): Promise<CreditLedgerRow>` — now *requires* an open tx handle (no internal `db.transaction`).
- Consumes: existing `advisoryXactLock`, `findLatestBalance`, `findExistingPurchaseCredit`.

### Task W1.1: DB-level ledger invariants (F4)

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/services/credit-engine.invariants.integration.test.ts`:
```typescript
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, creditLedger, projects, subscribers, virtualCurrencies } from "@rovenue/db";

const RUN_ID = Date.now();
const P = `prj_ledinv_${RUN_ID}`;
const S = `sub_ledinv_${RUN_ID}`;
const C = `vc_ledinv_${RUN_ID}`;

async function seed() {
  const db = getDb();
  await db.insert(projects).values({ id: P, name: "ledinv" });
  await db.insert(subscribers).values({ id: S, projectId: P, rovenueId: `rv_${RUN_ID}` });
  await db.insert(virtualCurrencies).values({ id: C, projectId: P, code: "GOLD", name: "Gold" });
}

describe("credit_ledger invariants", () => {
  afterAll(async () => {
    const db = getDb();
    await db.delete(creditLedger).where(sql`"projectId" = ${P}`);
    await db.delete(virtualCurrencies).where(sql`id = ${C}`);
    await db.delete(subscribers).where(sql`id = ${S}`);
    await db.delete(projects).where(sql`id = ${P}`);
  });

  it("rejects a negative balance via CHECK", async () => {
    await seed();
    const db = getDb();
    await expect(
      db.insert(creditLedger).values({
        projectId: P, subscriberId: S, currencyId: C,
        type: "SPEND", amount: -5, balance: -5,
      }),
    ).rejects.toThrow(/credit_ledger_balance_non_negative|violates check/i);
  });

  it("rejects UPDATE on an existing ledger row (append-only trigger)", async () => {
    const db = getDb();
    const [row] = await db.insert(creditLedger).values({
      projectId: P, subscriberId: S, currencyId: C,
      type: "PURCHASE", amount: 10, balance: 10,
    }).returning();
    await expect(
      db.update(creditLedger).set({ balance: 999 }).where(sql`id = ${row.id}`),
    ).rejects.toThrow(/append-only|credit_ledger is append-only/i);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`CHECK`/trigger don't exist yet)

Run: `docker compose up -d postgres && pnpm --filter @rovenue/api exec vitest run src/services/credit-engine.invariants.integration.test.ts`
Expected: both tests FAIL (insert/update succeed).

- [ ] **Step 3: Write the migration**

`packages/db/drizzle/migrations/0081_credit_ledger_invariants.sql`:
```sql
-- Financial invariants for the append-only credit ledger.
-- credit_ledger is range-partitioned (pg_partman); CHECK + trigger
-- apply to the parent and propagate to all partitions.

ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_balance_non_negative" CHECK ("balance" >= 0);

CREATE OR REPLACE FUNCTION "credit_ledger_reject_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (% rejected)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "credit_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_reject_mutation"();
```

- [ ] **Step 4: Add the CHECK to the Drizzle schema so it round-trips**

In `packages/db/src/drizzle/schema.ts`, in the `creditLedger` table's index/constraint callback, add:
```typescript
    balanceNonNegative: check(
      "credit_ledger_balance_non_negative",
      sql`${t.balance} >= 0`,
    ),
```
(Ensure `check` is imported from `drizzle-orm/pg-core`. The append-only trigger is a hand-written migration only — Drizzle has no trigger DSL; add a comment in the schema pointing to migration 0081.)

- [ ] **Step 5: Apply + run tests — expect PASS**

Run: `pnpm db:migrate && pnpm --filter @rovenue/api exec vitest run src/services/credit-engine.invariants.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/migrations/0081_credit_ledger_invariants.sql packages/db/src/drizzle/schema.ts apps/api/src/services/credit-engine.invariants.integration.test.ts packages/db/drizzle/migrations/meta
git commit -m "feat(db): enforce credit_ledger non-negative balance + append-only at DB level"
```

### Task W1.2: Remove the nested transaction in the ledger write path (F5)

- [ ] **Step 1: Update the existing ledger test expectation** — add a unit test asserting `insertCreditLedger` throws if called without an open tx context is NOT required (it just runs inside the caller's tx now). Instead, assert the spend path still works end-to-end via the existing `credit-engine` tests; no new test needed beyond W1.1 + existing suite.

- [ ] **Step 2: Make `insertCreditLedger` reuse the caller tx**

In `packages/db/src/drizzle/repositories/credit-ledger.ts`, replace the body of `insertCreditLedger` (currently `return db.transaction(async (tx) => {...})`) with a direct write on the passed handle:
```typescript
export async function insertCreditLedger(
  tx: DbOrTx,
  entry: CreditLedgerEntry,
): Promise<CreditLedgerRow> {
  // Caller MUST already be inside a transaction (the credit engine opens
  // one and holds the per-wallet advisory lock for the whole unit of work).
  // We write the ledger row and its outbox event on that SAME handle so
  // there is no nested savepoint and both commit atomically with the
  // balance read that produced `entry.balance`.
  const rows = await tx
    .insert(creditLedger)
    .values({
      projectId: entry.projectId,
      subscriberId: entry.subscriberId,
      currencyId: entry.currencyId,
      type: entry.type,
      amount: entry.amount,
      balance: entry.balance,
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      description: entry.description ?? null,
      metadata: (entry.metadata ?? null) as typeof creditLedger.$inferInsert.metadata,
    })
    .returning();
  const inserted = rows[0];
  if (!inserted) throw new Error("insertCreditLedger: no row returned");

  await outboxRepo.insert(tx, {
    aggregateType: "CREDIT_LEDGER",
    aggregateId: inserted.id,
    eventType: "credit.ledger.appended",
    payload: {
      creditLedgerId: inserted.id,
      projectId: inserted.projectId,
      subscriberId: inserted.subscriberId,
      currencyId: inserted.currencyId,
      type: inserted.type,
      amount: inserted.amount,
      balance: inserted.balance,
      referenceType: inserted.referenceType,
      referenceId: inserted.referenceId,
      createdAt: inserted.createdAt.toISOString(),
    },
  });
  return inserted;
}
```
The three call sites (`addCredits`, `spendCredits`, `refundCredits` via `addCredits`) already pass `tx` — no change needed there. Audit for any other caller: `grep -rn "insertCreditLedger" apps packages --include=*.ts | grep -v test` — if any caller passes the top-level `drizzle.db`, wrap it in `drizzle.db.transaction(async (tx) => insertCreditLedger(tx, ...))`.

- [ ] **Step 3: Run the full credit-engine suite — expect PASS**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/credit-engine`
Expected: PASS (no nested savepoint; advisory lock + balance read + insert + outbox all on one tx).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/repositories/credit-ledger.ts
git commit -m "refactor(db): insertCreditLedger reuses caller tx (drop nested savepoint)"
```

### Task W1.3: Mandatory idempotency on credit spend (F3)

- [ ] **Step 1: Update the shared schema test**

In `packages/shared/src/virtual-currencies.test.ts`, add:
```typescript
it("rejects a spend with no referenceId", () => {
  expect(
    spendVirtualCurrencyRequestSchema.safeParse({ amount: 5 }).success,
  ).toBe(false);
});
it("accepts a spend with referenceId", () => {
  expect(
    spendVirtualCurrencyRequestSchema.safeParse({ amount: 5, referenceId: "txn_1" }).success,
  ).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** (`referenceId` currently optional)

Run: `pnpm --filter @rovenue/shared exec vitest run src/virtual-currencies.test.ts`
Expected: FAIL on the "rejects no referenceId" case.

- [ ] **Step 3: Make referenceId required**

In `packages/shared/src/dashboard.ts:2165`:
```typescript
export const spendVirtualCurrencyRequestSchema = z.object({
  amount: z.number().int().positive(),
  // Required: the caller's idempotency key for this spend. A retried
  // request with the same referenceId is a no-op (returns the original
  // SPEND row) instead of double-debiting the wallet.
  referenceId: z.string().trim().min(1).max(120),
  referenceType: z.string().trim().max(60).optional(),
  description: z.string().trim().max(200).optional(),
});
```

- [ ] **Step 4: Always dedupe + mount idempotency middleware on the route**

In `apps/api/src/routes/v1/virtual-currencies.ts`:
1. Import the middleware: `import { idempotency } from "../../middleware/idempotency";`
2. On the POST route, add `idempotency` after `requireSecretKey`:
```typescript
  .post(
    "/:appUserId/:code/transactions",
    requireSecretKey,
    idempotency,
    zValidator("json", spendVirtualCurrencyRequestSchema),
    async (c) => {
```
3. In the `spendCredits` call, set `dedupeOnReference: true` (no longer conditional — referenceId is now guaranteed present):
```typescript
        const entry = await spendCredits({
          subscriberId: subscriber.id,
          currencyId: currency.id,
          amount: body.amount,
          referenceType: body.referenceType,
          referenceId: body.referenceId,
          description: body.description,
          dedupeOnReference: true,
        });
```

- [ ] **Step 5: Run shared + api spend tests — expect PASS**

Run: `pnpm --filter @rovenue/shared exec vitest run src/virtual-currencies.test.ts && pnpm --filter @rovenue/api exec vitest run src/routes/v1/virtual-currencies`
Expected: PASS. (Update any API test that posted a spend without `referenceId` to include one.)

- [ ] **Step 6: Changelog + version bump**

Bump `packages/shared` and `apps/api` minor versions; add a CHANGELOG note: "BREAKING: `POST /v1/virtual-currencies/:appUserId/:code/transactions` now requires `referenceId` (idempotency key)."

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dashboard.ts packages/shared/src/virtual-currencies.test.ts apps/api/src/routes/v1/virtual-currencies.ts
git commit -m "feat(api)!: require referenceId on credit spend; mandatory idempotency"
```

---

# Workstream W2 — Inbound Webhook Reliability

**Files:**
- Create: `packages/db/drizzle/migrations/0082_webhook_events_claimed_at.sql`
- Modify: `packages/db/src/drizzle/schema.ts` (webhookEvents — add `claimedAt`, index)
- Modify: `packages/db/src/drizzle/repositories/webhook-events.ts:130-151` (`claimWebhookEvent` → lease + discriminated result; add `reclaimStaleWebhookEvents`)
- Modify: `apps/api/src/services/apple/apple-webhook.ts:160-180`, `google/google-webhook.ts:97`, `stripe/stripe-webhook.ts:119`, `billing/webhook-handlers/index.ts:110` (handle the new result shape)
- Create: `apps/api/src/workers/webhook-reaper.ts` + `webhook-reaper.integration.test.ts`
- Test: `packages/db/.../webhook-events.claim.integration.test.ts`

**Interfaces:**
- Produces: `claimWebhookEvent(db, input): Promise<ClaimResult>` where
  ```typescript
  type ClaimResult =
    | { outcome: "claimed"; row: WebhookEvent }
    | { outcome: "duplicate" }      // already PROCESSED — skip, ack success
    | { outcome: "in_progress" };   // freshly PROCESSING elsewhere — caller must throw to retry
  ```
- Produces: `reclaimStaleWebhookEvents(db, now): Promise<number>`.

### Task W2.1: Add the claim lease column (F1)

- [ ] **Step 1: Migration**

`packages/db/drizzle/migrations/0082_webhook_events_claimed_at.sql`:
```sql
ALTER TABLE "webhook_events"
  ADD COLUMN "claimedAt" timestamptz;

CREATE INDEX "webhook_events_status_claimedAt_idx"
  ON "webhook_events" ("status", "claimedAt");
```

- [ ] **Step 2: Schema**

In `packages/db/src/drizzle/schema.ts`, add to `webhookEvents` columns:
```typescript
    claimedAt: timestamp("claimedAt", { withTimezone: true }),
```
and to the index callback:
```typescript
    statusClaimedAtIdx: index(
      "webhook_events_status_claimedAt_idx",
    ).on(t.status, t.claimedAt),
```

- [ ] **Step 3: Apply migration**

Run: `pnpm db:migrate && pnpm --filter @rovenue/db build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0082_webhook_events_claimed_at.sql packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/meta
git commit -m "feat(db): add claimedAt lease column to webhook_events"
```

### Task W2.2: Lease-based claim + reclaim repository (F1)

- [ ] **Step 1: Write the failing integration test**

`packages/db/src/drizzle/repositories/webhook-events.claim.integration.test.ts`:
```typescript
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, drizzle, webhookEvents, projects } from "@rovenue/db";

const RUN_ID = Date.now();
const P = `prj_whclaim_${RUN_ID}`;
const EVID = `evt_${RUN_ID}`;

describe("claimWebhookEvent lease", () => {
  afterAll(async () => {
    const db = getDb();
    await db.delete(webhookEvents).where(sql`"projectId" = ${P}`);
    await db.delete(projects).where(sql`id = ${P}`);
  });

  it("claims a new event, blocks a fresh concurrent claim, reclaims a stale one", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "whclaim" });
    const input = { projectId: P, source: "APPLE" as const, eventType: "TEST", storeEventId: EVID, payload: {} };

    const first = await drizzle.webhookEventRepo.claimWebhookEvent(db, input);
    expect(first.outcome).toBe("claimed");

    const second = await drizzle.webhookEventRepo.claimWebhookEvent(db, input);
    expect(second.outcome).toBe("in_progress"); // fresh PROCESSING — not a duplicate

    // Backdate claimedAt past the lease, then a reclaim must succeed.
    await db.update(webhookEvents)
      .set({ claimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(sql`"storeEventId" = ${EVID}`);
    const third = await drizzle.webhookEventRepo.claimWebhookEvent(db, input);
    expect(third.outcome).toBe("claimed");
  });

  it("returns duplicate once PROCESSED", async () => {
    const db = getDb();
    await db.update(webhookEvents).set({ status: "PROCESSED" }).where(sql`"storeEventId" = ${EVID}`);
    const r = await drizzle.webhookEventRepo.claimWebhookEvent(db, { projectId: P, source: "APPLE", eventType: "TEST", storeEventId: EVID, payload: {} });
    expect(r.outcome).toBe("duplicate");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (current `claimWebhookEvent` returns a row|null, not `ClaimResult`)

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/webhook-events.claim.integration.test.ts`
Expected: FAIL / type error.

- [ ] **Step 3: Rewrite `claimWebhookEvent` + add `reclaimStaleWebhookEvents`**

In `packages/db/src/drizzle/repositories/webhook-events.ts`, replace `claimWebhookEvent`:
```typescript
// Mirrors outgoing-webhooks CLAIM_LEASE_MS. A PROCESSING row whose
// claimedAt predates this window is assumed orphaned (the worker that
// claimed it crashed) and is re-claimable. Must exceed the slowest
// realistic handler run (store API verify + dispatch) by a wide margin.
const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;

export type ClaimResult =
  | { outcome: "claimed"; row: WebhookEvent }
  | { outcome: "duplicate" }
  | { outcome: "in_progress" };

export async function claimWebhookEvent(
  db: DbOrTx,
  input: ClaimWebhookEventInput,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const leaseCutoff = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const rows = await db
    .insert(webhookEvents)
    .values({
      projectId: input.projectId,
      source: input.source,
      eventType: input.eventType,
      storeEventId: input.storeEventId,
      payload: input.payload as typeof webhookEvents.$inferInsert.payload,
      status: "PROCESSING",
      claimedAt: now,
    })
    .onConflictDoUpdate({
      target: [webhookEvents.source, webhookEvents.storeEventId],
      set: { status: "PROCESSING", claimedAt: now },
      // Claim if NOT already done, AND either not currently being worked
      // or the in-flight claim has expired (orphaned worker).
      setWhere: sql`${webhookEvents.status} <> 'PROCESSED'
        AND (${webhookEvents.status} <> 'PROCESSING'
             OR ${webhookEvents.claimedAt} < ${leaseCutoff})`,
    })
    .returning();

  if (rows[0]) return { outcome: "claimed", row: rows[0] };

  // No row returned → the setWhere was false. Distinguish PROCESSED
  // (truly done — safe to skip) from fresh PROCESSING (someone else is
  // actively working it — the caller must retry, not ack).
  const existing = await findWebhookEventByStoreId(
    db as Db,
    input.source as "APPLE" | "GOOGLE" | "STRIPE",
    input.storeEventId,
  );
  if (existing?.status === "PROCESSED") return { outcome: "duplicate" };
  return { outcome: "in_progress" };
}

/**
 * Reset orphaned PROCESSING rows (claimedAt past the lease) back to
 * FAILED so they become re-claimable and visible to alerting. Returns
 * the count reclaimed. Called at the top of the reaper tick.
 */
export async function reclaimStaleWebhookEvents(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const result = await db.execute(sql`
    UPDATE ${webhookEvents}
    SET status = 'FAILED',
        "errorMessage" = 'reclaimed: orphaned PROCESSING past lease',
        "retryCount" = "retryCount" + 1
    WHERE status = 'PROCESSING' AND "claimedAt" < ${cutoff}
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/webhook-events.claim.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/webhook-events.ts packages/db/src/drizzle/repositories/webhook-events.claim.integration.test.ts
git commit -m "feat(db): lease-based webhook_events claim with discriminated result + reclaim"
```

### Task W2.3: Update handlers to the discriminated claim result (F1)

- [ ] **Step 1: Update the four call sites**

In each of `apple/apple-webhook.ts:160`, `google/google-webhook.ts:97`, `stripe/stripe-webhook.ts:119`, `billing/webhook-handlers/index.ts:110`, replace the `const webhookEvent = await claimWebhookEvent(...)` + `if (!webhookEvent) { return duplicate }` block with (Apple shown; apply the analogous edit to the others using their existing local variable names):
```typescript
  const claim = await drizzle.webhookEventRepo.claimWebhookEvent(drizzle.db, {
    projectId: opts.projectId,
    source: WebhookSource.APPLE,
    eventType: notification.notificationType,
    storeEventId: notification.notificationUUID,
    payload: JSON.parse(JSON.stringify(notification)),
  });

  if (claim.outcome === "duplicate") {
    log.info("notification already processed, skipping", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
    });
    return { status: "duplicate", notificationType: notification.notificationType };
  }
  if (claim.outcome === "in_progress") {
    // Another worker holds a fresh claim. Throw so BullMQ retries with
    // backoff instead of acking — prevents the historical bug where a
    // retry of our own crashed attempt silently dropped the event.
    throw new Error(
      `webhook ${notification.notificationUUID} claim in progress; retry`,
    );
  }
  const webhookEvent = claim.row;
```
The downstream `try { ... } catch` block that sets `PROCESSED`/`FAILED` is unchanged.

- [ ] **Step 2: Run the webhook handler suites — expect PASS** (adjust any test that mocked `claimWebhookEvent` to return a row/null → return `{ outcome: "claimed", row }` / `{ outcome: "duplicate" }`)

Run: `pnpm --filter @rovenue/api exec vitest run src/services/apple src/services/google src/services/stripe src/services/billing`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/apple/apple-webhook.ts apps/api/src/services/google/google-webhook.ts apps/api/src/services/stripe/stripe-webhook.ts apps/api/src/services/billing/webhook-handlers/index.ts
git commit -m "feat(api): webhook handlers retry on in-progress claim, skip only on processed"
```

### Task W2.4: Inbound webhook reaper worker (F1)

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/workers/webhook-reaper.integration.test.ts` — seed one PROCESSING row with `claimedAt` 10 min ago and one fresh; assert `runWebhookReaper()` returns `{ reclaimed: 1 }` and the stale row is now `FAILED`, the fresh one untouched. (Mirror the structure of `webhook-delivery.reaper.integration.test.ts`.)

- [ ] **Step 2: Run — expect FAIL** (worker doesn't exist)

- [ ] **Step 3: Create the worker** (mirror `webhook-retention.ts` scaffolding + `rovi-reaper.ts` cadence)

`apps/api/src/workers/webhook-reaper.ts`:
```typescript
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { recordMetric } from "../lib/metrics";

const log = logger.child("webhook-reaper");

export const WEBHOOK_REAPER_QUEUE_NAME = "rovenue-webhook-reaper";
const REPEAT_EVERY_MS = 60_000; // per-minute
const REPEATABLE_JOB_NAME = "webhook-reaper:sweep";
const REPEATABLE_JOB_ID = "webhook-reaper-repeatable";

export interface WebhookReaperResult {
  reclaimed: number;
}

export async function runWebhookReaper(
  now: Date = new Date(),
): Promise<WebhookReaperResult> {
  const reclaimed = await drizzle.webhookEventRepo.reclaimStaleWebhookEvents(
    drizzle.db,
    now,
  );
  if (reclaimed > 0) {
    log.warn("reclaimed orphaned PROCESSING webhook_events", { reclaimed });
    recordMetric("webhook_events_reclaimed_total", reclaimed);
  }
  return { reclaimed };
}

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}

let cachedQueue: Queue | undefined;
export function getWebhookReaperQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(WEBHOOK_REAPER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 60, age: 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleWebhookReaper(): Promise<void> {
  await getWebhookReaperQueue().add(
    REPEATABLE_JOB_NAME,
    {},
    { jobId: REPEATABLE_JOB_ID, repeat: { every: REPEAT_EVERY_MS } },
  );
}

let cachedWorker: Worker | undefined;
export function createWebhookReaperWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker(
    WEBHOOK_REAPER_QUEUE_NAME,
    async (_job: Job) => runWebhookReaper(),
    { connection: createBullConnection(), concurrency: 1 },
  );
  log.info("webhook reaper worker started");
  return cachedWorker;
}
```
(If `recordMetric`/`apps/api/src/lib/metrics.ts` doesn't expose a counter helper, use the existing metrics primitive in that file — `grep -n "export" apps/api/src/lib/metrics.ts` — and match its signature. If none, log-only is acceptable for v1.)

- [ ] **Step 4: Register the worker** where the other workers boot — `grep -rn "createWebhookWorker\|scheduleWebhookRetention" apps/api/src` to find the worker entrypoint (`apps/api/src/workers/index.ts` or the dispatcher process); add `createWebhookReaperWorker()` + `await scheduleWebhookReaper()` next to the retention scheduling.

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/webhook-reaper.integration.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workers/webhook-reaper.ts apps/api/src/workers/webhook-reaper.integration.test.ts apps/api/src/workers/index.ts
git commit -m "feat(api): inbound webhook reaper reclaims orphaned PROCESSING events"
```

---

# Workstream W3 — Webhook Signature Hardening

**Files:**
- Modify: `apps/api/src/lib/env.ts` (add `ALLOW_UNVERIFIED_WEBHOOKS`)
- Modify: `apps/api/src/middleware/webhook-verify.ts:138-150, 219-229`
- Modify: `apps/api/src/middleware/webhook-replay-guard.ts` (metric on fail-open)
- Test: `apps/api/src/middleware/webhook-verify.test.ts`

### Task W3.1: Single explicit unverified-webhook flag, fail-closed by default (F2, F7)

- [ ] **Step 1: Add the env var**

In `apps/api/src/lib/env.ts`: add `ALLOW_UNVERIFIED_WEBHOOKS: z.coerce.boolean().default(false)`. In the prod `superRefine` block, add: if `NODE_ENV === "production" && ALLOW_UNVERIFIED_WEBHOOKS` → `ctx.addIssue({ message: "ALLOW_UNVERIFIED_WEBHOOKS must be false in production" })`. Document in `.env.example`.

- [ ] **Step 2: Write failing tests** — `webhook-verify.test.ts`: with `ALLOW_UNVERIFIED_WEBHOOKS=false` and `PUBSUB_PUSH_AUDIENCE` unset, `verifyGoogleWebhook` returns 401; Apple with no creds + flag false → 401.

- [ ] **Step 3: Gate both bypasses on the flag**

Google (`webhook-verify.ts:223`): change `if (!env.PUBSUB_PUSH_AUDIENCE)` to:
```typescript
  if (!env.PUBSUB_PUSH_AUDIENCE) {
    if (!env.ALLOW_UNVERIFIED_WEBHOOKS) {
      log.warn("google webhook rejected: verification not configured");
      throw new HTTPException(401, { message: "Pub/Sub verification not configured" });
    }
    log.warn("google webhook: verification bypassed via ALLOW_UNVERIFIED_WEBHOOKS");
    const { messageId, publishTime } = await extractGoogleMessage(c);
    stashGoogleCtx(c, messageId, publishTime);
    await next();
    return;
  }
```
Apple (`webhook-verify.ts:145-150`): replace the `else` jose-fallback branch:
```typescript
  } else if (env.ALLOW_UNVERIFIED_WEBHOOKS) {
    log.warn("apple webhook: jose fallback via ALLOW_UNVERIFIED_WEBHOOKS", { projectId });
    verifier = new JoseAppleNotificationVerifier();
  } else {
    log.warn("apple webhook rejected: no project credentials", { projectId });
    throw new HTTPException(401, { message: "Apple webhook verification unavailable" });
  }
```
(The existing `env.NODE_ENV === "production"` branch is now redundant — the flag is the single gate — so collapse it into the above.)

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @rovenue/api exec vitest run src/middleware/webhook-verify.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/env.ts apps/api/src/middleware/webhook-verify.ts apps/api/src/middleware/webhook-verify.test.ts .env.example
git commit -m "feat(api): fail closed on webhook verification unless ALLOW_UNVERIFIED_WEBHOOKS"
```

### Task W3.2: Observability on replay-guard fail-open (F6)

- [ ] **Step 1:** In `webhook-replay-guard.ts` catch block (line ~59), add `recordMetric("webhook_replay_guard_failopen_total", 1)` (using the metrics helper found in W2.4 Step 3) before `await next()`. Keep fail-open behavior.
- [ ] **Step 2:** Add a unit test asserting the metric is recorded when `redis.set` throws (mock redis to reject).
- [ ] **Step 3:** Run + commit: `git commit -m "feat(api): emit metric when webhook replay guard fails open"`

---

# Workstream W4 — Public Surface & Transport Hardening

**Files:**
- Modify: `apps/api/src/routes/webhooks/index.ts` (SES rate limit), `routes/billing/index.ts` or `billing/webhook.ts` (billing rate limit)
- Modify: `apps/api/src/routes/webhooks/ses-events.ts` (SubscribeURL allowlist + MessageId dedup)
- Modify: `apps/api/src/routes/public/funnels.ts` (rate limit, bounded answer, cookie secure)
- Modify: `apps/api/src/middleware/error.ts` (ZodError message)
- Tests: alongside each.

### Task W4.1: Rate-limit billing + SES webhooks; SES replay dedup (F8)

- [ ] **Step 1:** In `webhooks/index.ts`, add `.use("/ses-events", storeLimit("ses"))` before the `.route("/ses-events", sesEventsRoute)`.
- [ ] **Step 2:** Wrap the billing webhook: in `routes/billing/index.ts`, mount an `endpointRateLimit({ name: "billing:stripe", max: 200, identify: (c) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown" })` `.use()` before the route.
- [ ] **Step 3:** SES `MessageId` dedup — in `ses-events.ts`, after signature verification and before processing a `Notification`, add a Redis `SET NX` guard keyed `ses:seen:${payload.MessageId}` (TTL 1h); on hit, return `{ ok: true }` without reprocessing. Fail open on Redis error (match the replay-guard convention).
- [ ] **Step 4:** Tests: assert 429 after `max` calls; assert a replayed `MessageId` is a no-op. Run + commit: `git commit -m "feat(api): rate-limit billing+SES webhooks; dedup SES by MessageId"`.

### Task W4.2: SES SubscribeURL host allowlist (F9)

- [ ] **Step 1:** In `ses-events.ts`, before `await fetch(payload.SubscribeURL)`:
```typescript
    const host = (() => { try { return new URL(payload.SubscribeURL).hostname; } catch { return ""; } })();
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
      log.warn("rejected SubscribeURL with non-SNS host", { host });
      return c.json({ ok: false }, 400);
    }
```
- [ ] **Step 2:** Test: a `SubscriptionConfirmation` with `SubscribeURL: "http://169.254.169.254/"` returns 400 and does not fetch. Run + commit: `git commit -m "fix(api): allowlist SNS SubscribeURL host before fetch (SSRF defense-in-depth)"`.

### Task W4.3: Funnel rate limit + bounded answer + secure cookie (F10, F16)

- [ ] **Step 1:** Add `endpointRateLimit({ name: "funnel:session", max: 30, identify: ipOf })` on `POST /funnels/:slug/sessions` and `endpointRateLimit({ name: "funnel:answer", max: 120, identify: ipOf })` on `POST /funnel-sessions/:sessionId/answers`, where `ipOf` reads the first `x-forwarded-for` hop.
- [ ] **Step 2:** Replace `answer: z.unknown()` (`funnels.ts:219`) with a bounded schema:
```typescript
const answerValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(answerValueSchema).max(100),
    z.record(z.string().max(100), answerValueSchema),
  ]),
);
// ...
answer: answerValueSchema,
```
Plus a hard byte cap: before validation, reject bodies whose serialized `answer` exceeds 16 KB (`if (JSON.stringify(body.answer).length > 16_384) throw new HTTPException(413, ...)`).
- [ ] **Step 3:** Cookie (`funnels.ts:195`): add `secure: env.NODE_ENV === "production",` to the `setCookie` options.
- [ ] **Step 4:** Tests: 429 after the cap; a 20 KB answer → 413; nested-depth answer accepted within limits; cookie has `Secure` in prod env. Run + commit: `git commit -m "feat(api): rate-limit + bound funnel answers; secure funnel cookie"`.

### Task W4.4: Don't leak ZodError schema shape (F15)

- [ ] **Step 1:** In `error.ts`, replace the ZodError branch:
```typescript
  if (err instanceof ZodError) {
    log.warn("validation error", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
    });
    return c.json(fail(ERROR_CODE.VALIDATION_ERROR, "Request validation failed"), 400);
  }
```
- [ ] **Step 2:** Test: a request failing zod validation returns `{ error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }` (no field names in body). Run + commit: `git commit -m "fix(api): return generic validation message; log field paths server-side"`.

---

# Workstream W5 — Supply Chain & Infra

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/api/Dockerfile`
- Modify: `apps/api/tests/setup.ts:74`
- Modify: root `package.json`/lockfile (dep bumps)
- Modify: `deploy/clickhouse/users.d/rovenue.xml`

### Task W5.1: CI audit + secret scan (F11)

- [ ] **Step 1:** Add to `.github/workflows/ci.yml` after `pnpm install`:
```yaml
      - name: Dependency audit
        run: pnpm audit --prod --audit-level=high
      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
- [ ] **Step 2:** Run `pnpm audit --prod --audit-level=high` locally; if it flags anything, resolve via override/bump and note it. Commit: `git commit -m "ci: add dependency audit + secret scanning"`.

### Task W5.2: Prod image runs compiled JS, not tsx (F12)

- [ ] **Step 1:** Confirm the build stage emits JS: `grep -n "tsc\|build\|outDir" apps/api/package.json apps/api/tsconfig*.json`. Ensure `pnpm --filter @rovenue/api build` produces `dist/index.js`.
- [ ] **Step 2:** In `apps/api/Dockerfile`, copy `dist` into the runtime stage and change line 53 to:
```dockerfile
CMD ["node", "apps/api/dist/index.js"]
```
Remove `tsx` from the runtime stage's installed deps (keep it in the build stage only).
- [ ] **Step 3:** Build the image locally: `docker build -f apps/api/Dockerfile -t rovenue-api:audit .` and run a smoke `/health` check. Commit: `git commit -m "build(api): run compiled JS in production image (drop tsx runtime)"`.

### Task W5.3: Dep bumps + runtime test key (F13, F14)

- [ ] **Step 1:** Bump `drizzle-kit` and `tsx` to latest in their `package.json`; `pnpm install`; `pnpm dedupe`; confirm `@esbuild-kit/*` gone and esbuild count reduced (`pnpm why esbuild`).
- [ ] **Step 2:** In `apps/api/tests/setup.ts:74`, replace the hardcoded key with a generated one:
```typescript
import { randomBytes } from "node:crypto";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
```
Apply the same to any other test file that hardcodes the key (the 6 files listed in F14).
- [ ] **Step 3:** Run `pnpm test` (unit) green. Commit: `git commit -m "chore: bump drizzle-kit/tsx, dedupe esbuild, generate test encryption key"`.

### Task W5.4: ClickHouse user least-privilege (F20)

- [ ] **Step 1:** In `deploy/clickhouse/users.d/rovenue.xml:25`, replace `<ip>::/0</ip>` networks with the Docker compose subnet (e.g. `<ip>172.16.0.0/12</ip>` — confirm the actual compose network CIDR via `docker network inspect`). Commit: `git commit -m "fix(deploy): scope ClickHouse user network ACL to compose subnet"`.

---

# Workstream W6 — Analytics Accuracy (Lowest Priority)

### Task W6.1: Idempotent SDK-session daily counts (F19)

- [ ] **Step 1:** Create `packages/db/clickhouse/migrations/0016_sdk_sessions_idempotent.sql` replacing the `SummingMergeTree` daily rollup (`0010_sdk_sessions_daily.sql`) with the query-time idempotent view pattern used by `0012_idempotent_revenue_aggregates.sql` (`ReplacingMergeTree` raw + a `FINAL`/`GROUP BY eventId` view). **Before applying on a live CH**, pause the `*_queue` consumer (see MEMORY: recreating a Kafka-fed MV loses in-flight events) or backfill from Postgres.
- [ ] **Step 2:** Run `pnpm --filter @rovenue/db db:clickhouse:migrate && pnpm --filter @rovenue/db db:verify:clickhouse`. Commit: `git commit -m "fix(clickhouse): idempotent SDK session daily counts (no double-count on replay)"`.

---

## Self-Review (spec coverage)

- F1 → W2.1–W2.4 ✓  F2 → W3.1 ✓  F3 → W1.3 ✓  F4 → W1.1 ✓  F5 → W1.2 ✓  F6 → W3.2 ✓  F7 → W3.1 ✓  F8 → W4.1 ✓  F9 → W4.2 ✓  F10 → W4.3 ✓  F11 → W5.1 ✓  F12 → W5.2 ✓  F13/F14 → W5.3 ✓  F15 → W4.4 ✓  F16 → W4.3 ✓  F17/F18 → no action (cleared/architectural) ✓  F19 → W6.1 ✓  F20 → W5.4 ✓
- Type consistency: `ClaimResult` defined in W2.2 is consumed verbatim in W2.3; `reclaimStaleWebhookEvents` defined in W2.2 consumed in W2.4. `insertCreditLedger(tx, entry)` signature change (W1.2) — all callers already pass `tx`.
- Open risk carried from audit: a metrics counter helper may not exist (W2.4 Step 3) — fall back to log-only if so.

## Recommended merge order

W1 → W2 (money/correctness, ship first) → W3 → W4 → W5 → W6. Each workstream is independently reviewable and green on its own.
