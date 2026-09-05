import type { RovenueEventKey } from "./integrations";

// =============================================================
// Store-native lifecycle event normalization (Wave-1, narrow)
// =============================================================
//
// Maps store-native event-type strings — Apple App Store Server
// Notifications v2 `notificationType`, Google Play RTDN `notificationType`
// (the NAMED form; see google-mappers.ts's classifyNotification numeric
// fix, which is what makes these strings reachable at all), and Stripe
// `event.type` — onto the small set of NEW `subscription.*`
// RovenueEventKeys that don't already have a producer.
//
// This is a SEPARATE map from `webhook-events.ts`'s
// `EVENT_TYPE_TO_CATEGORY`: that one folds store-native types into a
// coarse v1 webhook-subscription *category* (7 buckets, used only for
// the legacy `project.webhookEventCategories` filter). This one produces
// an actual v2 `RovenueEventKey` — the type carried on the outbox bridge
// and delivered to CUSTOM_WEBHOOK / provider integrations. Deliberately
// not merged: conflating "categorize for a filter" with "mint a public
// event key" would make either concern harder to change independently.
//
// `subscription.cancel_requested` / `subscription.expired` already have
// real producers (scheduled-actions.ts / expiry-checker.ts) and are NOT
// duplicated here — this map only carries NEW keys with no other source.
//
// Two rows were evaluated against the spec table and deliberately
// DROPPED from this flat table — not merely omitted, but considered and
// rejected — because the bridge call site (webhook-processor.ts's
// `enqueueOutgoingWebhook`, invoked with only the bare store-native
// event-type string) could not see the information needed to
// disambiguate direction:
//
// - Apple `DID_CHANGE_RENEWAL_STATUS` fires for BOTH re-enabling
//   auto-renew (would be `subscription.uncancelled`) and turning it off
//   (already covered by `subscription.cancel_requested`'s semantics —
//   mapping it here too would double-map the same real-world event under
//   two public keys). `apple-webhook.ts`'s `applyRenewalStatusChange()`
//   DOES read the direction off `ctx.renewalInfo?.autoRenewStatus`, but
//   that value was used only to update the `autoRenewStatus` column — it
//   was never threaded through `postProcess({ eventType })`, which always
//   carries the bare `notification.notificationType` string
//   ("DID_CHANGE_RENEWAL_STATUS") with no subtype/direction attached.
//   Mapping either direction here would misclassify the other half of
//   deliveries at least half the time. Accuracy over coverage.
//
//   RESOLVED: the direction now IS threaded through — see
//   `resolveStorePublicKey` below, which layers an optional
//   `StoreEventContext` on top of this flat table instead of adding the
//   row here (a flat `Record<string, RovenueEventKey>` has nowhere to
//   hang a condition). Turning auto-renew back ON maps to
//   `subscription.uncancelled`; turning it OFF still maps to nothing —
//   the double-map risk this comment describes is specifically about the
//   OFF direction, and that risk is real regardless of how much context
//   reaches the bridge, so OFF stays deliberately unmapped here.
//
// - Stripe `customer.subscription.updated` fires on ANY field change to
//   a subscription (price, metadata, `cancel_at_period_end`, …), and
//   only a `cancel_at_period_end` flip is a meaningful lifecycle signal.
//   The Stripe webhook's `postProcess` call is likewise only ever handed
//   the bare `event.type` ("customer.subscription.updated") — the
//   before/after delta needed to tell "cancel flipped" from "price
//   changed" from "metadata touched" never reaches the bridge site (the
//   handler writes `autoRenewStatus: !subscription.cancel_at_period_end`
//   unconditionally, with no comparison against the prior value). Same
//   judgment: drop rather than guess.
//
//   THE BEFORE-IMAGE NOW EXISTS, AND STILL DOESN'T BELONG HERE.
//   `guardStatusWrite` (subscription-transition-guard.ts) now returns
//   `previous` — `{ status, productId, autoRenewStatus }` read under the
//   same FOR UPDATE lock as the write — so the delta this row wanted is
//   reachable at `syncSubscription`/`upsertPurchaseFromSubscription`
//   (stripe-webhook.ts) after all. What that changed is WHERE the
//   product-change signal is produced, not this table:
//   `subscription.product_changed` is emitted directly by
//   `emitProductChanged` (apps/api/src/services/subscription-plan-change.ts)
//   from inside the guarded upsert's transaction, for all three stores,
//   and only when the product on the purchase ACTUALLY moved.
//
//   This table cannot express that condition and is not being asked to.
//   It is keyed by store event type alone: "a `customer.subscription.
//   updated` arrived" is not "the plan changed", and mapping it here would
//   fire on every metadata touch. The rows it does carry below stay —
//   they announce that a store said a change is coming
//   (DID_CHANGE_RENEWAL_PREF, SUBSCRIPTION_DEFERRED,
//   SUBSCRIPTION_PRICE_CHANGE_CONFIRMED), which is a different and still
//   useful fact, and covers the Apple DOWNGRADE case that takes effect at
//   the next renewal and so performs no purchase write today.
//
//   `cancel_at_period_end` remains dropped for the original reason: the
//   guard's `previous.autoRenewStatus` answers "did auto-renew flip", but
//   the flip is written unconditionally by the handler, so reinstating the
//   row means teaching THIS event-type-keyed table a per-delivery
//   condition it has no place to hold. Same judgment as before: a row that
//   misclassifies half its deliveries is worse than no row.
export const STORE_EVENT_TO_PUBLIC_KEY: Record<string, RovenueEventKey> = {
  // Apple App Store Server Notifications v2 (notificationType)
  DID_FAIL_TO_RENEW: "subscription.billing_issue",
  GRACE_PERIOD_EXPIRED: "subscription.billing_issue",
  DID_CHANGE_RENEWAL_PREF: "subscription.product_changed",

  // Google Play RTDN (NAMED types — reachable now that
  // google-mappers.ts's classifyNotification maps the numeric
  // notificationType through a named table instead of interpolating it
  // raw into "SUBSCRIPTION_${n}")
  SUBSCRIPTION_ON_HOLD: "subscription.billing_issue",
  SUBSCRIPTION_IN_GRACE_PERIOD: "subscription.grace_period",
  SUBSCRIPTION_RESTARTED: "subscription.uncancelled",
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: "subscription.product_changed",
  SUBSCRIPTION_DEFERRED: "subscription.product_changed",

  // Google — paused / recovered / revoked (2026-09-03).
  //
  // `SUBSCRIPTION_RECOVERED` already produces a REACTIVATION revenue event
  // (google-mappers.ts), so this key is a SECOND signal for the same
  // delivery. It earns that because REACTIVATION is produced by BOTH
  // `SUBSCRIPTION_RECOVERED` (a billing failure resolved) and
  // `SUBSCRIPTION_RESTARTED` (a user re-subscribing after cancelling), and
  // a consumer seeing REACTIVATION cannot tell them apart — yet they need
  // opposite follow-ups: one stops a dunning campaign, the other stops a
  // win-back campaign. The revenue event says money moved; this says which
  // state transition produced it.
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_RECOVERED: "subscription.recovered",
  SUBSCRIPTION_REVOKED: "subscription.revoked",

  // Apple — REVOKE (2026-09-03). Until now `applyRevoke` wrote the chain
  // status and revoked access while emitting NOTHING: no revenue event and
  // no lifecycle key, so an Apple subscriber could lose access with zero
  // signal to any consumer. Google's SUBSCRIPTION_REVOKED never had that
  // gap (it classifies to a REFUND revenue event), which is why both stores
  // map here: one meaning, one key, rather than a key whose mechanism
  // differs per store.
  //
  // NOT mapped to `subscription.expired`: that is an end-of-term expiry,
  // and a revoke is an involuntary immediate termination. NOT given a
  // fabricated REFUND revenue event either — a family-sharing removal
  // involves no money, and inventing an amount would corrupt every
  // downstream aggregate.
  REVOKE: "subscription.revoked",

  // Apple — OFFER_REDEEMED (2026-09-03). The subscriber redeemed a
  // promotional offer, an offer code, or a win-back offer. It had no row
  // here because it had no handler at all: `apple-webhook.ts`'s dispatch
  // switch never named it, so it fell through the default branch and a
  // win-back return from a fully lapsed subscription produced no state
  // change, no revenue and no event. `applyOfferRedeemed` now handles it,
  // and this row is what carries the fact to consumers.
  //
  // NOT folded onto `subscription.uncancelled`: that means auto-renew was
  // switched back on for a subscription that never lapsed. A win-back
  // redemption is the opposite situation — the subscription HAD lapsed —
  // and the two need opposite campaign follow-ups. NOT `product_changed`
  // either: the redeemed offer is very often for the same product.
  //
  // Apple is the only store with a row here. Google delivers an offer
  // redemption as an ordinary SUBSCRIPTION_PURCHASED/RECOVERED with the
  // offer named inside the purchase resource rather than as its own
  // notification type, and Stripe has no equivalent event at all — so
  // there is nothing to key on for either without inventing one.
  OFFER_REDEEMED: "subscription.offer_redeemed",

  // Stripe (event.type)
  "invoice.payment_failed": "subscription.billing_issue",

  // Stripe gets no `paused` row: its paused status arrives on
  // `customer.subscription.updated`, whose delta never reaches this
  // bridge (see the deferral above).
  //
  // Stripe (and Apple) get no `recovered` row HERE either, but for a
  // different reason than `paused` does: `recovered` is produced directly
  // by the Apple and Stripe webhook handlers (`subscription-plan-change.ts`'s
  // `emitSubscriptionRecovered`) on the `BILLING_ISSUE -> granting`
  // transition, rather than by this table. This table is keyed on event
  // TYPE, and a recovery is a state TRANSITION: Stripe's
  // `customer.subscription.updated` and Apple's `DID_RENEW` each fire on
  // an ordinary renewal of an already-ACTIVE row just as often as on a
  // genuine recovery, so the bare event-type string can't tell the two
  // apart. The handlers can, because they read the guard's before-image —
  // the row's actual prior status, captured under the same lock as the
  // write — instead of the event type alone.
};

