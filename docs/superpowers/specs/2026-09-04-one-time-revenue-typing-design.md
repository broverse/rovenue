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
  (`0006_mv_mrr_daily.sql:30` splits refund vs non-refund only), so the
  headline revenue series does not move for history. Every *other*
  consumer filters by an explicit type list and therefore does change
  going forward — see §3.8, which is where most of this work lives.
  Stated in the docs.
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
- `amountUsd` is computed **before the transaction opens**, not inside it.
  `completeFunnelPurchase` reads the funnel purchase row (`findBySession`)
  once outside the transaction, converts with
  `convertToUsd(amount, currency, eventDate)`, and passes the resulting
  number in. The transaction re-reads the row anyway — that read is what
  decides the paid/already-paid race — so the extra read is cheap and
  changes no semantics.

  This matters because `convertToUsd`'s ladder is Redis → `fx_rates` in
  Postgres → a static table (`services/fx.ts:94-142`): no HTTP, but two
  Redis round trips. This transaction sits on the paid-conversion critical
  path and holds the `funnel_claim_tokens.session_id` unique-index race;
  a cache round trip does not belong inside it. Hoisting it out also
  removes the `tx as Db` cast the alternative would have needed.
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

It does **not** cover SQL type allow-lists — a string literal inside a
query is invisible to the type system. That axis is closed by the named
groupings and the ClickHouse contract test in §3.8.

`CREDIT_PURCHASE`'s "public key with no producer" cannot be caught
statically. It is instead documented: `outbound-webhooks.mdx` gains a table
naming, for each revenue key, which store and which code path produces it —
the same shape as the per-store paused/recovered coverage table shipped on
2026-09-03.

### 3.8 The allow-lists — where most of this work actually is

Adding an enum value is the small half. Revenue types are enumerated by
hand in fourteen places, and an `IN (…)` allow-list drops a new type
silently — the SQL form of the `Partial<Record>` failure this project has
already been bitten by twice.

That these lists are unmaintained is not a hypothesis. **`CHARGEBACK`
appears in eight predicates and has never been a `RevenueEventType`
value** — `enums.ts:93` lists seven values, and `git log -S CHARGEBACK`
on that file returns nothing, so no row can ever have carried it. The
lists have already drifted from the enum in both directions.

Every site gets an explicit ruling, recorded in the implementation
ledger. Shipping without a ruling per site would turn "invisible
everywhere" into "visible in `mv_mrr_daily` only".

**Named groupings replace the inline literals** (project rule: no magic
values). One decision point per grouping instead of fourteen:

| Constant | Members | Rationale |
|---|---|---|
| `ALL_REVENUE_TYPES` | derived from `revenueEventType.enumValues` | today hand-copied *twice* (`overview.ts:39`, `transactions.ts:171`); both become one import, and a new value can no longer be forgotten |
| `REVENUE_TYPES_MONEY_OUT` | `REFUND`, `CHARGEBACK` | behaviour preserved exactly; `CHARGEBACK` is declared in the guard's exemption list as a phantom retained as a no-op, with "do not add new uses" |
| `REVENUE_TYPES_PURCHASE_COUNT` | `INITIAL`, `REACTIVATION`, `CREDIT_PURCHASE`, `NON_RENEWING_PURCHASE` | "a purchase happened" — a one-time buy is one |
| `REVENUE_TYPES_NEW_RECURRING` | `INITIAL`, `TRIAL_CONVERSION` | unchanged; one-time revenue must stay out of a *recurring* MRR decomposition — the whole reason for the new type |
| `REVENUE_TYPES_LIFETIME_PURCHASED` | money-in minus `CANCELLATION` (a $0 marker), **plus** `NON_RENEWING_PURCHASE` | lifetime value must include money the subscriber actually paid |

Per-site rulings:

- `overview.ts:39`, `transactions.ts:171` → `ALL_REVENUE_TYPES`. These
  feed `isKnownRevenueType`, so a missing value is dropped or mislabelled
  rather than merely uncounted.
- `transactions.ts:55` (`SCOPE_TYPES.purchase`), `:611` →
  `REVENUE_TYPES_PURCHASE_COUNT`.
- `transactions.ts:613`, `:724`, `summary.ts:73-75`,
  `mrr-decomposition.ts:61`, `mv_mrr_daily` → `NOT IN` money-out. **Safe
  as written**: a new type is included automatically. Left alone beyond
  the constant swap; noted so a reviewer does not go looking.
