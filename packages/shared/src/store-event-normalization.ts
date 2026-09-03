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
//   STILL DROPPED as of the same pass that resolved the Apple row above:
//   the prior `cancel_at_period_end`/`autoRenewStatus` value is still not
//   reachable at `syncSubscription`/`upsertPurchaseFromSubscription`
//   (stripe-webhook.ts) without widening a shared utility.
//   `guardStatusWrite` (subscription-transition-guard.ts) locks and reads
//   the prior row via `lockPurchaseStatusByStoreTransaction`, but that
//   query only selects `id, status, lastStoreEventAt` — not
//   `autoRenewStatus` — and it backs every store's status-guard path
//   (Apple, Google, Stripe, refunds, google-supersede), not just this
//   one. `upsertPurchaseFromSubscription`'s write is a single
//   `INSERT … ON CONFLICT DO UPDATE`, which never reads the row it is
//   about to overwrite either. Widening either one to smuggle the prior
//   value through is exactly the wider refactor this row is not worth
//   forcing — a row that misclassifies half its deliveries is worse than
//   no row. Reinstating this one still requires that follow-up.
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

  // Stripe (event.type)
  "invoice.payment_failed": "subscription.billing_issue",
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
