# SP1 — Correctness residuals + repo health

Date: 2026-07-23
Status: approved (design)
Surfaces: `apps/api`, `packages/db`

## Context

The paywall + funnel-payment programme closed with a follow-up ledger
(`.superpowers/sdd/progress.md`). Four groups of work were deferred; the owner
decomposed them into four sub-projects. This spec covers **SP1**, the smallest
and first, because it makes the integration suite trustworthy again — the other
three sub-projects depend on being able to believe a green run.

SP1 bundles three items that were logged as "accepted residuals". Investigation
found two of them are not what the ledger claimed:

- **4c was logged as test hygiene. It is a repository footgun** that happens to
  bite only tests today.
- **4a was logged as a privacy leak. It is not** — erasure anonymises rather
  than deletes, so no PII is revived. The residual is a financial/consistency
  question.
- **4b was logged as a minor.** It is the only genuine correctness gap of the
  three, and the originally-proposed fix (move the fence) does not close it.

## Item 1 — `deleteProject` silently drops its own authorisation

### Problem

`packages/db/src/drizzle/repositories/projects.ts:311-317`:

```ts
export async function deleteProject(db: DbOrTx, id: string): Promise<void> {
  await db.execute(sql`SET LOCAL "rovenue.allow_ledger_delete" = 'on'`);
  await db.delete(projects).where(eq(projects.id, id));
}
```

`credit_ledger` is DB-enforced append-only: a trigger rejects `DELETE` unless
`rovenue.allow_ledger_delete` is set for the transaction. `SET LOCAL` only takes
effect **inside a transaction**. Outside one, Postgres emits a `WARNING` and the
setting is discarded — the driver swallows the warning, so the call looks like it
succeeded.

The production caller (`apps/api/src/routes/dashboard/projects.ts:565`) passes a
`tx`, so production is correct. Integration-test teardowns pass `drizzle.db` (the
pool), so the authorisation is a no-op and the cascade into `credit_ledger` is
rejected with `restrict_violation`. This only fires when the project actually has
ledger rows, which is why the affected files pass in isolation and fail together
on a polluted dev database.

### Design

Make the function open its own transaction:

