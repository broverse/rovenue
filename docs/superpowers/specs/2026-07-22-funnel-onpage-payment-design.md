# Funnel on-page payment — design

**Date:** 2026-07-22
**Status:** approved, ready for planning
**Scope:** Sub-project **B3** of the web-to-app onboarding payment work.

## 1. Summary

Let a web funnel's paywall take money on the page — card plus Apple Pay and
Google Pay, no redirect — charging through the customer's own connected
Stripe account, and hand the resulting entitlement to the app when the user
installs it.

B1 built the Connect rail (Standard accounts, direct charges, the
`AccountScopedStripe` facade). Phase B built the paywall: a builder config, a
React renderer, and the funnel wiring that hydrates a paywall into a funnel
page. **This sub-project fills in what happens when the purchase button is
pressed**, and nothing else.

## 2. What already exists — the seam

Verified in the tree as of this date:

- A funnel `paywall` page carries `paywallId`
  (`packages/shared/src/funnel/pages-schema.ts:118`).
- The public funnel bundle hydrates every referenced paywall into a `paywalls`
  map of `{ builderConfig, configFormatVersion, offering }`, deduped, omitting
  any paywall deleted or cleared since publish
  (`apps/api/src/routes/public/funnels.ts:73-96`).
- The renderer is interactive: package cells select
  (`packages/paywall-renderer/src/renderer.tsx:45-59`) and the purchase button
  fires `ctx.onPurchase(selectedId)`
  (`packages/paywall-renderer/src/nodes.tsx:250`).
- The renderer already accepts an optional
  `priceView?: Record<string, PackageView>` supplied by its consumer
  (`packages/paywall-renderer/src/types.ts:36`). **This is where real prices
  go.** The renderer stays display-only and learns nothing about Stripe.
- `chargesEnabled(projectId)` gates funnel publish already
  (`apps/api/src/lib/stripe-platform.ts:178`).
- An attribution contract exists and is stable: writing
  `rovenue_presented_context` (a JSON string of
  `{ placementId, paywallId, variantId?, experimentKey? }`) into Stripe
  subscription metadata is picked up for free by the Connect webhook
  (`apps/api/src/lib/presented-context.ts`,
  `apps/api/src/services/stripe/stripe-webhook.ts:592`).

So B3's entire job sits behind one callback.

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Serving domain | **Shared `app.rovenue.io/f/<slug>`** | Apple Pay requires registering the serving domain on each connected account. One domain, registered by API, is a small automatable step. Custom-domain serving is not wired at all today (Caddy proxies custom hosts to the API, which serves no HTML) and making it work is its own project. |
| Paywall model | **Build on Phase B** | Decided while Phase B was still in flight; its contracts have since landed and are verified in §2. B3 designs against them rather than against the legacy flat `productId` field, which stays only as the pre-Phase-B fallback. |
| Displayed price | **Resolved live from Stripe** | On a page that takes money, a hand-typed `metadata.price` string can drift from the real charge — the page would show one number and charge another, with nothing to catch it. Reading the Price object also tells us recurring-vs-one-time, so no separate field is needed. |
| Email | **Guaranteed by payment time** | Reuse one the funnel already collected; otherwise the payment step asks. Deep links and deferred fingerprint matching are best-effort; the magic link is the only guaranteed recovery path, and a paid user who cannot reach their purchase is the most expensive failure this feature has. Apple/Google Pay return an email themselves, so express payers see no extra field. |
| Intent creation | **Server-side, up front** | The amount never travels from the client, so it cannot be tampered with. Matches the existing platform-billing precedent, where a SetupIntent is created server-side and only its client secret reaches the browser. |

## 4. Non-goals

- Custom-domain funnel serving. Out of scope; see §3.
- Native (iOS/Android) paywall purchase. Those go through StoreKit and Play
  Billing and are unaffected.
- Changing the renderer. B3 supplies its `priceView` and `onPurchase` and
  touches nothing inside `packages/paywall-renderer`.
