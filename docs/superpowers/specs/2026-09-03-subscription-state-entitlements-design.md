# Subscription State & Entitlements — Plan Change, Billing Issue, Family/Win-Back, Drift

**Date:** 2026-09-03
**Roadmap area:** §2 Subscription state & entitlements (85 → 95) — all four open items
**Scope:** one Postgres enum value, five new purchase columns, one new worker, and a
status-semantics table that makes the next enum value a compile error instead of seven
silent omissions.

---

## 1. Context — what reconnaissance found

Unlike §5 and §6, §2 is **not stale**. All four items are genuinely open, and three of them
are open in a worse way than the roadmap line suggests.

### 1.1 Plan change: Google is solved, Apple leaks, Stripe is silent

`apps/api/src/services/google/google-supersede.ts` already closes Play's half: when a Play
subscription is replaced, Google issues a new purchase token pointing at the retired one via
`linkedPurchaseToken` and sends no independent RTDN for the old token, so the old row is
expired explicitly. The module's own header states the failure it prevents — the access
engine unions granting rows across all of a subscriber's purchases, so a stale ACTIVE row
keeps the old tier alive for a full billing period.

**Apple has the same hole and no such module.** `applyRenewalPrefChange`
(`apps/api/src/services/apple/apple-webhook.ts:454`) handles subtype `UPGRADE` correctly for
the *new* transaction, but nothing retires the *old* one. Apple charges immediately, the old
row keeps its frozen future `expiresDate`, and `access-engine.ts`'s union keeps granting the
pre-upgrade tier until that date passes.

**Stripe changes product in place and tells nobody.** `upsertPurchaseFromSubscription`
(`stripe-webhook.ts:1252`) is keyed on `subscription.id`, so a plan change overwrites
`productId` on the existing row — entitlements resolve correctly — but no
`subscription.product_changed` is ever emitted. `store-event-normalization.ts` documents why
and names the fix: the before/after delta never reaches the bridge site.

Cross-grade / downgrade **pending** state is not modelled anywhere. Apple's
`renewalInfo.autoRenewProductId`, Google's `SUBSCRIPTION_DEFERRED` and Stripe's schedule all
carry it; none is stored.

### 1.2 Billing issue: three stores, three different conflations

| Store signal | Real meaning | Current mapping | Grants access? |
|---|---|---|---|
| Apple `DID_FAIL_TO_RENEW` + subtype `GRACE_PERIOD` | retry, access retained | `GRACE_PERIOD` | yes — correct |
| Apple `DID_FAIL_TO_RENEW`, other/no subtype | billing retry, **access lost** | `GRACE_PERIOD` | yes — **wrong** |
| Google `ON_HOLD` | account hold, access lost | `PAUSED` | no — right outcome, wrong meaning |
| Google `PAUSED` | user paused voluntarily | `PAUSED` | no — correct |
| Stripe `past_due` | smart retries, access retained | `GRACE_PERIOD` | yes — correct |
| Stripe `unpaid` / `incomplete` | access lost | `GRACE_PERIOD` | yes — **wrong** |

The Apple row is annotated in `subscription-state.ts:45` as a deliberate choice ("OD-1").
It is being reversed knowingly, not by accident (see §6 Rollout).

Google's two states collapsing into one `PAUSED` is the roadmap's actual complaint: the
access outcome happens to match, but *involuntary* and *voluntary* churn are
indistinguishable downstream, so dunning campaigns and win-back campaigns cannot be told
apart at the state level.

### 1.3 Family Sharing and win-back are inert

`purchases.ownershipType` is written by three paths (`apple-webhook.ts:1065`,
`receipt-verify.ts:271`, `import/write.ts:537`) and **read by none**. A family member
therefore produces a full-price revenue event for a subscription the purchaser already paid
for — double-counted MRR and LTV.

`OFFER_REDEEMED` is absent from the dispatch switch (`apple-webhook.ts:350-380`) entirely.
Win-back redemptions, promotional offers and offer-code redemptions produce **no state
change, no revenue event and no lifecycle key**. `APPLE_OFFER_TYPE.WIN_BACK` is defined in
`apple-types.ts:81` and never referenced outside `INTRODUCTORY` checks; `offerType` is
collapsed into the boolean `isIntroOffer` and otherwise discarded.