```ts
export async function deleteProject(db: DbOrTx, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL "rovenue.allow_ledger_delete" = 'on'`);
    await tx.delete(projects).where(eq(projects.id, id));
  });
}
```

Called from a pool this opens a real transaction. Called from inside an existing
transaction, Drizzle emits a `SAVEPOINT`; `SET LOCAL` still applies to the
enclosing transaction and is released at its end, so the production path's
behaviour is unchanged.

We fix the repository rather than the ~13 teardowns because a function that
silently discards its own authorisation is the defect. Patching call sites would
leave the next caller to rediscover it.

**Verification required during implementation:** confirm `DbOrTx` exposes
`.transaction`. If it does not, widen the type — do not fall back to
`set_config(..., false)`, which would leak the flag into a pooled connection.

### Not chosen

Relaxing the trigger to permit cascade deletes (e.g. via `pg_trigger_depth()`)
would weaken an append-only guarantee that exists on purpose, and would make
every future cascade path an implicit ledger-delete authorisation.

## Item 2 — funnel payment lock is check-then-act

### Problem

`apps/api/src/routes/public/funnel-payment.ts` guards the destructive section of
the payment-intent endpoint with `await lock.stillHeld()` (line 959), then
performs `cancelSuperseded` (a Stripe round-trip) before reaching the only
destructive write, `upsertPending`.

Checking an advisory Redis lock and then writing is TOCTOU by construction. A GC
pause, a slow Stripe call or an expired TTL between the check and the write lets
a holder that no longer owns the lock overwrite the current holder's row with
stale Stripe ids.

The consequence is not cosmetic: the buyer holds the *new* holder's
`client_secret` and pays against it, while the row records the *stale* ids. The
`/confirm` endpoint reads the row, cannot match the settled payment, and returns
`PAYMENT_NOT_SETTLED_YET` — a paying customer stuck in a retry loop.

Moving the fence closer to the write narrows this window but does not close it,
so it is not adopted as the fix on its own.

### Design — fencing token enforced in SQL

Safety moves from the lock to the storage layer: a stale writer is rejected by
Postgres, not trusted to notice it is stale.

1. **Schema.** Add `fence_token integer NOT NULL DEFAULT 0` to
   `funnel_purchases`. Hand-written migration `0094_funnel_purchase_fence.sql`
   plus a manual `meta/_journal.json` entry (`idx: 94`). Do **not** run
   `drizzle-kit generate` — it re-emits earlier hand-written DDL.

2. **Token derivation.** The endpoint already reads the row under the lock
   (`funnel-payment.ts:782`). Derive the token from that read:

   ```ts
   const fenceToken = (existing?.fenceToken ?? 0) + 1;
   ```

   Not a Redis `INCR` counter. A Redis counter needs a TTL, and an expired
   counter restarts at 1 while the row still holds a high token — permanently
   wedging that session's writes. Without a TTL the keys accumulate per session
   forever. The row-derived counter has neither failure mode and needs no extra
   round-trip.

3. **Guard.** Extend `upsertPending`'s existing `setWhere`:

   ```sql
   WHERE funnel_purchases.status = 'pending'
     AND funnel_purchases.fence_token < EXCLUDED.fence_token
   ```

   `INSERT` of a brand-new row does not conflict, so the guard does not apply to
   the first attempt.

Monotonicity argument: every writer reads and increments while holding the lock.
If A reads 5 and its TTL expires, B reads 5 and writes 6; A's write of 6 fails
`6 < 6` and is rejected. If A writes 6 first, B reads 6 and writes 7, so the
newer holder always wins. Two writers can never both succeed with the same token.

`upsertPending` already returns `null` when its guard rejects, and commit
`55a185cf` already maps that to a `409 PAYMENT_ALREADY_RECORDED` after cancelling
the caller's own Stripe objects. The rejected stale writer therefore lands on an
existing, tested path.

4. **Existing fence.** The `stillHeld()` check at line 959 stays where it is. It
   is now an optimisation — it avoids a pointless `cancelSuperseded` and cancels
   the caller's own Stripe objects early — not the safety mechanism. Its comment
   block must be rewritten to say so, because it currently claims to be the thing
   that prevents the clobber.

5. **Other writers.** `completeFunnelPurchase` transitions `pending → paid` and
   does not write `fence_token`; the `status = 'pending'` half of the guard
   already protects it (commit from the B3 final review). No change.

## Item 3 — revenue on an erased subscriber

### Problem

GDPR erasure (`apps/api/src/services/gdpr/anonymize-subscriber.ts`) anonymises:
PII is scrubbed, `deletedAt` is stamped, the row survives. Commit `93d10f98` now
cancels the customer's live Stripe subscriptions on erasure, but an
`invoice.paid` already in flight during the cancel window — or arriving after a
cancel that failed — still reaches `applyInvoicePaid`
(`apps/api/src/services/stripe/stripe-webhook.ts:779`), which writes a
`revenue_events` row against the erased subscriber with no `deletedAt` check.

Scope check: `applyInvoicePaid` writes no subscriber fields and grants no access,
and `revenue_events.subscriberId` is `NOT NULL` with an FK to `subscribers`
(`schema.ts:1123`). So nothing is resurrected and the row cannot be detached.
This is a financial-record question, not a PII leak.

### Design — record it, flag it loudly

The money was genuinely collected, so the revenue event is still written;
dropping it would silently understate MRR/LTV and break reconciliation. What is
added is visibility:

- `warn`-level log naming the subscriber, purchase, invoice and project.
- An audit row with `userId: "system"` and a new `AuditAction`,
  `subscriber.erased_revenue_received`. This follows the established precedent at
  `apps/api/src/services/apple/apple-webhook.ts:88`, which already writes
  system-actor audit rows for webhook-driven anomalies.

Because `audit()` must run inside the caller's Drizzle transaction, the revenue
write and the audit row are wrapped in one transaction on this branch only. The
ordinary path (subscriber not erased) keeps its current shape.

**Efficiency.** Detecting a rare condition must not cost a query on every
`invoice.paid`. `findPurchaseByStoreTransaction`
(`packages/db/src/drizzle/repositories/purchases-ext.ts:21`) already queries
`purchases`; extend it with a `LEFT JOIN` on `subscribers` returning
`subscriberDeletedAt` alongside the purchase. Zero extra round-trips. All callers
of that function must be checked and updated for the widened return shape.

### Not chosen

- *Skip the revenue event.* Privacy-first, but discards revenue that was actually
  collected and leaves accounting unreconcilable — for no privacy gain, since the
  row it writes to is already anonymous.
- *Force-cancel the subscription from the webhook.* Adds a Stripe write to the
  webhook hot path to compensate for a rare failure of the erasure-time cancel.
  Revisit if the new audit rows show the window is actually being hit.

## Testing

Every test below must be mutation-checked: revert the fix and confirm the test
goes red.

**Item 1** — `packages/db` integration test against real Postgres. Create a
project with `credit_ledger` rows, then delete it (a) from the pool and (b)
inside an existing transaction. Both must succeed and remove the ledger rows.
Mutation: remove the `db.transaction` wrapper — case (a) goes red.

**Item 2** — integration test against real Postgres. Insert a pending
`funnel_purchases` row at `fence_token = 5`; a write carrying token 6 succeeds; a
subsequent write carrying token 6 returns `null` and leaves the row untouched.
Plus a route-level test that a rejected `upsertPending` still produces
`409 PAYMENT_ALREADY_RECORDED` and cancels the caller's own Stripe objects.
Mutation: drop the `fence_token` clause from `setWhere` — the stale-write test
goes red.

**Item 3** — unit tests in the `stripe-webhook` suite. Erased subscriber: the
revenue event **is** written and the audit call fires. Live subscriber: the
revenue event is written and audit does **not** fire. Mutation: remove the
`deletedAt` branch — the audit assertion goes red.

**Closing measurement.** Run the full `apps/api` integration sweep against the
dirty dev database and record how many files Item 1 actually turns green. The
"13 files" figure comes from the ledger and has never been verified; the spec
does not assume it.

## Order

Item 1 → Item 2 → Item 3. Item 1 first because the other two are verified by
integration tests whose current failures would otherwise be ambiguous.

## Out of scope

- The three remaining sub-projects (paywall chart readers, custom-domain funnel
  serving, Phase 2 runner input capture) — each gets its own spec.
- The `funnel_versions` `nextVersionNo` race, left at funnel/paywall parity.
- Device smoke testing of Apple/Google Pay, which needs hardware, a wallet and an
  HTTPS domain.
