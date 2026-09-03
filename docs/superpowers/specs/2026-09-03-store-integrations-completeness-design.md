# Store Integrations — Dunning, External Purchase, and Reconciliation

**Date:** 2026-09-03
**Roadmap area:** §1 Store integrations & receipt validation (75 → 95) — three of its six items
**Scope:** three **independent** subsystems in one spec. Each ships alone, in any order, and
none depends on the others. They are grouped only because they are the same roadmap
section; if the plan splits them into three, nothing is lost.

---

## 1. Context — what reconnaissance found

Unusually for this roadmap, all three items are genuinely open. Each was deferred
deliberately by an earlier batch rather than quietly forgotten, and recon found no hidden
prior work for any of them.

### 1.1 Stripe dunning — the state machine is right, the recovery path does not exist

What already works, and should not be rebuilt: `mapStripeStatus`
(`services/stripe/stripe-webhook.ts:1130`) maps `past_due`, `unpaid` and `incomplete` to
`GRACE_PERIOD`, `paused` to `PAUSED`, `canceled`/`incomplete_expired` to `EXPIRED`. Eight
Stripe event types are handled, `invoice.payment_failed` among them, and it already bridges
to `subscription.billing_issue`.

What does not exist at all: **any way for a customer to fix the payment method.**
`grep -rn "billing_portal"` over `apps/api/src` returns nothing. So a subscription enters
`GRACE_PERIOD` because a card expired, the integration fires a billing-issue event, a
dunning email goes out — and the link in that email has nowhere to point. Involuntary churn
is detected end-to-end and cannot be acted on.

Two dunning-relevant Stripe events are also unhandled:

- **`invoice.payment_action_required`** — the renewal needs SCA/3DS authentication. Without
  it, a European renewal that merely needs a tap silently behaves like a hard failure.
- **`customer.subscription.trial_will_end`** — the standard hook for "your trial ends in
  three days", which the trial-conversion funnel has no signal for today.

### 1.2 A latent fail-open found while reading the mapper

`mapStripeStatus`'s `default` branch returns `PurchaseStatus.ACTIVE`.

An unrecognised Stripe status therefore **grants entitlement**. Stripe has added statuses
before (`paused` is recent), and the failure mode is silent: a subscriber in a status we do
not understand keeps full access, and nothing logs. This is not one of the three roadmap
items; it was found on the way and belongs in the same work because it is three lines from
it.

### 1.3 Apple External Purchase / EU DMA — nothing exists, and the honest scope is narrow

`grep -rn "EXTERNAL_PURCHASE"` across `apps/api/src` and `packages/shared/src` returns
nothing. Apple's `EXTERNAL_PURCHASE_TOKEN` notification is unhandled, and there is no
representation for a purchase that happened outside StoreKit.

**The roadmap's own wording is the right scope: "in the event model".** Building a full
external-purchase implementation would mean the External Purchase Server API, token
reporting deadlines, and per-region commission accounting — none of which can be tested
without an Apple external-purchase entitlement that this repo does not have and cannot
obtain in development. Shipping untestable integration code against a third-party API is how
the `revenuecat_google_token` preset ended up detectable-but-never-importable.

So: model the event, verify what we can, and be explicit in the docs about what is not
implemented.

### 1.4 Google reconciliation — the pieces exist, the sweep does not

Deferred from the 2026-08-23 store-billing correctness batch, whose own note reads
*"historical Google reconciliation job"*.

The building blocks are all present: `verifyGoogleSubscription`
(`services/google/google-verify.ts:30`), `getGoogleAccessToken`,
`expireSupersededGooglePurchase`, and `mapSubscriptionStateToStatus`. There is also a direct
precedent for re-verifying against a store *without* doing subscriber reconciliation — the
import's Phase B (`services/import/verify-store-clients.ts`), which deliberately calls the
layer underneath `receipt-verify.ts` for exactly that reason.

What is missing is the sweep: nothing periodically asks Google "is this purchase still what
we think it is?" RTDN delivery is best-effort, so a dropped notification leaves a purchase
permanently wrong — expired in Google, ACTIVE in Rovenue, entitlement still granted.

### 1.5 The shape