### 1.4 Nothing verifies `subscriber_access`

`syncAccess` (`access-engine.ts:23`) is the authoritative recompute and is correct, but it
only runs when an ingestion path calls it. A dropped outbox event, a crashed worker, a
partial deploy or a bug in any caller leaves `subscriber_access` silently wrong, and nothing
in the system would ever notice. `google-reconciliation.ts` is the precedent for the shape
of the fix; there is no equivalent for entitlements.

---

## 2. Foundation — one status-semantics table

Every item below adds or re-routes a `PurchaseStatus`. Today "what does this status mean"
is hand-written in **seven** places:

- `access-engine.ts:5` — `ACCESS_GRANTING_STATUSES`
- `expiry-checker.ts:51` — the expiry sweep set
- `metrics/subscriptions.ts:68` — `LIVE_STATUSES` (and a second list at `:189`)
- `purchases-ext.ts:356` and `:399` — raw SQL `IN (...)` literals
- `schema.ts:989` and `:998` — two partial-index predicates
- `google-reconciliation.ts:429` — a per-status switch

None of them fails to compile when the enum grows. This is the §6 lesson in a different
costume: there, a `Partial<Record>` let a missing provider key ship; here, a `string[]`
does the same.

**`packages/shared/src/subscription-status.ts`** (shared, because `packages/db` already
depends on `@rovenue/shared` and both sides need it):

```ts
export const SUBSCRIPTION_STATUS_SEMANTICS: Record<PurchaseStatus, {
  grantsAccess: boolean;  // produces a subscriber_access row
  isLive: boolean;        // counts as an active subscription
  isTerminal: boolean;    // absorbing state
  sweepable: boolean;     // the expiry sweeper may move it
  reconcilable: boolean;  // store-reconciliation sweeps should re-poll it
  involuntary: boolean;   // involuntary-churn signal
}>;
```

A full `Record` — adding an enum value is a `tsc` error here, once, and every derived list
(`ACCESS_GRANTING_STATUSES`, `LIVE_STATUSES`, `EXPIRY_SWEEP_STATUSES`, `TERMINAL_STATUSES`,
`RECONCILABLE_STATUSES`) comes from it.

`sweepable` and `reconcilable` are separate fields rather than one "non-terminal" flag
because `BILLING_ISSUE` needs opposite answers: the expiry sweeper must not touch it (§3.4)
while the Google reconciliation sweep must keep re-polling it, since an account hold can
recover. Collapsing them would force one of the two behaviours to be wrong.

The two SQL sites cannot be derived at compile time. They get a **contract test** that reads
the live predicate out of `pg_indexes` in a testcontainer and asserts equality with the
derived list — the same shape as the analytics schema-contract test, and specifically not a
hand-built expectation compared against itself.

`purchases.ts:24`'s `TERMINAL_STATUSES` (the data-layer terminal guard) is deliberately
**left duplicated**: it is a defence-in-depth mirror that must keep working if the
application layer is wrong. It gets a test asserting it equals the derived terminal set,
not an import.

---

## 3. Item 2 — `BILLING_ISSUE` as a first-class state

### 3.1 Migration shape (corrected)

`ALTER TYPE ... ADD VALUE` **cannot** be used here. The drizzle migrator wraps *all* pending
migrations in one transaction (`drizzle-orm/pg-core/dialect.cjs:62`), and Postgres forbids
using an enum value added by `ADD VALUE` in the transaction that added it. Splitting across
two migration files does not help: on a fresh install or in CI both files land in the same
transaction and the run fails with `unsafe use of new value` — while passing on a developer
machine where the files were applied on separate runs.

The repo already knows this. `0084_brown_nick_fury.sql` uses the recreate-enum pattern and
states the reason in its header. This migration follows it:

1. `DROP INDEX` on `purchases_status_expiresDate_idx` and
   `purchases_google_reconciliation_idx`. Not because both predicates change — only the
   second does — but because a partial-index predicate embeds `Const` nodes of the enum type
   being dropped, so the swap cannot rebuild them in place.