- Restore-purchases in funnels. Not applicable to an anonymous web session.
- Taxes, coupons, promotion codes, proration.

## 5. Stripe surface

`AccountScopedStripe`
(`apps/api/src/lib/stripe-account-scoped.ts:34-54`) exposes three methods
today, none of which can collect a card. B3 adds, each a reviewable one-liner
in `withAccount`:

- `prices.retrieve(id, options?)`
- `customers.create(params, options?)`
- `paymentIntents.create(params, options?)` and `paymentIntents.retrieve(id, options?)`
- `subscriptions.create(params, options?)` and `subscriptions.retrieve(id, options?)`
- `paymentMethodDomains.create(params, options?)` and `paymentMethodDomains.list(params, options?)`

The allow-list shape is deliberate and stays: a Proxy would have to guess which
argument is `params` and which is `options`, and guessing wrong sends the call
to Rovenue's platform account.

Two values reach the browser, both non-secret:
`STRIPE_PLATFORM_PUBLISHABLE_KEY` (declared at `apps/api/src/lib/env.ts:139`
and dead until now) and the connected account id. `loadStripe(publishableKey,
{ stripeAccount })` needs exactly these.

## 6. Price resolution

A package carries no amount. The only link to a real price is
`product.storeIds.stripe`, a `price_…` id on the connected account.

`apps/api/src/services/stripe/price-resolver.ts` resolves a set of package
identifiers for a project into
`Record<packageIdentifier, { unitAmount, currency, interval, intervalCount, trialDays }>`
by reading each Price from the connected account. Results are cached in Redis
under `stripe:price:<accountId>:<priceId>` for 5 minutes — long enough that
rendering a paywall is one round trip, short enough that a price change in
Stripe shows up quickly.

The public funnel bundle gains a `prices` map alongside the existing `paywalls`
map, and the runner feeds it to the renderer as `priceView` after formatting
with `Intl.NumberFormat` in the funnel's locale. A package whose product has no
`storeIds.stripe`, or whose Price cannot be read, is **omitted** from the map;
the renderer already degrades to blank strings for a missing entry, and §13
covers what the page does about it.

`price.recurring` decides subscription versus one-time. `trialDays` comes from
the Price's own `recurring.trial_period_days` when set; the funnel page's
legacy flat `trial` field is not read.

## 7. Payment flow

### `POST /public/funnel-sessions/:sessionId/payment-intent`

Body: `{ package_identifier: string, email: string }`. Rate-limited like its
siblings (30/min). Session identity stays in the URL path, never a cookie —
the public funnel CORS is `origin: "*"` and sends no credentials
(`apps/api/src/routes/public/funnels.ts:116-119`).

The server:

1. Loads the session; 409 unless `state === "in_progress"`.
2. Resolves project → connection; 409 `STRIPE_NOT_CONNECTED` unless
   `chargesEnabled(projectId)`.
3. Resolves the package through the funnel's hydrated paywall → offering →
   product → `storeIds.stripe`, then reads the Price. A package identifier not
   present in that offering is a 400 — the client cannot name an arbitrary
   price.
4. Creates a Stripe Customer with the email.
5. Recurring price → `subscriptions.create({ customer, items: [{ price }],
   payment_behavior: "default_incomplete", trial_period_days?,
   expand: ["latest_invoice.payment_intent", "pending_setup_intent"], metadata })`.
   One-time price → `paymentIntents.create({ amount, currency, customer,
   automatic_payment_methods: { enabled: true }, metadata })`.
   Metadata carries `rovenue_presented_context`, `rovenue_funnel_session_id`,
   `rovenue_project_id` and `rovenue_funnel_id`.
6. Upserts `funnel_purchases` with `status: "pending"`, the product id, amount,
   currency and the Stripe ids. Upsert, not insert: the row is unique per
   session, and a user who changes package before paying must not 500.
7. Returns `{ client_secret, mode: "payment" | "setup", publishable_key,
   stripe_account }`.