// =============================================================
// Disambiguated resolution — for rows the flat table above can't hold
// =============================================================
//
// `STORE_EVENT_TO_PUBLIC_KEY` is a pure `eventType -> key` table because
// every row in it is unconditionally true. Apple `DID_CHANGE_RENEWAL_STATUS`
// isn't: the same event-type string means two different real-world facts
// depending on direction, so it cannot live in that table without being
// wrong for one direction. `resolveStorePublicKey` is the widened bridge
// this file's exclusion comment named as the fix — it layers an optional
// `StoreEventContext` on top of the flat table so a caller that HAS the
// disambiguating fact can pass it, and every caller that doesn't (Google,
// Stripe, and Apple's own other notification types) gets back exactly
// `STORE_EVENT_TO_PUBLIC_KEY[eventType]`, unchanged.

const APPLE_RENEWAL_STATUS_CHANGED = "DID_CHANGE_RENEWAL_STATUS";

/**
 * Optional disambiguating fact a caller can thread alongside a bare
 * store-native event-type string. Every field is optional: a caller with
 * nothing to add omits `context` entirely (or passes `undefined`) and
 * `resolveStorePublicKey` behaves exactly like a `STORE_EVENT_TO_PUBLIC_KEY`
 * lookup.
 */
export interface StoreEventContext {
  /**
   * Apple `DID_CHANGE_RENEWAL_STATUS` only — the auto-renew direction read
   * off `ctx.renewalInfo.autoRenewStatus` (`=== 1`) inside
   * `apple-webhook.ts`'s `applyRenewalStatusChange`. `true` means
   * auto-renew was turned back ON for this delivery.
   */
  autoRenewEnabled?: boolean;
}

/**
 * Resolve a store-native event type to the `RovenueEventKey` it should
 * bridge onto, given whatever disambiguating context the caller has.
 * Called from webhook-processor.ts's `enqueueOutgoingWebhook` ONLY for
 * event types that are not already a public key themselves
 * (`isRovenueEventKey` is checked first at that call site).
 */
export function resolveStorePublicKey(
  eventType: string,
  context?: StoreEventContext,
): RovenueEventKey | undefined {
  if (eventType === APPLE_RENEWAL_STATUS_CHANGED) {
    // ON reinstates `subscription.uncancelled`. OFF stays unmapped — not
    // because the direction is unknown anymore, but because the
    // exclusion comment's stated risk (double-mapping the same
    // real-world cancel under `subscription.cancel_requested` AND a
    // second key here) is specific to OFF and doesn't go away once the
    // direction is known. See the comment above
    // `STORE_EVENT_TO_PUBLIC_KEY`.
    return context?.autoRenewEnabled === true
      ? "subscription.uncancelled"
      : undefined;
  }
  return STORE_EVENT_TO_PUBLIC_KEY[eventType];
}