2. `ALTER TYPE "PurchaseStatus" RENAME TO "PurchaseStatus_old"`.
3. `CREATE TYPE "PurchaseStatus" AS ENUM (... , 'BILLING_ISSUE')`.
4. `ALTER TABLE purchases ALTER COLUMN status TYPE "PurchaseStatus" USING status::text::"PurchaseStatus"`.
5. `DROP TYPE "PurchaseStatus_old"`.
6. `CREATE INDEX` both, with predicates regenerated from the derived status lists —
   `purchases_status_expiresDate_idx` from `EXPIRY_SWEEP_STATUSES` (unchanged: `BILLING_ISSUE`
   is not sweepable) and `purchases_google_reconciliation_idx` from `RECONCILABLE_STATUSES`
   (**gains** `BILLING_ISSUE`, so held Play subscriptions keep being re-polled).
7. `ADD COLUMN billingIssueDetectedAt timestamptz`.

`purchases.status` is the only column of this type and no view depends on it — verified.

### 3.2 Mapping changes

- Apple `DID_FAIL_TO_RENEW` + subtype `GRACE_PERIOD` → `GRACE_PERIOD` (unchanged).
- Apple `DID_FAIL_TO_RENEW` + `BILLING_RETRY` / no subtype → **`BILLING_ISSUE`**.
- Google `ON_HOLD` → **`BILLING_ISSUE`**; Google `PAUSED` → `PAUSED` (unchanged).
- Stripe `past_due` → `GRACE_PERIOD` (unchanged); `unpaid`, `incomplete` →
  **`BILLING_ISSUE`**.

### 3.3 Semantics and transitions

`BILLING_ISSUE`: `grantsAccess: false`, `isLive: false`, `isTerminal: false`,
`sweepable: false`, `reconcilable: true`, `involuntary: true`.

Edges added to `TRANSITIONS`: `ACTIVE | TRIAL | GRACE_PERIOD → BILLING_ISSUE`, and
`BILLING_ISSUE → ACTIVE | EXPIRED | REFUNDED | REVOKED`. Not `→ PAUSED`: no store expresses
"the user voluntarily paused while in account hold".

`billingIssueDetectedAt` is set on entry (only when `from !== BILLING_ISSUE`, so a repeated
signal does not reset the clock) and cleared on any exit to a granting state.

### 3.4 Bounded ageing instead of expiry sweeping