`mode` is `setup` when a trial means no payment is captured now, so the client
knows to call `confirmSetup` rather than `confirmPayment`.

### Client

The runner mounts `<Elements stripe={loadStripe(publishable_key, {
stripeAccount: stripe_account })} options={{ clientSecret }}>` with
`<ExpressCheckoutElement>` above and `<PaymentElement>` below, and confirms
with `redirect: "if_required"` so the user never leaves the page.

### `POST /public/funnel-sessions/:sessionId/confirm`

The server does **not** trust the client's word that payment succeeded. It
re-reads the PaymentIntent or Subscription from Stripe and accepts only
`succeeded` (one-time) or `active` / `trialing` (subscription). "Paid" here
means the purchase completed, not that money moved — a trial legitimately
moves none.

On acceptance, in one transaction: mark `funnel_purchases` paid, transition the
session to `paid`, create the synthetic subscriber (§8), mint the claim token,
and emit `funnel.session.paid` and `funnel.claim_token.issued`. Returns the
same `{ token, deep_link_url, universal_link_url }` shape the existing
claim-token endpoint returns.

Calling it twice mints no second token. It cannot return the first one
either: only the token's hash is stored, so the plaintext exists exactly once,
in the first response. A repeat call answers `200` with
`{ already_issued: true }` and no token, and the client is expected to have
kept what it was given. A client that lost it recovers through the email magic
link, which is the same path a user who never came back uses.

### Webhook backstop

If the user closes the tab after paying, `confirm` is never called. The
existing Connect webhook already receives `invoice.paid` /
`customer.subscription.created` for that account; B3 extends its handling so an
event carrying `rovenue_funnel_session_id` performs the same transition. Both
paths are idempotent and either may win.

## 8. Subscriber convergence

At confirm time the purchase belongs to nobody: the buyer has not installed the
app. A synthetic subscriber is created and anchored on the Stripe customer —
the webhook's existing `resolveSubscriber` already falls back to
`stripe:<customerId>`, so both paths converge on the same row without
fabricating an identity.

When the user installs and claims, `POST /v1/subscribers/claim-funnel-token`
merges the synthetic into the installed subscriber with `reassignAllAssets`
(`apps/api/src/services/subscriber-transfer.ts:64`) — purchases, access,
revenue events, experiment assignments and credits — exactly the pattern
already used for Apple and Google.

## 9. Three defects fixed here

These sit directly on B3's path and it cannot be tested end to end without
them:

1. **`settingsJson` casing.** The dashboard writes `devMode` /
   `universalLinkDomain`; the API reads `dev_mode` / `universal_link_domain`.
   `dev_mode` is therefore never true and deep links never resolve. Normalize
   on write through the existing snake_case
   `packages/shared/src/funnel/settings-schema.ts`, and migrate rows on read.
2. **`/advance` drops the paywall page id.** The evaluator returns
   `{ next: "paywall" }` even where it holds the concrete id
   (`packages/shared/src/funnel/evaluator.ts:62,65`), so the session's
   `currentPageId` never moves to the paywall and the runner dead-ends.
   Resolve a paywall target to `{ next: "page", page_id }` in all three cases
   — sequential fall-through, explicit goto by id, and the literal
   `"paywall"` goto when the funnel contains a paywall page — and persist
   `currentPageId` like any other page. The id-less `{ next: "paywall" }` form
   survives only for a funnel with no paywall page at all, which the publish
   validator already rejects (`MISSING_PAYWALL`), so it becomes unreachable in
   practice rather than being removed from the type.
3. **Claim returns no entitlements.** `buildClaimResponse` hardcodes
   `entitlements: []` (`apps/api/src/routes/v1/funnel-claim.ts:95`), so a paid
   web purchase grants the app nothing. Return the merged subscriber's real
   access ids.

## 10. Apple Pay

