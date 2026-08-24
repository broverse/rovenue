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
// DROPPED — not merely omitted, but considered and rejected — because
// the bridge call site (webhook-processor.ts's `enqueueOutgoingWebhook`,
// invoked with only the bare store-native event-type string) cannot see
// the information needed to disambiguate direction:
//
// - Apple `DID_CHANGE_RENEWAL_STATUS` fires for BOTH re-enabling
//   auto-renew (would be `subscription.uncancelled`) and turning it off
//   (already covered by `subscription.cancel_requested`'s semantics —
//   mapping it here too would double-map the same real-world event under
//   two public keys). `apple-webhook.ts`'s `applyRenewalStatusChange()`
//   DOES read the direction off `ctx.renewalInfo?.autoRenewStatus`, but
//   that value is used only to update the `autoRenewStatus` column — it
//   is never threaded through `postProcess({ eventType })`, which always
//   carries the bare `notification.notificationType` string
//   ("DID_CHANGE_RENEWAL_STATUS") with no subtype/direction attached.
//   Mapping either direction here would misclassify the other half of
//   deliveries at least half the time. Accuracy over coverage.
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
// If a future task threads the subtype/delta through to the bridge site,
// these two rows can be reinstated with real evidence backing them.
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
