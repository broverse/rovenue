# One-time purchase revenue typing — design

**Date:** 2026-09-04
**ROADMAP:** §6 Third-party integrations — the last open item ("Stripe
one-time (non-subscription) purchases reach no integration provider"), plus
two adjacent defects found while verifying it.
**Status:** approved design, ready for an implementation plan.

---

## 1. The problem

The ROADMAP item claims Stripe one-time funnel purchases reach no
integration provider. That is true, and it understates the defect. Verified
against the code:

- `apps/api/src/services/funnel/complete-purchase.ts:92` —
  `grantOneTimePurchase` writes a `purchases` row and `subscriber_access`
  rows. It writes **no `revenue_events` row**.
- `apps/api/src/services/stripe/stripe-webhook.ts:192` —
  `payment_intent.succeeded` is deliberately absent from `DOMAIN_SYNC` ("a
  bare PaymentIntent carries no subscription and no invoice"), so the
  webhook does not compensate.
- `apps/api/src/lib/outbox-topics.ts:26` — the funnel's outbox rows carry
  `aggregateType: "FUNNEL"` → topic `rovenue.funnel`, which is not a member
  of `FanoutTopic` (`apps/api/src/services/integrations/types.ts:13`).

`revenue_events` → `REVENUE_EVENT` outbox → `rovenue.revenue` →
`raw_revenue_events` is the **only** path into ClickHouse. So the money from
a one-time funnel purchase is absent from every integration provider *and*
from gross/net revenue, MRR, LTV, country revenue and the transactions list.
No `services/metrics/*` or `routes/dashboard/*` file references
`funnel_purchases`, so it is not reported anywhere else either.

The recurring funnel path is unaffected: the Connect webhook's
`invoice.paid` → `applyInvoicePaid` → `createRevenueEvent`.

### The same defect, one step milder, on Apple and Google

The revenue type for a non-subscription purchase is wrong on every store:

| Store | one-time purchase | revenue type written today |
|---|---|---|
| Apple | consumable / non-consumable | `INITIAL` (`receipt-verify.ts:338`, classified by `transactionId === originalTransactionId`) |
| Google | consumable / non-consumable | `INITIAL` (`receipt-verify.ts:760`, hard-coded) |
| Stripe (funnel) | one-time package | nothing at all |

Consequences that are live today:

- `services/metrics/credits.ts:299` and `:391` filter
  `type = 'CREDIT_PURCHASE'`. Nothing in the repository ever writes that
  type, so both dashboard metrics — "top credit packages by revenue" and
  "credit revenue USD in window" — are permanently zero.
- `services/metrics/mrr-decomposition.ts:25` excludes `CREDIT_PURCHASE`
  from the recurring decomposition precisely because it is one-time
  revenue. Credit-pack money arrives as `INITIAL` and therefore lands in
  `newUsd` anyway, so the file's own documented invariant does not hold.
- Meta CAPI and TikTok receive `Subscribe` for a coin-pack purchase
  (`event-mapping.ts` maps `revenue.INITIAL` → `Subscribe`).

The consumable flow is real and live: `routes/v1/receipts.ts:69` gates
`grantPurchaseCurrencies` on `ProductType.CONSUMABLE`.

### A third gap: `revenue.REACTIVATION` reaches nobody

`RevenueEventType` contains `REACTIVATION` and it is genuinely produced
(`apple-webhook.ts:422`, `:674`, `:1017` — RESUBSCRIBE, OFFER_REDEEMED,
and `applyRefundReversed`'s compensating row).
`deriveRevenueEventKey` (`services/integrations/event-mapping.ts:14`)
derives `revenue.REACTIVATION` through an `as RovenueEventKey` cast — but
`ROVENUE_EVENT_KEYS` has no such key, so it can never appear in a
connection's `enabledEvents` and `applyEventMapping` returns
`{ kind: "skip", reason: "filtered_by_event_scope" }` for every provider,
`CUSTOM_WEBHOOK` included. Silently.

The existing catalog-coverage guard
(`event-mapping.catalog-coverage.test.ts`) has two axes — "does every key a
provider advertises resolve to a name" and "does every subscription-bridge
key reach every provider". Neither asks "does every revenue type a producer
can write have a public key". That is the axis REACTIVATION fell through.

---

## 2. Scope

In scope:

1. Stripe one-time funnel purchases record revenue.
2. One-time purchases are typed as one-time on all three stores.
3. `revenue.REACTIVATION` becomes a public key, disambiguated.
4. A compile-time guard closing the axis that let (3) happen.

Out of scope, deliberately:

- **Backfilling historical rows.** Rows written before this ships keep
  `INITIAL`. `mv_mrr_daily`'s gross/net does not partition by type
  (`0006_mv_mrr_daily.sql:30` splits refund vs non-refund only), so total
  revenue does not move; only the decomposition and the credit metrics
  change, and only going forward. Stated in the docs.
- Stripe `customer.subscription.updated`'s prior `cancel_at_period_end`
  (§6's other named exclusion, unchanged).
- Non-funnel Stripe one-time checkout — no such flow exists today.

---

## 3. Design

### 3.1 One rule, one place

A pure mapping from `product.type` to a revenue type, expressed as a
**total** `Record<ProductType, …>` so a fourth `ProductType` is a compile
error rather than a silent fallthrough:

| `ProductType` | returns |
|---|---|
| `SUBSCRIPTION` | `null` — "not a one-time purchase"; the caller keeps its own INITIAL / RENEWAL / TRIAL_CONVERSION classification |
| `CONSUMABLE` | `CREDIT_PURCHASE` |
| `NON_CONSUMABLE` | `NON_RENEWING_PURCHASE` (new) |

Returning `null` rather than echoing the caller's type keeps the function
ignorant of subscription classification entirely: it cannot change that
behaviour even by accident, and the `null` branch is what each call site
already does today.

All three producers import it: `verifyAppleReceipt`
(`receipt-verify.ts:147`), `verifyGoogleProductReceipt`
(`receipt-verify.ts:660`), and `grantOneTimePurchase`
(`complete-purchase.ts:92`). The subscription branch never enters the
function, so existing subscription behaviour is structurally untouched.

`services/import/write.ts:567` (the RC/Adapty importer) derives its own type
via `deriveRevenueEventType`. It is a live write path — an import run after
this ships writes new rows — so it adopts the same rule.

**Documented edge:** `CREDIT_PURCHASE` means "a consumable IAP was bought".
A `CONSUMABLE` product with no `product_currency_grants` rows grants
nothing at all and is a misconfiguration; it will still be filed as a credit
purchase and appear in the "top credit packages" report. Keying on the
grants table instead was considered and rejected: it adds a read to every
revenue write and makes the type a function of mutable configuration, so two
purchases of the same product could carry different types over time.

### 3.2 The new enum value

`ALTER TYPE "public"."RevenueEventType" ADD VALUE IF NOT EXISTS 'NON_RENEWING_PURCHASE';`

Bare `ADD VALUE`, **not** the type-recreate shape of
`0115_billing_issue_status.sql`. That migration rewrote its table because it
*used* the new value in index predicates; PG16 permits `ADD VALUE` inside
drizzle's single migration transaction as long as nothing in the same run
uses the value, which is the precedent set by
`0107_import_verification_incomplete.sql` and `0108_import_verifying.sql`.
This matters more here than it did there: `revenue_events` is
range-partitioned, so a type recreate would rewrite every partition under an
ACCESS EXCLUSIVE lock.

Two constraints follow, both already documented in 0107/0108:

- The migration **and its snapshot** are hand-authored. `drizzle-kit
  generate` has repeatedly proposed `DROP TYPE` for this repo's drifted meta
  snapshot.
- No later migration in the same run may reference the new literal.

ClickHouse needs no migration: `raw_revenue_events.type` is
`LowCardinality(String)` (`0004_revenue_kafka_engine.sql:39`).

### 3.3 `revenueDedupeKind` becomes total

`packages/db/src/drizzle/repositories/revenue-events.ts:32` is a switch
ending in `default: return type`. A new enum value silently becomes its own
dedupe class — the same failure shape as a `Partial<Record>` with a missing
key. It becomes a total `Record<RevenueEventType, string>`, and
`NON_RENEWING_PURCHASE` maps to `"purchase"` so that it converges with an
`INITIAL` written for the same transaction by another path.

No such second path exists today (Apple has no `ONE_TIME_CHARGE` handler;
Google's one-time RTDN branch is persist-only per
`receipt-verify.ts:746`), but convergence is what the dedupe kind is for and
the cost of getting it right now is one line.

### 3.4 Stripe funnel emission

In `grantOneTimePurchase`, after the purchase upsert and the access grant,
in the **same transaction**:

- `createRevenueEvent(tx, …)` with the type from §3.1, `amount`/`currency`
  from the funnel purchase row already in hand.
- `amountUsd` from `convertToUsd(amount, currency, eventDate, tx)`. The
  function's ladder is Redis → `fx_rates` in Postgres → a static table
  (`services/fx.ts:94-142`); it makes **no** HTTP call, and passing `tx`
  keeps the `fx_rates` read on the connection already held rather than
  taking a second one while a transaction is open.
- `dedupeKey: stripe:<paymentIntentId>:purchase` via `revenueDedupeKind`, so
  the `/confirm` and webhook-backstop racers converge on one key.
- `country` deliberately omitted: a PaymentIntent carries no
  per-transaction country, and reading the Charge would put a Stripe call
  inside an open transaction — the thing this file explicitly refuses to do.
  Same documented gap, same reason, as `applyInvoicePaid`.

Emitting **inside** the transaction rather than after it is required, not
stylistic: both `/confirm` and the backstop short-circuit on
`purchase.status === "paid"`, so a post-commit emit that failed would never
be retried by anything.

`grantOneTimePurchase`'s existing contract — *nothing here throws on missing
data, because throwing would roll back the paid transition and strand a
buyer who really paid* — extends to the revenue write. A missing price or an
FX failure logs loudly and skips the row; it never aborts the transaction.

### 3.5 `revenue.REACTIVATION`, disambiguated

`REACTIVATION` carries two economic meanings, and the codebase already knows
it: `apple-webhook.ts:1562-1587` holds a win-back first charge and
`applyRefundReversed`'s compensating row apart *at the dedupe key*
("the reversal keeps claiming `reactivation`"). That distinction never
reaches a consumer — `insertRevenueRow`'s outbox payload
(`revenue-events.ts:283`) carries no `dedupeKey`.

Publishing the key as-is would hand consumers one event meaning either "they
came back" or "we un-refunded them". So `applyRefundReversed` stamps
`metadata: { reason: "refund_reversed" }`. `metadata` already flows into the
outbox payload and nowhere else, which is exactly its documented purpose;
the precedent is `subscription.product_changed`'s `phase` field.

Then `revenue.REACTIVATION` joins `ROVENUE_EVENT_KEYS`, and the
`RevenueEventKind` union in `services/integrations/types.ts:58` gains both
`REACTIVATION` and `NON_RENEWING_PURCHASE` — today that union's absence is
what makes `deriveRevenueEventKey`'s `as RovenueEventKey` cast a lie.

### 3.6 Provider mappings

`ROVENUE_EVENT_KEYS` goes from 21 to 23 keys. Every one of the 14 providers
needs either a vendor event name sourced from that vendor's own
documentation, or a `DECLARED_OMISSIONS` entry carrying a reason —
the Wave-2 discipline. `revenue.REACTIVATION` is expected to be a
deliberate omission for the ad platforms (Meta CAPI, TikTok), whose
`eventCatalog` is already narrow for the same reason.

Dashboard maps are total `Record<RevenueEventTypeName, …>`
(`routes/…/index.tsx:103`, `transactions.tsx:166`, `live-events/mappers.ts`,
`step-events.tsx`), so `tsc` names every site that needs a decision.

### 3.7 The guard — a compile error, not a test

The existing provider-name coverage must stay a test: it inspects runtime
`Partial<Record>` tables. But the enum ↔ public-key correspondence is
expressible in the type system, and `apps/api` can see both
`revenueEventType.enumValues` and `RovenueEventKey`. A template-literal
conditional type asserts both directions:

- every `RevenueEventType` has a `revenue.<VALUE>` key, and
- every `revenue.*` key names a real `RevenueEventType`.

Drift fails `tsc`. This is the guard that would have caught `REACTIVATION`
on the day it was added, and a compile error beats a test somebody can skip.

`CREDIT_PURCHASE`'s "public key with no producer" cannot be caught
statically. It is instead documented: `outbound-webhooks.mdx` gains a table
naming, for each revenue key, which store and which code path produces it —
the same shape as the per-store paused/recovered coverage table shipped on
2026-09-03.

---

## 4. Testing

- **Real Postgres, funnel:** completing a one-time funnel session writes
  exactly one `revenue_events` row and one `REVENUE_EVENT` outbox row with
  the right type; a replayed `/confirm` writes no second row; a session with
  no price logs and still mints its token.
- **Outbox level:** the row produces a valid fan-out envelope. A mapping row
  is not a delivery guarantee — the lesson from 2026-09-03.
- **Store typing:** a consumable receipt → `CREDIT_PURCHASE`; a
  non-consumable → `NON_RENEWING_PURCHASE`; a subscription receipt →
  unchanged (pinned as a regression test).
- **The zero metric:** `credits.ts`'s credit-revenue query returns real
  money after a consumable purchase.
- **Guard falsification:** removing a key from `ROVENUE_EVENT_KEYS` must
  fail `tsc`; a stale `DECLARED_OMISSIONS` entry must fail its test.
- **Dedupe convergence:** `revenueDedupeKind(NON_RENEWING_PURCHASE)` is
  `"purchase"`, pinned.

## 5. Documentation

`apps/docs/content/docs/integrations/outbound-webhooks.mdx`: the two new
keys, the per-key producer table, `CREDIT_PURCHASE`'s meaning ("a consumable
IAP"), `revenue.REACTIVATION`'s `metadata.reason` discriminator, and the
plain statement that rows written before this release carry `INITIAL` for
one-time purchases.
