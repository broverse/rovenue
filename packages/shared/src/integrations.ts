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

// ---------------------------------------------------------------------------
// Shared event-key SUBSETS
// ---------------------------------------------------------------------------
//
// These live here, next to ROVENUE_EVENT_KEYS, rather than in apps/api,
// because BOTH sides need them: the api provider mappers and the fan-out
// consumer, and the dashboard drawer's event picker (which cannot import from
// apps/api). Before this they were hand-copied into five provider files, the
// fan-out consumer and step-events.tsx — seven places to keep in step by eye.
//
// Every subset carries a `satisfies readonly RovenueEventKey[]` guard, so a
// typo or a key removed from ROVENUE_EVENT_KEYS fails tsc here instead of
// silently mapping to nothing at runtime.

/** Prefix shared by every revenue key in ROVENUE_EVENT_KEYS. */
const REVENUE_EVENT_KEY_PREFIX = "revenue.";

/** The revenue.* keys, in catalog order — derived from ROVENUE_EVENT_KEYS so
 *  a new revenue kind cannot be added to one list and forgotten in the other. */
export const REVENUE_EVENT_KEYS: readonly RovenueEventKey[] =
  ROVENUE_EVENT_KEYS.filter((key) => key.startsWith(REVENUE_EVENT_KEY_PREFIX));

/**
 * The subscription-lifecycle keys the outbox SUBSCRIPTION bridge publishes on
 * `rovenue.subscription`: two with dedicated producers (scheduled-actions /
 * expiry-checker) and four normalized from store-native signals via
 * STORE_EVENT_TO_PUBLIC_KEY. The fan-out consumer's subscription envelope
 * builder accepts exactly these.
 */
export const SUBSCRIPTION_BRIDGE_EVENT_KEYS = [
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
] as const satisfies readonly RovenueEventKey[];

/** The one lifecycle key that does NOT come from the SUBSCRIPTION bridge —
 *  it has its own producer and rides the revenue topic. */
export const TRIAL_STARTED_EVENT_KEY = "subscription.trial.started" as const;

/**
 * What a provider mapper treats as "this envelope's eventType IS already a
 * public event key" — the bridge keys plus `subscription.trial.started`.
 * Those RovenueEventType values are spelled identically to their
 * RovenueEventKey counterparts, which is what makes the pass-through sound;
 * apps/api's types.ts asserts that identity at compile time.
 */
export const SUBSCRIPTION_LIFECYCLE_KEYS = [
  TRIAL_STARTED_EVENT_KEY,
  ...SUBSCRIPTION_BRIDGE_EVENT_KEYS,
] as const satisfies readonly RovenueEventKey[];

/**
 * The 13-key revenue + subscription-lifecycle catalog every Wave-1 analytics
 * / attribution provider offers (AMPLITUDE, MIXPANEL, APPSFLYER, ADJUST,
 * FIREBASE_GA4) and the drawer's event picker renders for them. It is
 * deliberately NOT the full ROVENUE_EVENT_KEYS: `subscriber.identified`,
 * `paywall.*` and `credit.ledger.appended` have no mapping in those
 * providers, and only the catch-all providers (CUSTOM_WEBHOOK, SLACK) offer
 * the complete set.
 */
export const STANDARD_PROVIDER_EVENT_KEYS = [
  ...REVENUE_EVENT_KEYS,
  ...SUBSCRIPTION_LIFECYCLE_KEYS,
] as const satisfies readonly RovenueEventKey[];

export type IntegrationProviderId =
  | "META_CAPI"
  | "TIKTOK_EVENTS"
  | "CUSTOM_WEBHOOK"
  | "AMPLITUDE"
  | "MIXPANEL"
  | "APPSFLYER"
  | "ADJUST"
  | "SLACK"
  | "FIREBASE_GA4"
  // Wave-2 Task 4 — first LIFECYCLE-category provider.
  | "BRAZE"
  // Wave-2 Task 5 — second lifecycle-category provider (rail/homepage
  // already activated by BRAZE).
  | "ONESIGNAL"
  // Wave-2 Task 6 — third lifecycle-category provider.
  | "ITERABLE";

export const WEBHOOK_API_VERSION = "2026-08-24";

export type IntegrationDeliveryStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "dead_letter";