Two of the three are **recovery paths for things the system already detects correctly**:
Stripe knows a card failed but cannot offer a fix; nothing catches a Google purchase whose
notification was lost. The third is a deliberately narrow event-model addition. None of them
is a rewrite.

## 2. Goals

1. A customer whose payment method fails can fix it, and SCA-required renewals are
   distinguishable from hard failures.
2. An unrecognised Stripe status stops granting entitlement.
3. Apple external purchases have a representation in the event model, with the unimplemented
   parts named rather than implied.
4. A Google purchase whose RTDN was lost is detected and corrected on a schedule.

## 3. Non-goals

- **No dunning email content or scheduling.** Rovenue already has notification machinery;
  this provides the portal link and the events, not a campaign engine.
- **No full Apple External Purchase implementation.** See §1.3. Token reporting and
  commission accounting are out.
- **No new store.** Amazon, Paddle and Roku are separate roadmap items.
- **No change to `mapStripeStatus`'s existing mappings.** `past_due` → `GRACE_PERIOD` is
  correct and load-bearing; only the `default` changes.
- **No re-verification of Apple or Stripe purchases.** The reconciliation sweep is Google
  only, because Google's RTDN is the delivery channel with the known gap. Apple and Stripe
  reconciliation are their own decisions with their own rate limits.

---

## 4. Design

### 4.1 Stripe: a billing-portal session endpoint

A single authenticated endpoint that creates a Stripe billing-portal session for the calling
subscriber and returns its URL. Stripe hosts the page; Rovenue issues the session.

Requirements that are easy to get wrong:

- **The session must be scoped to the subscriber's own Stripe customer**, resolved
  server-side from the subscriber record — never from a customer id supplied by the client.
  A customer id in a request body is an account-takeover primitive.
- **Return URL must be validated** against the project's configured domains rather than
  echoed from the request, for the same reason the SSRF guard exists on outbound webhooks.
- The endpoint belongs on the **SDK-facing** surface (public API key + subscriber identity),
  because the app is what needs to open it — not the dashboard.
- Stripe Connect: the session is created on the **connected account**, following whatever
  `requireConnectedStripe` already establishes. Do not introduce a second way to resolve the
  account.

### 4.2 Stripe: two more events, and the fail-open

- **`invoice.payment_action_required`** → a distinct signal from a hard payment failure. It
  maps to the existing `subscription.billing_issue` public key (the subscriber does need to
  act), but the stored reason must distinguish it, because "tap to approve" and "your card
  was declined" are different emails.
- **`customer.subscription.trial_will_end`** → `subscription.trial.will_end`, a new public
  event key. This follows §6's rule: a key per distinct subscriber-facing meaning. Apple and
  Google have no equivalent notification, so **document the per-store coverage** exactly as
  §6 does for `subscription.recovered`.
- **`mapStripeStatus`'s `default`** stops returning `ACTIVE`. An unknown status must not
  grant entitlement; it should map to the most conservative state that does not, and **log
  loudly with the unrecognised value** so the gap is visible rather than silent.

### 4.3 Apple External Purchase: model the event, name the gap

Handle `EXTERNAL_PURCHASE_TOKEN` as a first-class notification type: record that an external
purchase occurred, attach it to the subscriber, and emit a public event key for it.

What must **not** happen: fabricating revenue. An external-purchase token identifies a
purchase Apple did not process, and Rovenue has no price for it. Recording a revenue event
with a guessed amount would corrupt every downstream aggregate — the same rule as "never
fabricate currency" from the Wave-2 providers work.

So the event carries the fact and the token; the money follows only if and when the
developer reports it through an explicit API. Document that boundary; do not imply
end-to-end external-purchase revenue.

**Testing is the honest constraint.** Without an Apple external-purchase entitlement, this
can be verified against the notification's documented shape and our own decoder, not against
Apple. Say so in the docs rather than implying it was exercised live.

### 4.4 Google reconciliation sweep

A repeatable worker that re-verifies Google purchases whose local state may have drifted,
following the worker conventions already established (`<X>_QUEUE_NAME`, `run<X>Sweep`,
`schedule<X>`, `create<X>Worker`, wired in `index.ts`) and the **per-row claim** pattern so
two instances cannot both process a purchase.

