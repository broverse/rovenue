export const ROVENUE_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
  "subscription.cancel_requested",
  "subscription.expired",
  // Wave-1 narrow store-lifecycle normalization (2026-08-24): store-native
  // signals bridged onto these via STORE_EVENT_TO_PUBLIC_KEY
  // (store-event-normalization.ts) — see that file for the exact mapping
  // table and the two ambiguous rows deliberately excluded from it.
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
  "paywall.view",
  "paywall.close",
  "credit.ledger.appended",
] as const;

export type RovenueEventKey = (typeof ROVENUE_EVENT_KEYS)[number];

export function isRovenueEventKey(s: string): s is RovenueEventKey {
  return (ROVENUE_EVENT_KEYS as readonly string[]).includes(s);
}

export type IntegrationProviderId =
  | "META_CAPI"
  | "TIKTOK_EVENTS"
  | "CUSTOM_WEBHOOK"
  | "AMPLITUDE";

export const WEBHOOK_API_VERSION = "2026-08-24";

export type IntegrationDeliveryStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "dead_letter";
