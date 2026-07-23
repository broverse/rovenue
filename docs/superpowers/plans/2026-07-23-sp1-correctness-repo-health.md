# SP1 — Correctness residuals + repo health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three residuals from the paywall/funnel-payment programme — a repository function that silently discards its own DELETE authorisation, a check-then-act race on the funnel payment lock, and unflagged revenue landing on a GDPR-erased subscriber.

**Architecture:** Three independent fixes in `apps/api` and `packages/db`. Task 1 makes `deleteProject` open its own transaction so `SET LOCAL` actually applies. Task 2 adds a `fence_token` column to `funnel_purchases` and moves lock safety from an advisory Redis check into the `upsertPending` `ON CONFLICT` guard. Task 3 gives `applyInvoicePaid` a single-query view of the subscriber's `deletedAt` and records a system-actor audit row when revenue lands on an erased subscriber.

**Tech Stack:** TypeScript (strict), Hono, Drizzle ORM, PostgreSQL 16, Redis, Vitest (unit + testcontainers/live-Postgres integration).

Spec: `docs/superpowers/specs/2026-07-23-sp1-correctness-repo-health-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for API input. Responses are `{ data: T }` via `ok()` or `{ error: { code, message } }`.
- Postgres access via Drizzle repositories only (`packages/db/src/drizzle/repositories`). Raw `sql` must qualify columns (`"funnel_purchases"."fence_token"`), because a bare `${table.col}` renders unqualified and breaks correlated subqueries.
- Migrations are **hand-written SQL plus a manual `packages/db/drizzle/migrations/meta/_journal.json` entry**. Do NOT run `drizzle-kit generate` — it re-emits earlier hand-written DDL. The migrator resolves files from the journal, not a directory glob.
- Latest migration is `0093_paywall_versions` (journal `idx: 93`). This plan adds `0094` only.
- `audit()` runs INSIDE the caller's Drizzle transaction when a `callerTx` is passed.
- App IDs are cuid2 (`createId()`); timestamps UTC.
- Conventional commits, one commit per task. **Stay on the current branch (`main`). Do NOT create branches or worktrees.**
- Test invocation: packages have no `vitest` script — use `pnpm --filter <pkg> exec vitest run <path>`, never `pnpm --filter <pkg> vitest run <path>`.
- `@rovenue/db` tests do not auto-load `.env`. Export `DATABASE_URL` before running them; `apps/api` tests do load it.
- Local Postgres for integration tests: `postgresql://rovenue:rovenue@localhost:5433/rovenue` (container `rovenue-db-1`).
- **Every fix must be mutation-checked**: after the test passes, revert the production change, confirm the test goes red, then restore. A test that passes on unfixed code proves nothing.

---

### Task 1: `deleteProject` opens its own transaction

**Files:**
- Modify: `packages/db/src/drizzle/repositories/projects.ts:311-317`
- Test: `packages/db/src/drizzle/repositories/projects.delete.integration.test.ts` (exists — add a case)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deleteProject(db: DbOrTx, id: string): Promise<void>` — signature unchanged; now safe to call with either a pool or a transaction.

**Background the implementer needs:**

`credit_ledger` is append-only, enforced by a database trigger that rejects `DELETE` unless the transaction-local setting `rovenue.allow_ledger_delete` is `'on'`. `deleteProject` sets it with `SET LOCAL`, which **only works inside a transaction**. Called with the pool, Postgres emits a warning and discards the setting — verified directly:

```
WARNING:  SET LOCAL can only be used in transaction blocks
SET
 rovenue.allow_ledger_delete
-----------------------------
                              <- empty: the setting did not take