Stripe will not offer Apple Pay unless the domain serving the page is
registered on the account taking the payment. On connect — and on a reconcile
for accounts connected before this ships — register the funnel-serving domain
with `paymentMethodDomains.create` on the connected account, and record the
outcome on `project_stripe_connections` as
`apple_pay_domain_status` (`unregistered` | `registered` | `failed`) plus
`apple_pay_domain_checked_at`, so the paywall can tell whether express payment
is available and an operator can see which accounts need attention.

One-time infrastructure task: `app.rovenue.io` must serve Stripe's verification
file at the well-known path Stripe checks. Without it, registration reports the
domain as unverified and Apple Pay silently does not appear — the card form
still works, so this fails quietly and must be asserted at deploy.

## 11. Analytics

The paywall event pipeline already carries `paywall_view` with a
`paywallContext` and rolls up daily in ClickHouse.

B3 emits a purchase event into that pipeline **server-side**, from the confirm
transaction, alongside the existing `funnel.session.paid` outbox event. It
cannot come from the browser: `POST /v1/events` is API-key authenticated and a
public funnel page has no key. The event carries the same
`{ placementId, paywallId, variantId? }` context the purchase's Stripe
metadata already holds, so it joins to views on the same keys. The daily
rollup, which counts views only today, gains a purchase numerator.

**Known gap, deliberately not closed here:** nothing emits `paywall_view` for a
*funnel* paywall, for the same API-key reason. Until a public event path
exists, the funnel purchase count has no matching denominator and the
view→purchase rate is meaningful only for SDK-rendered paywalls. Emitting the
view server-side from the funnel `/advance` handler is the obvious fix and
belongs with whoever owns the funnel analytics surface.

## 12. Error handling

| Condition | Behaviour |
|---|---|
| Project not connected, or charges not enabled | Paywall renders its content with the purchase button disabled and an explanatory line; `payment-intent` 409s if called anyway |
| Package has no Stripe price, or the Price cannot be read | That package is omitted from `prices`; if the selected package has no price the purchase button is disabled rather than charging an unknown amount |
| Package identifier not in the paywall's offering | 400 — the client cannot name an arbitrary price |
| Card declined / authentication failed | Stay on the page, surface Stripe's own message, allow retry against the same intent |
| `confirm` called before the intent succeeded | 409, session unchanged |
| `confirm` called twice | `200 { already_issued: true }` with no token; no second token minted. The plaintext only ever exists in the first response — only its hash is stored |
| Tab closed after paying | Webhook performs the same transition |
| Session already `paid` | `payment-intent` 409s; `confirm` returns the existing token |

## 13. Testing

Unit: price resolution including the cache and the omit-on-failure path;
intent creation shape for recurring versus one-time, including that
`trial_period_days` produces `mode: "setup"`; metadata contains
`rovenue_presented_context` and the funnel session id.

Contract: **the amount is never read from the request body** — a test that
posts an amount and asserts the created intent used the Price's amount instead.

Confirm: accepts only `succeeded` / `active` / `trialing`; rejects a client
claiming success when Stripe disagrees; is idempotent across two calls.

Integration (real Postgres and Redis, Stripe stubbed at the
`stripe-account-scoped` boundary): select package → create intent → confirm →
claim token issued → SDK claim merges the synthetic subscriber and returns real
entitlements. Plus the tab-closed variant where the webhook, not `confirm`,
completes the session.

## 14. Rollout

One migration: the two `project_stripe_connections` columns from §10
(`apple_pay_domain_status`, `apple_pay_domain_checked_at`). `funnel_purchases`
already has every column this needs — `stripe_customer_id`,
`stripe_subscription_id`, `amount_cents`, `currency`, `product_id` — written
for the first time here.

Operator steps: serve Stripe's domain-verification file from
`app.rovenue.io`; set `STRIPE_PLATFORM_PUBLISHABLE_KEY` (and its test
counterpart), which were declared in B1 but never read; run the reconcile that
registers the domain on already-connected accounts.

Existing funnels are unaffected until republished — the paywall page only takes
payment when it references a paywall with a builder config and the project can
take charges.