Design decisions that matter:

- **Reuse `verifyGoogleSubscription` and `mapSubscriptionStateToStatus`.** The import's
  Phase B is the precedent for calling that layer without doing subscriber reconciliation.
  A second Google verification path would drift from the first.
- **Bound the work.** Google's Developer API is rate-limited and a project may have millions
  of purchases. Select candidates — not everything — by a rule stated in the code: purchases
  whose expiry has passed but which are still ACTIVE, and purchases not re-verified within a
  named interval, oldest first, capped per sweep.
- **A drift correction is a real state transition**, so it must flow through the same path a
  webhook would: update the purchase, sync entitlements, emit the outbox event. A sweep that
  silently fixes the database and skips the outbox would leave every integration consumer
  with the old state — the exact asymmetry §6 exists to remove.
- **Record what it found.** A sweep that corrects drift without counting it cannot answer
  "is our RTDN delivery healthy?", which is the question that justifies the job.

---

## 5. Data changes

- A timestamp on purchases recording the last reconciliation check, so the sweep can order
  candidates and not re-check the same rows forever. Nullable, defaulting to null; a null
  means "never checked" and sorts first.
- Whatever the external-purchase token needs to persist — likely a row keyed by token with
  the subscriber and the notification's own identifiers. It must **not** reuse the
  `purchases` table's store-transaction unique index, because an external purchase has no
  store transaction.

No ClickHouse change: reconciliation corrections flow through the existing outbox path and
land like any other state transition.

## 6. Risks and decisions worth stating

- **The billing-portal endpoint is a new SDK-facing surface that returns a URL granting
  access to payment data.** It needs the same scrutiny as an auth endpoint: subscriber
  identity resolved server-side, return URL allow-listed, rate limited.
- **Changing `mapStripeStatus`'s default is a behaviour change for unknown statuses.** If
  any project currently has subscribers in a status we do not map, they lose entitlement on
  deploy. Measure that before shipping: query for statuses outside the known set and report
  the count. If it is non-zero, the finding is more important than the fix.
- **The reconciliation sweep can generate a burst of corrections on first run** — every
  purchase that drifted since RTDN began. Each emits an outbox event, so integration
  consumers would receive a flood of state changes for old subscribers. The first run needs a
  deliberate answer: either a low cap that spreads it over days, or an explicit backfill mode
  that corrects without emitting. **Decide it in the plan; do not discover it in production.**
- **External-purchase code cannot be tested against Apple.** That is not a reason to skip it,
  but it is a reason to keep the surface small and the docs honest.

## 7. Acceptance criteria

1. A subscriber can obtain a billing-portal URL through the SDK-facing API; the Stripe
   customer is resolved server-side from their subscriber record and a customer id in the
   request body is ignored or rejected.
2. The return URL is validated against configured domains; an arbitrary URL is rejected,
   proven by a test.
3. `invoice.payment_action_required` is handled and distinguishable from
   `invoice.payment_failed` in what is stored, while both surface the billing-issue key.
4. `subscription.trial.will_end` exists as a public key, is mapped by every provider whose
   catalog claims it, and its Stripe-only coverage is documented.
5. `mapStripeStatus` no longer grants `ACTIVE` for an unknown status, logs the unrecognised
   value, and the count of subscribers currently in an unmapped status is reported before the
   change ships.
6. An `EXTERNAL_PURCHASE_TOKEN` notification is recorded against the subscriber and emits a
   public event key, with **no revenue event** and no fabricated amount.
7. The docs state plainly which parts of Apple external purchase are not implemented and that
   the handling was verified against the documented payload shape, not against Apple.
8. The reconciliation sweep detects a purchase that Google reports as expired while Rovenue
   has it ACTIVE, corrects it, syncs entitlements, **and emits the outbox event**, proven by
   an integration test against a real database.
9. The sweep is bounded by a stated candidate rule and a per-sweep cap, and two concurrent
   sweeps cannot process the same purchase.
10. The first-run burst has an explicit answer in the code, chosen deliberately rather than
    inherited.
11. Every transition the sweep makes is audited, attributed to the sweep rather than a user.