`BILLING_ISSUE` is **not** added to the expiry sweep set: an account-hold row's `expiresDate`
is already in the past, so the sweeper would immediately erase the dunning signal. Instead
the expiry-checker gains a second, separate pass over `BILLING_ISSUE` rows older than
`BILLING_ISSUE_MAX_AGE_DAYS = 60` (Apple's billing-retry ceiling; Google's account hold is
30, Stripe's dunning is configurable and shorter) and moves those to `EXPIRED`.

### 3.5 A signal that becomes derivable

`store-event-normalization.ts` records that Stripe gets no `subscription.recovered` row
because inferring one from `invoice.paid` would fire on unrelated renewals. With
`BILLING_ISSUE` and the guard's previous-state snapshot (§4.1) that inference becomes exact:
`BILLING_ISSUE → ACTIVE` *is* a recovery. Apple and Stripe both gain
`subscription.recovered`, and the exclusion comment is updated rather than left stale.

---

## 4. Item 1 — plan change, cross-grade, entitlement transition rules

### 4.1 The seam: widen the guard's read

`lockPurchaseStatusByStoreTransaction` (`purchases.ts:151`) selects `id, status,
lastStoreEventAt` under `FOR UPDATE`. Adding `productId` and `autoRenewStatus` to that
select and surfacing them as `previous` on `GuardStatusWriteResult` gives every ingestion
path — Apple, Google, Stripe, refunds, supersede — the before-image at zero extra queries
and zero extra locks. This is precisely the follow-up `store-event-normalization.ts` names
as the precondition for reinstating its dropped Stripe row.

### 4.2 `expireSupersededApplePurchases` (corrected scope)

The Apple twin of `google-supersede.ts`. **Critically narrower than an
`originalTransactionId` sweep:** Apple mints a new `transactionId` for every renewal and
`upsertPurchase` is keyed on it (`apple-webhook.ts:1044`), so the table holds one row per
billing period. Expiring every sibling would rewrite the entire renewal history of the
chain and emit an audit row and an outbox event for each.

Selection is therefore: same `originalTransactionId`, `storeTransactionId` ≠ the incoming
one, status non-terminal, **and `expiresDate > now`**. Past periods already have past
expiries and fall out. Each match goes through `guardStatusWrite` → `EXPIRED`, then
`syncAccess`.

Called from `applyRenewalPrefChange` (subtype `UPGRADE`) and from the new `OFFER_REDEEMED`
handler when it carries an upgrade — never from `DID_RENEW`.

### 4.3 Pending plan change

New columns on `purchases`: `pendingProductId`, `pendingChangeType`,
`pendingChangeEffectiveAt`. Written from Apple `renewalInfo.autoRenewProductId` when it
differs from the current product, from Google `SUBSCRIPTION_DEFERRED`, and from Stripe's
upcoming item. Cleared when the change lands or is reverted.

A pending downgrade **never** revokes access early. The old row is expired only when the
store says it has been superseded (Apple upgrade, Google `linkedPurchaseToken`) — never on
intent.

### 4.4 `changeType` is store-reported or null (corrected)

An earlier draft derived `UPGRADE`/`DOWNGRADE` by comparing price-per-day across the old and
new purchase rows. That is unsound: `purchases.priceAmount` is the amount the store
*charged*, and a prorated upgrade charges less than the list price — the comparison would
label upgrades as downgrades. `products` carries neither price nor period, so no list price
is available in-process, and calling the store catalog from a webhook path is not acceptable.

`changeType` is therefore populated only from an explicit store signal — Apple's
`UPGRADE`/`DOWNGRADE` subtype — and is `null` for Google and Stripe. A null is honest; a
guess corrupts every downstream cohort.

### 4.5 Entitlement transition rule

Supersede runs **before** `grantAccess`, and `syncAccess` recomputes the whole desired set in
one transaction under the per-subscriber advisory lock, so the new tier is granted and the
old revoked atomically — no gap and no double-grant. This is the rule the roadmap item asks
for, and it is enforced by ordering plus the existing lock, not by a new mechanism.

All three stores emit `subscription.product_changed` when `previous.productId` differs from
the written one, which also un-drops the Stripe row §1.1 describes.

### 4.6 Proration revenue — a stated assumption, not a new event type

No new `RevenueEventType`. Apple sends the prorated refund as its own `REFUND` notification;
Stripe's proration lines arrive on the invoice the existing path already reads; Google's
replacement token carries the real `priceAmountMicros`. Net revenue is already correct. This
is written down as an invariant and covered by tests rather than encoded as a new enum value
whose blast radius reaches ClickHouse.

---

## 5. Item 3 — Family Sharing and win-back offers

### 5.1 Family Sharing: suppress at the write, not at the read

Access is granted normally — a family member genuinely has entitlement. Revenue is not:
the purchaser already paid, so a second event double-counts MRR and LTV.

There are **13** `createRevenueEvent` call sites across webhooks, receipt verification,
import and two workers. Suppressing at each Apple-reachable one is the hand-maintained-list
anti-pattern §2 exists to kill, and so is filtering `ownershipType` in every analytics
query. The suppression therefore lives in the **repository**: `createRevenueEvent` reads the
linked purchase's `ownershipType` in the same transaction and writes nothing when it is
`FAMILY_SHARED`. One place, structurally unforgettable by a future Apple code path, and
downstream aggregates need no filter at all because the row never exists.

No new column: `ownershipType` is already the source of truth.

### 5.2 Win-back and offer redemption

`OFFER_REDEEMED` gains a dispatch entry and a handler:

- Resolve subscriber, upsert the purchase as `ACTIVE` (or `TRIAL` when the offer includes a
  free period).
- Revenue event type is `REACTIVATION` when the chain's previous row was `EXPIRED` (the
  win-back case) and `INITIAL` otherwise. `EXPIRED → ACTIVE` is already a legal transition.
- When the notification carries an upgrade, call `expireSupersededApplePurchases`.

New columns `purchases.offerType` and `purchases.offerIdentifier` so win-back cohorts are
queryable; `isIntroOffer` stays for compatibility and is derived from `offerType` at the
write.

