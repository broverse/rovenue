// =============================================================
// Outgoing-webhook event categories
// =============================================================
//
// Operators subscribe a project's webhook endpoint to a subset of
// these normalized categories. Store-native event strings (Apple
// notificationType, Google notificationType, Stripe eventType) are
// folded into one category via `toWebhookEventCategory`. An empty
// subscription list means "all events".

export const WEBHOOK_EVENT_CATEGORIES = [
  "purchase",
  "renewal",
  "cancellation",
  "refund",
  "billing_issue",
  "expiration",
  "product_change",
] as const;

export type WebhookEventCategory = (typeof WEBHOOK_EVENT_CATEGORIES)[number];

const EVENT_TYPE_TO_CATEGORY: Record<string, WebhookEventCategory> = {
  // Apple App Store Server Notifications v2 (notificationType)
  SUBSCRIBED: "purchase",
  OFFER_REDEEMED: "purchase",
  DID_RENEW: "renewal",
  RENEWAL_EXTENDED: "renewal",
  DID_CHANGE_RENEWAL_STATUS: "cancellation",
  REFUND: "refund",
  REFUND_DECLINED: "refund",
  DID_FAIL_TO_RENEW: "billing_issue",
  GRACE_PERIOD_EXPIRED: "billing_issue",
  EXPIRED: "expiration",
  REVOKE: "expiration",
  DID_CHANGE_RENEWAL_PREF: "product_change",
  PRICE_INCREASE: "product_change",

  // Google Play Real-time Developer Notifications (subscriptionNotificationType)
  SUBSCRIPTION_PURCHASED: "purchase",
  SUBSCRIPTION_RESTARTED: "purchase",
  SUBSCRIPTION_RENEWED: "renewal",
  SUBSCRIPTION_RECOVERED: "renewal",
  SUBSCRIPTION_CANCELED: "cancellation",
  SUBSCRIPTION_PAUSED: "cancellation",
  SUBSCRIPTION_ON_HOLD: "billing_issue",
  SUBSCRIPTION_IN_GRACE_PERIOD: "billing_issue",
  SUBSCRIPTION_EXPIRED: "expiration",
  SUBSCRIPTION_REVOKED: "expiration",
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: "product_change",
  SUBSCRIPTION_DEFERRED: "product_change",

  // Stripe (event.type) — confirmed against stripe-types.ts STRIPE_EVENT_TYPE constants:
  // customer.subscription.created, customer.subscription.updated,
  // customer.subscription.deleted, invoice.paid, invoice.payment_failed,
  // charge.refunded. invoice.payment_succeeded is NOT handled by the service
  // but is a valid Stripe event mapped here for completeness.
  "customer.subscription.created": "purchase",
  "invoice.payment_succeeded": "renewal",
  "invoice.paid": "renewal",
  "customer.subscription.deleted": "cancellation",
  "charge.refunded": "refund",
  "invoice.payment_failed": "billing_issue",
  "customer.subscription.updated": "product_change",
};

/**
 * Fold a store-native event string into a normalized category.
 * Returns null for unmapped values — callers that filter on
 * categories MUST treat null as "deliver anyway" (fail open) so new
 * or unknown event types are never silently dropped.
 */
export function toWebhookEventCategory(
  eventType: string,
): WebhookEventCategory | null {
  return EVENT_TYPE_TO_CATEGORY[eventType] ?? null;
}