```

The production caller (`apps/api/src/routes/dashboard/projects.ts:565`) passes a `tx`, so production works. Integration-test teardowns pass the pool, so the cascade into `credit_ledger` is rejected — but only when the project actually has ledger rows, which is why affected files pass alone and fail together on a polluted dev database.

`DbOrTx` is `export type DbOrTx = Db` (`projects.ts:15`), a `NodePgDatabase`, so `.transaction` exists. Drizzle's `PgTransaction` also exposes `.transaction`, which emits a `SAVEPOINT` — so wrapping unconditionally is safe from both call shapes.

- [ ] **Step 1: Write the failing test**

Add this case to `packages/db/src/drizzle/repositories/projects.delete.integration.test.ts`, inside the existing `describe("deleteProject — credit_ledger cascade", ...)` block, after the existing `it(...)`.

Note the existing test wraps its call in `db.transaction(...)`. Leave it exactly as it is — it pins the production call shape. This new case pins the pool call shape.

```ts
  it("succeeds when called with the pool, not a transaction", async () => {
    const db = getDb();

    // Distinct ids so this case is independent of the one above.
    const P2 = `prj_del_pool_${RUN_ID}`;
    const S2 = `sub_del_pool_${RUN_ID}`;
    const C2 = `vc_del_pool_${RUN_ID}`;

    await db.insert(projects).values({ id: P2, name: "del-pool-project" });
    await db.insert(subscribers).values({
      id: S2,
      projectId: P2,
      rovenueId: `rv_del_pool_${RUN_ID}`,
    });
    await db
      .insert(virtualCurrencies)
      .values({ id: C2, projectId: P2, code: "COIN", name: "Coin" });
    await db.insert(creditLedger).values({
      projectId: P2,
      subscriberId: S2,
      currencyId: C2,
      type: "PURCHASE",
      amount: 100,
      balance: 100,
    });

    // The whole point: no explicit transaction here. `SET LOCAL` inside
    // deleteProject must still take effect, which it only can if the
    // function opens its own transaction.
    await expect(deleteProject(db, P2)).resolves.toBeUndefined();

    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, P2));
    expect(projectRows.length).toBe(0);

    const ledgerRows = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.projectId, P2));
    expect(ledgerRows.length).toBe(0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/db exec vitest run \
  src/drizzle/repositories/projects.delete.integration.test.ts
```

Expected: the new case FAILS. The error comes from the append-only trigger and mentions `restrict_violation` or `credit_ledger`. The pre-existing case still passes.

If the new case *passes* at this point, stop and report — the premise of this task is wrong and the rest of it must not be applied.

- [ ] **Step 3: Write the implementation**

Replace `packages/db/src/drizzle/repositories/projects.ts:311-317` with:

```ts
/**
 * Delete a project and everything that cascades from it.
 *
 * Opens its own transaction unconditionally. `credit_ledger` is
 * append-only and its trigger only honours
 * `rovenue.allow_ledger_delete` when the setting is transaction-local,
 * and `SET LOCAL` outside a transaction is discarded with a warning the
 * driver does not surface — so a pool-called version silently lost its
 * own authorisation and the cascade was rejected.
 *
 * Called from inside an existing transaction, Drizzle emits a SAVEPOINT
 * and `SET LOCAL` still applies to the enclosing transaction, so the
 * dashboard call site (routes/dashboard/projects.ts) is unaffected.
 */
export async function deleteProject(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL "rovenue.allow_ledger_delete" = 'on'`);
    await tx.delete(projects).where(eq(projects.id, id));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/db exec vitest run \
  src/drizzle/repositories/projects.delete.integration.test.ts
```

Expected: PASS, 2/2 — both the pre-existing transaction case and the new pool case.

- [ ] **Step 5: Mutation-check**

Temporarily remove the `db.transaction` wrapper (restore the two bare statements), re-run the command from Step 4, and confirm the **new** case goes red while the pre-existing one stays green. Then restore the fix and re-run to confirm 2/2 again.

Record both outcomes in the task report. Do not skip this step: without it there is no evidence the test exercises the fix.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @rovenue/db exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/repositories/projects.ts \
        packages/db/src/drizzle/repositories/projects.delete.integration.test.ts
git commit -m "fix(db): deleteProject opens its own tx so SET LOCAL actually applies"
```

- [ ] **Step 8: Measure the blast radius**

Run the `apps/api` integration sweep against the dev database and record how many previously-red files are now green:

```bash
pnpm --filter @rovenue/api exec vitest run --reporter=basic 'src/**/*.integration.test.ts'
```

Report the before/after counts by file name. The follow-up ledger claims "13 red files" in this class; that figure has never been verified. Report what you actually observe, including any files that stay red for unrelated reasons.

---

### Task 2: Fence the funnel payment write in SQL

**Files:**
- Create: `packages/db/drizzle/migrations/0094_funnel_purchase_fence.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (append `idx: 94`)
- Modify: `packages/db/src/drizzle/schema.ts` (`funnelPurchases`, around line 2448)
- Modify: `packages/db/src/drizzle/repositories/funnel-purchases.ts:121-138` (`upsertPending`)
- Modify: `apps/api/src/routes/public/funnel-payment.ts` (token derivation, `upsertPending` call, comment at ~950-958)
- Test: `packages/db/src/drizzle/repositories/funnel-purchases.integration.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `funnelPurchases.fenceToken` — Drizzle column `fenceToken: integer("fence_token").notNull().default(0)`.
  - `upsertPending(db: Db, row: Omit<NewFunnelPurchase,"status"> & { status?: never }): Promise<FunnelPurchase | null>` — signature unchanged. `row` now carries `fenceToken`. Returns `null` when the guard rejects (already-paid row **or** a stale fence token).

**Background the implementer needs:**

`apps/api/src/routes/public/funnel-payment.ts` protects the payment-intent endpoint with a Redis lock. It checks `await lock.stillHeld()` (line 959) and then, after a Stripe round-trip (`cancelSuperseded`), performs its only destructive write, `upsertPending`.

Checking an advisory lock and then writing is TOCTOU: a GC pause, a slow Stripe call or an expired TTL between check and write lets a holder that no longer owns the lock overwrite the current holder's row with stale Stripe ids. The buyer then pays with the *new* holder's `client_secret` while the row records the *stale* ids, so `/confirm` cannot match the settled payment and answers `PAYMENT_NOT_SETTLED_YET` — a paying customer stuck in a retry loop.

The fix moves safety into Postgres. `upsertPending` already has an `ON CONFLICT ... WHERE` guard (`setWhere: eq(funnelPurchases.status, "pending")`) that protects an already-paid row; this task extends it with a monotonic token so a stale writer is rejected by SQL rather than trusted to notice it is stale.

The token is derived from the row read the endpoint already performs under the lock (`funnel-payment.ts:782`, `const existing = await drizzle.funnelPurchaseRepo.findBySession(...)`):

```ts
const fenceToken = (existing?.fenceToken ?? 0) + 1;
```

**Not** a Redis `INCR` counter: such a counter needs a TTL, and an expired counter restarts at 1 while the row still holds a high token, permanently wedging that session's writes; without a TTL the keys accumulate per session forever. The row-derived counter has neither failure mode and costs no extra round-trip.

Why it is monotonic: every writer reads and increments while holding the lock. If A reads 5 and its TTL expires, B reads 5 and writes 6; A's write of 6 then fails `6 < 6` and is rejected. If A writes 6 first, B reads 6 and writes 7. Two writers can never both succeed with the same token.

A rejected write already lands on a tested path: `upsertPending` returns `null`, and the endpoint cancels its own Stripe objects and answers `409 PAYMENT_ALREADY_RECORDED` (commit `55a185cf`).

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/migrations/0094_funnel_purchase_fence.sql`:

```sql
-- Fencing token for the funnel payment lock.
--
-- The payment-intent endpoint held a Redis lock and checked
-- `stillHeld()` before writing, which is check-then-act: a holder whose
-- TTL expired mid-flight could still clobber the current holder's row
-- with stale Stripe ids. The buyer then pays against a client_secret the
-- row no longer describes and /confirm can never settle it.
--
-- Safety moves into SQL: every writer increments the token it read under
-- the lock, and upsertPending's ON CONFLICT guard refuses a write whose
-- token is not strictly greater than the stored one.
--
-- Existing rows default to 0, so the first write after this migration
-- (token 1) is accepted.
ALTER TABLE "funnel_purchases"
  ADD COLUMN "fence_token" integer NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Register the migration in the journal**

Append to the `entries` array in `packages/db/drizzle/migrations/meta/_journal.json`, after the `idx: 93` entry. The migrator resolves files from this journal, not from a directory listing — a migration file without a journal entry is silently never applied.

```json
    {
      "idx": 94,
      "version": "7",
      "when": 1784680712519,
      "tag": "0094_funnel_purchase_fence",
      "breakpoints": true
    }
```

Keep the surrounding formatting byte-identical (two-space indent, existing trailing-newline state).

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/db/src/drizzle/schema.ts`, inside the `funnelPurchases` table definition, immediately after the `status` column (~line 2448):

```ts
    // Fencing token for the payment lock. Every writer increments the
    // value it read under the lock; `upsertPending` refuses a write whose
    // token is not strictly greater than the stored one, so a holder
    // whose TTL expired mid-flight cannot clobber the current holder's
    // row. Defaults to 0 so a brand-new row's first write (token 1) wins.
    fenceToken: integer("fence_token").notNull().default(0),
```

`integer` is already imported in this file; confirm before adding an import.

- [ ] **Step 4: Apply the migration**

```bash
pnpm db:migrate
```

Verify the column landed:

```bash
docker exec rovenue-db-1 psql -U rovenue -d rovenue \
  -c '\d funnel_purchases' | grep fence_token
```

Expected: a row showing `fence_token | integer | not null | 0`.

- [ ] **Step 5: Write the failing test**

Create `packages/db/src/drizzle/repositories/funnel-purchases.integration.test.ts` (if the file already exists, add the `describe` block to it and reuse its existing setup):

```ts
// =============================================================
// upsertPending — fencing token guard
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { funnelPurchases, projects } from "../schema";
import { upsertPending } from "./funnel-purchases";

const RUN_ID = Date.now();
const P = `prj_fence_${RUN_ID}`;
const SESSION = `sess_fence_${RUN_ID}`;

afterAll(async () => {
  const db = getDb();
  await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, SESSION));
  await db.delete(projects).where(eq(projects.id, P));
});

describe("upsertPending — fencing token", () => {
  it("accepts a strictly greater token and rejects a stale one", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "fence-test-project" });

    // First attempt: no row yet, so the INSERT path runs (no conflict,
    // guard does not apply).
    const first = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_first",
      fenceToken: 1,
    });
    expect(first).not.toBeNull();
    expect(first?.fenceToken).toBe(1);

    // A newer holder read 1 and writes 2 — strictly greater, accepted.
    const newer = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_newer",
      fenceToken: 2,
    });
    expect(newer).not.toBeNull();
    expect(newer?.stripePaymentIntentId).toBe("pi_newer");

    // A stale holder that also read 1 now tries to write 2. `2 < 2` is
    // false, so SQL refuses it and nothing is returned.
    const stale = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_stale",
      fenceToken: 2,
    });
    expect(stale).toBeNull();

    // The newer holder's row must be untouched.
    const [row] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, SESSION));
    expect(row?.stripePaymentIntentId).toBe("pi_newer");
    expect(row?.fenceToken).toBe(2);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/db exec vitest run \
  src/drizzle/repositories/funnel-purchases.integration.test.ts
```

Expected: FAIL at `expect(stale).toBeNull()` — without the guard the stale write succeeds and `pi_stale` overwrites `pi_newer`. That overwrite is precisely the production bug.

- [ ] **Step 7: Add the guard to `upsertPending`**

In `packages/db/src/drizzle/repositories/funnel-purchases.ts`, replace the `onConflictDoUpdate` block (lines 128-135) with:

```ts
    .onConflictDoUpdate({
      target: funnelPurchases.sessionId,
      set: { ...row, status: "pending" },
      // Two guards, both read the EXISTING row (Postgres exposes the
      // proposed one as `excluded.*`):
      //
      // 1. status = 'pending' protects a row that already records a real
      //    payment.
      // 2. fence_token < excluded.fence_token rejects a writer whose lock
      //    was taken over mid-flight. Every writer increments the token it
      //    read under the lock, so a holder that lost the lock carries a
      //    token the winner has already used — `n < n` is false and the
      //    stale write is refused by SQL rather than by a hopeful
      //    `stillHeld()` check that cannot be atomic with the write.
      setWhere: and(
        eq(funnelPurchases.status, "pending"),
        sql`"funnel_purchases"."fence_token" < excluded."fence_token"`,
      ),
    })
```

Add `and` and `sql` to the `drizzle-orm` import at the top of the file if they are not already imported. The column is qualified (`"funnel_purchases"."fence_token"`) per the Global Constraints — a bare `${funnelPurchases.fenceToken}` renders unqualified and would be ambiguous against `excluded`.

- [ ] **Step 8: Run the test to verify it passes**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/db exec vitest run \
  src/drizzle/repositories/funnel-purchases.integration.test.ts
```

Expected: PASS.

- [ ] **Step 9: Mutation-check the guard**

Remove the `sql\`...fence_token...\`` clause from `setWhere` (leaving only the status guard), re-run Step 8, and confirm the test goes red at `expect(stale).toBeNull()`. Restore the guard and confirm green. Record both outcomes.

- [ ] **Step 10: Derive and pass the token in the endpoint**

In `apps/api/src/routes/public/funnel-payment.ts`:

(a) After the in-lock read at line 782 (`const existing = await drizzle.funnelPurchaseRepo.findBySession(drizzle.db, sid);`) and after the existing status checks that follow it, add:

```ts
      // Fencing token for the write far below. Derived from the row we
      // just read *under the lock*: if our TTL expires and a newer holder
      // writes first, it will have consumed this same number, so our write
      // fails the `fence_token < excluded.fence_token` guard and is
      // refused by SQL. This is what makes the write safe — not the
      // `stillHeld()` check further down, which cannot be atomic with it.
      const fenceToken = (existing?.fenceToken ?? 0) + 1;
```

(b) Add `fenceToken` to the `upsertPending` call (the object literal starting `sessionId: sid,` around line 1000). Place it immediately after `stripePaymentIntentId`:

```ts
        fenceToken,
```

(c) Rewrite the comment block above the `stillHeld()` check (currently lines ~950-958, beginning "Everything above this line is additive") to stop claiming it is the safety mechanism:

```ts
      // Everything above this line is additive: a Customer, and one
      // unconfirmed Stripe object nobody else references.
      //
      // This check is an OPTIMISATION, not the safety mechanism. If our
      // TTL expired while we waited on Stripe, another request now holds
      // the lock and is redoing this work from a newer `existing` read.
      // Bailing here avoids a pointless `cancelSuperseded` and lets us
      // clean up the Stripe objects we created while we still know their
      // ids. What actually prevents us from clobbering the current
      // holder's row is the fencing token in `upsertPending`'s ON CONFLICT
      // guard, which is atomic with the write; this check is not.
```

Leave the body of the `if (!(await lock.stillHeld()))` block, `cancelOwnObjects` and `return LOCK_LOST` exactly as they are.

- [ ] **Step 11: Run the endpoint's existing suites**

API route tests live in `apps/api/tests/`, a separate directory from `apps/api/src`:

```bash
pnpm --filter @rovenue/api exec vitest run \
  tests/funnel-payment-intent.test.ts \
  tests/funnel-confirm.test.ts \
  tests/funnel-payment.integration.test.ts
```

Expected: PASS, with no fewer tests than before your change. If any test fails, the cause is your change — do not weaken an assertion to make it pass. Report instead.

- [ ] **Step 12: Typecheck**

```bash
pnpm --filter @rovenue/db exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors from either.

- [ ] **Step 13: Commit**

```bash
git add packages/db/drizzle/migrations/0094_funnel_purchase_fence.sql \
        packages/db/drizzle/migrations/meta/_journal.json \
        packages/db/src/drizzle/schema.ts \
        packages/db/src/drizzle/repositories/funnel-purchases.ts \
        packages/db/src/drizzle/repositories/funnel-purchases.integration.test.ts \
        apps/api/src/routes/public/funnel-payment.ts
git commit -m "fix(api): fence the funnel payment write in SQL instead of trusting the lock"
```

---

### Task 3: Flag revenue that lands on an erased subscriber

**Files:**
- Modify: `packages/db/src/drizzle/repositories/purchases-ext.ts` (add a sibling lookup)
- Modify: `apps/api/src/lib/audit.ts` (add one `AuditAction` member)
- Modify: `apps/api/src/services/stripe/stripe-webhook.ts:779-847` (`applyInvoicePaid`)
- Test: `apps/api/src/services/stripe/stripe-webhook.merged-anchor.test.ts` (existing erasure-adjacent suite — add a `describe`)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `findStripePurchaseWithSubscriberState(db: Db, projectId: string, subscriptionId: string): Promise<{ purchase: Purchase; subscriberDeletedAt: Date | null } | null>`.

**Background the implementer needs:**

GDPR erasure (`apps/api/src/services/gdpr/anonymize-subscriber.ts`) **anonymises**: PII is scrubbed, `deletedAt` is stamped, the row survives. Commit `93d10f98` cancels the customer's live Stripe subscriptions on erasure, but an `invoice.paid` already in flight during that window — or arriving after a cancel that failed — still reaches `applyInvoicePaid`, which writes a `revenue_events` row against the erased subscriber with no `deletedAt` check.

Scope, so the implementer does not over-fix: `applyInvoicePaid` writes no subscriber fields and grants no access, and `revenue_events.subscriberId` is `NOT NULL` with an FK to `subscribers` (`schema.ts:1123`). Nothing is resurrected and the column cannot be detached. **The revenue event is still written** — the money was genuinely collected and dropping it would understate MRR/LTV and break reconciliation for no privacy gain, since the row is already anonymous. What this task adds is visibility.

Do not widen `findPurchaseByStoreTransaction`: it has nine production callers across the Apple, Google, Stripe and receipt-verify paths, and only this one needs the subscriber's state. Add a sibling instead.

Replay is not a concern: the webhook layer dedupes deliveries before dispatch (`webhookReplayGuard` answers a repeated delivery with `200 {status:"duplicate"}`), so `applyInvoicePaid` runs once per Stripe event.

- [ ] **Step 1: Add the sibling lookup**

Append to `packages/db/src/drizzle/repositories/purchases-ext.ts`. Add `subscribers` to the existing `../schema` import.

```ts
/**
 * Like `findPurchaseByStoreTransaction`, but also reports whether the
 * owning subscriber has been GDPR-erased.
 *
 * A separate function rather than a widened `findPurchaseByStoreTransaction`
 * because that one has nine callers across the Apple, Google, Stripe and
 * receipt-verify paths and only the Stripe invoice path needs this. One
 * LEFT JOIN, so the erasure check costs no extra round-trip.
 */
export async function findStripePurchaseWithSubscriberState(
  db: Db,
  projectId: string,
  subscriptionId: string,
): Promise<{ purchase: Purchase; subscriberDeletedAt: Date | null } | null> {
  const rows = await db
    .select({
      purchase: purchases,
      subscriberDeletedAt: subscribers.deletedAt,
    })
    .from(purchases)
    .leftJoin(subscribers, eq(purchases.subscriberId, subscribers.id))
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.store, "STRIPE"),
        eq(purchases.storeTransactionId, subscriptionId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    purchase: row.purchase,
    subscriberDeletedAt: row.subscriberDeletedAt ?? null,
  };
}
```

Confirm `subscribers.deletedAt` is the correct column name in `packages/db/src/drizzle/schema.ts` before writing this; if it differs, use the real name and note the correction in your report.

- [ ] **Step 2: Add the audit action**

In `apps/api/src/lib/audit.ts`, add one member to the `AuditAction` union (starts at line 31). Place it in a new group after the stripe connect group:

```ts
  // --- gdpr ---
  | "subscriber.erased_revenue_received"
```

- [ ] **Step 3: Write the failing test**

Add to `apps/api/src/services/stripe/stripe-webhook.merged-anchor.test.ts` — the suite that already exercises erasure-adjacent webhook behaviour, so its mocks are closest to what this needs.

Read that file first and follow its existing mock setup exactly (module mocks, `beforeEach` resets, how a Stripe event is fed to the dispatcher). The block below shows the assertions; adapt the fixture construction to the file's established helpers rather than inventing a new harness.

```ts
describe("applyInvoicePaid — erased subscriber", () => {
  it("still records the revenue and writes a system audit row", async () => {
    // Purchase resolves, and the owning subscriber is GDPR-erased.
    mockFindStripePurchaseWithSubscriberState.mockResolvedValue({
      purchase: basePurchase,
      subscriberDeletedAt: new Date("2026-07-20T00:00:00Z"),
    });

    await dispatchInvoicePaid();

    // The money was collected: the revenue event is NOT skipped.
    expect(mockCreateRevenueEvent).toHaveBeenCalledTimes(1);

    // ...and the anomaly is recorded with a system actor.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      userId: "system",
      action: "subscriber.erased_revenue_received",
      resource: "purchase",
      resourceId: basePurchase.id,
    });
  });

  it("does not audit when the subscriber is live", async () => {
    mockFindStripePurchaseWithSubscriberState.mockResolvedValue({
      purchase: basePurchase,
      subscriberDeletedAt: null,
    });

    await dispatchInvoicePaid();

    expect(mockCreateRevenueEvent).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run \
  src/services/stripe/stripe-webhook.merged-anchor.test.ts
```

Expected: the erased-subscriber case FAILS on the audit assertion (`mockAudit` was never called). The live-subscriber case may already pass — that is fine and expected; it is the guard against over-firing.

- [ ] **Step 5: Wire the check into `applyInvoicePaid`**

In `apps/api/src/services/stripe/stripe-webhook.ts`, replace the lookup at lines 791-801 (the `findPurchaseByStoreTransaction` call, its `if (!purchase)` guard, and the two `ctx.outcome` assignments) with:

```ts
  const found =
    await drizzle.purchaseExtRepo.findStripePurchaseWithSubscriberState(
      drizzle.db,
      ctx.projectId,
      subscriptionId,
    );
  if (!found) {
    log.warn("invoice.paid for unknown purchase", { subscriptionId });
    return;
  }
  const { purchase, subscriberDeletedAt } = found;

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;
```

Then replace the closing `createRevenueEvent` call (lines ~830-847) with:

```ts
  const revenueInput = {
    projectId: ctx.projectId,
    subscriberId: purchase.subscriberId,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type,
    amount: amount.toString(),
    currency,
    amountUsd: amountUsd.toString(),
    store: Store.STRIPE,
    eventDate,
    // One paid invoice → one purchase-class revenue event; dedups replay.
    dedupeKey: `stripe:${invoice.id}:${revenueDedupeKind(type)}`,
    metadata: purchase.presentedContext
      ? { presentedContext: purchase.presentedContext }
      : undefined,
  };

  if (!subscriberDeletedAt) {
    await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, revenueInput);
    return;
  }

  // The subscriber was GDPR-erased but an invoice still settled — either
  // in flight while erasure cancelled the subscription, or after that
  // cancel failed. The money was genuinely collected, so the revenue event
  // stands: the row it points at is already anonymous, and dropping it
  // would understate MRR/LTV for no privacy gain. What it must not do is
  // pass unnoticed, so the anomaly is recorded on the audit chain with a
  // system actor (same shape as apple-webhook's transition_rejected rows)
  // and the two writes share one transaction.
  log.warn("revenue settled on an erased subscriber", {
    projectId: ctx.projectId,
    subscriberId: purchase.subscriberId,
    purchaseId: purchase.id,
    invoiceId: invoice.id,
    erasedAt: subscriberDeletedAt.toISOString(),
  });

  await drizzle.db.transaction(async (tx) => {
    await drizzle.revenueEventRepo.createRevenueEvent(tx, revenueInput);
    await audit(
      {
        projectId: ctx.projectId,
        userId: "system",
        action: "subscriber.erased_revenue_received",
        resource: "purchase",
        resourceId: purchase.id,
        before: null,
        after: {
          subscriberId: purchase.subscriberId,
          invoiceId: invoice.id,
          erasedAt: subscriberDeletedAt.toISOString(),
          amountUsd: amountUsd.toString(),
          currency,
        },
        ipAddress: null,
        userAgent: null,
      },
      tx as unknown as AuditTx,
    );
  });
```

Add `audit` and the `AuditTx` type to this file's imports from `../../lib/audit` if they are not already imported (check the top of the file first — `apple-webhook.ts` imports them the same way).

`createRevenueEvent` opens its own transaction internally; passing `tx` makes that a savepoint, which is correct.

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run \
  src/services/stripe/stripe-webhook.merged-anchor.test.ts
```

Expected: PASS, both new cases plus every pre-existing case in the file.

- [ ] **Step 7: Mutation-check**

Change `if (!subscriberDeletedAt)` to `if (true)` so the erased branch is unreachable, re-run Step 6, and confirm the erased-subscriber case goes red on the audit assertion while the live-subscriber case stays green. Restore and confirm green. Record both outcomes.

- [ ] **Step 8: Run the sibling Stripe webhook suites**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/stripe/
```

Expected: PASS. Several suites in this directory mock the purchase repository; any that mock `findPurchaseByStoreTransaction` for the `invoice.paid` path now need `findStripePurchaseWithSubscriberState` added to their mock, returning `{ purchase, subscriberDeletedAt: null }`. Add the mock member; do not revert the production change to satisfy an out-of-date mock.

- [ ] **Step 9: Typecheck**

```bash
pnpm --filter @rovenue/db exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors from either.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/drizzle/repositories/purchases-ext.ts \
        apps/api/src/lib/audit.ts \
        apps/api/src/services/stripe/stripe-webhook.ts \
        apps/api/src/services/stripe/stripe-webhook.merged-anchor.test.ts
git commit -m "feat(api): audit revenue that settles on a GDPR-erased subscriber"
```

---

### Task 4: Whole-change verification

**Files:** none modified — this task produces a report.

**Interfaces:**
- Consumes: all three fixes from Tasks 1-3.
- Produces: a verification report appended to `.superpowers/sdd/progress.md`.

- [ ] **Step 1: Run the changed-area suites on a quiet machine**

Close other work first — results taken while subagents or other builds run are unreliable.

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/
pnpm --filter @rovenue/api exec vitest run src/services/stripe/ src/routes/public/
```

Record the pass/fail counts per suite verbatim. Do not summarise a red run as green.

- [ ] **Step 2: Typecheck and build both packages**

```bash
pnpm --filter @rovenue/db exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm build --filter @rovenue/api
```

Expected: clean.

- [ ] **Step 3: Re-measure the integration sweep**

```bash
pnpm --filter @rovenue/api exec vitest run --reporter=basic 'src/**/*.integration.test.ts'
```

Compare against the baseline captured in Task 1 Step 8. State how many files Task 1 turned green, and name every file still red together with the reason. If a file is red for a reason unrelated to this plan, say so explicitly rather than folding it into a total.

- [ ] **Step 4: Append the ledger entry**

Append a section to `.superpowers/sdd/progress.md` recording: the three commits, the mutation-check outcome for each task, the measured before/after integration-sweep counts, and any residual left open. Follow the formatting of the existing sections in that file.

- [ ] **Step 5: Commit the ledger**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(sp1): record SP1 verification results"
```

---

## Notes for the reviewer

- Task 1's premise was verified against the live database before the plan was written; the `SET LOCAL` discard is real, silent, and returns exit code 0. If Task 1 Step 2 shows the new test passing on unfixed code, the implementer must stop rather than proceed.
- Task 2 deliberately keeps the `stillHeld()` check. It is demoted from safety mechanism to optimisation, and its comment must say so. A reviewer should reject the task if the comment still claims the check prevents the clobber.
- Task 3 must **not** skip the revenue event. A reviewer should reject any implementation that returns early without writing it.
- Every task carries a mutation-check step. A task report that omits the mutation-check outcome is incomplete regardless of how many tests pass.