- `mrr-decomposition.ts:58`, `:133` → `REVENUE_TYPES_NEW_RECURRING`,
  unchanged in membership.
- `v_revenue_lifetime_subscriber` (`0014_refund_sign_robust_aggregates.sql:50`)
  → `REVENUE_TYPES_LIFETIME_PURCHASED`. A new ClickHouse migration
  redefines the view; it is a query-time view, so no data is rewritten.
- `analytics-router.ts:288, 354, 369, 442, 521` — the experiment-results
  and placement revenue engine. Its gross list excludes `CREDIT_PURCHASE`
  today, so a paywall experiment already fails to count coin-pack
  revenue. Ruled **in**: an experiment's revenue must count every sale it
  caused. Becomes money-in.
- `charts.ts:729` (`PURCHASE_NUMERATOR_EVENT_TYPE`) → gains
  `NON_RENEWING_PURCHASE` and `CREDIT_PURCHASE`, and stops being a single
  literal. The file's own argument decides it: `RENEWAL`,
  `REACTIVATION` and `TRIAL_CONVERSION` are excluded because they *lag*
  the paywall view that earned them. A one-time purchase has no lag — it
  is the same-day conversion this numerator exists to count.
- `ltv-prediction.ts:56` — the cohort *anchor* (`joins`). Ruled
  **unchanged**: a coin-pack buyer is not a member of a subscription
  cohort, and anchoring them there would project recurring revenue for
  someone who bought once. Documented as a deliberate exclusion.
- `credits.ts:299`, `:391` — left exactly as they are. These are the
  queries that read zero today; §3.1 is what makes them return money.

### 3.9 Existing integration connections must not lose events

`integration_connections.enabled_events` is a stored `text[]`
(`schema.ts:3114`) written from whatever the dashboard submits
(`routes/dashboard/integrations.ts:326`) — there is no defaulting to the
catalog. So a connection created before this release holds an array that
cannot contain a key that did not exist.

Today a coin-pack purchase reaches those connections as `revenue.INITIAL`,
which is enabled. After §3.1 the same purchase becomes
`revenue.CREDIT_PURCHASE` (enabled only if the operator ticked it) or
`revenue.NON_RENEWING_PURCHASE` (impossible on an existing row). Shipping
§3.1 alone would therefore **stop deliveries that work today** — a silent
regression on live customer integrations.

A data migration widens every existing connection that has
`revenue.INITIAL` enabled to also enable `revenue.CREDIT_PURCHASE` and
`revenue.NON_RENEWING_PURCHASE`. Rationale: those connections have already
declared that they want to hear about purchases; the change splits one key
into three without changing what the operator asked for. Connections that
do not have `revenue.INITIAL` enabled are left untouched — they opted out
of purchase events and this must not opt them back in.

`revenue.REACTIVATION` is deliberately **not** added by that migration: it
is a genuinely new signal nobody has ever received, so enabling it silently
would be a change of behaviour rather than a preservation of one. It ships
opt-in through the dashboard's event picker.

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
- **ClickHouse contract (§3.8):** the real
  `v_revenue_lifetime_subscriber` SQL runs against a testcontainer
  ClickHouse with one row of every `RevenueEventType`, and the test fails
  **by name** on a type the view drops. The view is a SQL file and cannot
  import the TypeScript constant, so this test is the only thing holding
  the two in step. Precedent: the schema-contract test shipped in the
  2026-09-01 analytics batch.
- **No-loss on existing connections (§3.9):** a connection row with
  `revenue.INITIAL` enabled receives a `NON_RENEWING_PURCHASE` envelope
  after the migration; a connection without it still receives nothing.
- **Allow-list rulings:** one assertion per grouping constant, so a future
  enum value fails a named test rather than vanishing from a report.

## 5. Documentation

`apps/docs/content/docs/integrations/outbound-webhooks.mdx`: the two new
keys, the per-key producer table, `CREDIT_PURCHASE`'s meaning ("a consumable
IAP"), `revenue.REACTIVATION`'s `metadata.reason` discriminator, and the
plain statement that rows written before this release carry `INITIAL` for
one-time purchases.

Release notes carry the §3.9 migration in operator-facing terms: existing
connections that receive purchase events keep receiving them, now split
across three keys; `revenue.REACTIVATION` is available but opt-in.