New public key `subscription.offer_redeemed`, added to `ROVENUE_EVENT_KEYS` and
`SUBSCRIPTION_BRIDGE_EVENT_KEYS`. Provider mappers key events with `Partial<Record>`, so a
missing entry compiles and silently maps to nothing — the §6 failure exactly. Each provider
mapper is therefore audited and a test asserts every `SUBSCRIPTION_BRIDGE_EVENT_KEYS` member
resolves in every registered provider.

---

## 6. Item 4 — `subscriber_access` drift reconciler

### 6.1 One computation, two callers

The pure part of `syncAccess` is extracted as `computeDesiredAccess(purchases, now)` and used
by **both** the writer and the checker. A second implementation of "what should this
subscriber have" would rot against the first — the §5 lesson, where a parallel query set
drifted from the one it was meant to verify.

### 6.2 The worker

`apps/api/src/workers/access-reconciliation.ts`, shaped after `google-reconciliation.ts`.

- **Candidates:** `subscribers.lastAccessReconciledAt` ascending with NULLs first (never
  checked sorts first — the same reasoning as `purchases.lastReconciledAt`), plus subscribers
  with purchases changed since their last check. Sized so every subscriber is visited within
  a bounded window.
- **Drift classes:** `missing_grant`, `stale_grant`, `wrong_expiry`, `orphan_row`. Each is
  counted as its own metric; "drift" as a single number would hide which direction is wrong.
- **Heal:** call `syncAccess`, write an `access.drift_repaired` audit row with before/after,
  stamp `lastAccessReconciledAt`.
- **Modes:** `dryRun` reports without writing; `backfill` heals and audits but emits no
  outbox event, so the one-time drain does not flood a customer's integrations with events
  for drift that has been sitting there for months. Live runs emit only when the heal
  actually changed a granting decision.

### 6.3 Circuit breaker

Auto-heal's real risk is not a missed drift, it is a mass-revoke: if `computeDesiredAccess`
is wrong, the worker faithfully applies it to everyone. When a batch's drift ratio exceeds
`MAX_DRIFT_HEAL_RATIO` (5%), the worker **stops healing, writes an alert-level log and a
metric, and leaves the data alone**. A real 5% entitlement drift is an incident to be looked
at, not a batch to be silently rewritten.

---

## 7. Rollout

`BILLING_ISSUE` revokes access for live subscribers who are in Apple billing retry or Stripe
`unpaid`/`incomplete` today. Two constraints:

1. **No retroactive rewrite.** The migration adds the enum value and the columns; it does
   not reclassify a single existing row. Only events arriving after deploy land in the new
   state, so the change rolls in at the natural rate of store notifications.
2. **Measured first.** A dry-run report (`dryRun` on the reconciler plus a read-only query
   over current `GRACE_PERIOD` rows by store) is produced before deploy so the blast radius
   is a number, not a hope.

---

## 8. Testing

- Real-Postgres testcontainer integration tests for the reconciler: drift injected by direct
  SQL, then heal, audit row and metric verified. Circuit breaker tested by injecting drift
  above the threshold and asserting **nothing** was written.
- `expireSupersededApplePurchases`: an upgrade against a chain with several historical
  renewal rows — assert exactly one row is expired, the historical rows are untouched, and
  the new tier's access has no gap.
- Mapper tests for all three stores' `BILLING_ISSUE` routes, including the Apple subtype
  split.
- Contract test reading partial-index predicates from `pg_indexes` and comparing with the
  derived status list.
- Contract test asserting every `SUBSCRIPTION_BRIDGE_EVENT_KEYS` member resolves in every
  registered provider mapper.
- Family Sharing: a `FAMILY_SHARED` purchase grants access and writes **no** revenue row,
  asserted at the repository, not at a call site.

No mocked ClickHouse and no mocked transactions in any of these — the two failure modes
this repo has already shipped twice.

---

## 9. Deliberately not doing

- A new `RevenueEventType` for proration (§4.6).
- Per-project toggles for the Apple billing-retry mapping or family-sharing access.
- Price-derived upgrade/downgrade classification (§4.4).
- Anything beyond current handling for `SUBSCRIPTION_PRICE_CHANGE_CONFIRMED`.
- Retroactive reclassification of existing rows (§7).
