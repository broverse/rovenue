export const ROVENUE_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  // 2026-09-04 — a purchase that does not renew (non-consumable IAP, or a
  // one-time Stripe funnel package). Distinct from revenue.INITIAL
  // because the ad platforms map INITIAL to "Subscribe", which is wrong
  // for a purchase that never becomes a subscription.
  "revenue.NON_RENEWING_PURCHASE",
  // 2026-09-04 — REACTIVATION has been PRODUCED since Apple's RESUBSCRIBE
  // handler shipped, but had no key, so every provider skipped it with
  // `filtered_by_event_scope` and nothing logged. It carries two
  // meanings — a lapsed subscriber returning, and a refund being undone —
  // and the payload's `metadata.reason: "refund_reversed"` is what tells
  // them apart. See apple-webhook.ts's applyRefundReversed.
  "revenue.REACTIVATION",
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
  // 2026-09-03: three meanings the catalog lacked. `paused` and `revoked`
  // are store-native on Google (and `revoked` on Apple too); `recovered`
  // is Google-only — see store-event-normalization.ts for why neither
  // Apple nor Stripe gets an inferred one.
  "subscription.paused",
  "subscription.recovered",
  "subscription.revoked",
  // 2026-09-03: Apple OFFER_REDEEMED had no key because it had no
  // handler at all — the notification fell through the dispatch switch's
  // default branch, so a subscriber could come back from a fully lapsed
  // subscription on a win-back offer and produce no state change, no
  // revenue event and no lifecycle key. It is not `uncancelled` (the
  // subscription had already lapsed, there was nothing to un-cancel) and
  // not `product_changed` (the product may be identical) — it is its own
  // meaning, and the one a win-back campaign needs in order to stop
  // targeting a subscriber who has already come back.
  "subscription.offer_redeemed",
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

/**
 * Prefix shared by every revenue key in ROVENUE_EVENT_KEYS.
 *
 * Exported because "is this a revenue key?" is asked in ~15 places across the
 * api provider mappers, the chat-message builder and the events route — each
 * of which used to spell the `"revenue."` literal itself. One const so a
 * rename of the namespace is a compile error, not a silent behavior change.
 */
export const REVENUE_EVENT_KEY_PREFIX = "revenue.";

/** The revenue.* keys, in catalog order — derived from ROVENUE_EVENT_KEYS so
 *  a new revenue kind cannot be added to one list and forgotten in the other. */
export const REVENUE_EVENT_KEYS: readonly RovenueEventKey[] =
  ROVENUE_EVENT_KEYS.filter((key) => key.startsWith(REVENUE_EVENT_KEY_PREFIX));

/**
 * The subscription-lifecycle keys the outbox SUBSCRIPTION bridge publishes on
 * `rovenue.subscription`: two with dedicated producers (scheduled-actions /
 * expiry-checker) and the rest normalized from store-native signals via
 * STORE_EVENT_TO_PUBLIC_KEY. The fan-out consumer's subscription envelope
 * builder accepts exactly these.
 *
 * Adding a key here widens STANDARD_PROVIDER_EVENT_KEYS, so every standard
 * provider immediately ADVERTISES it — while its `DEFAULT_EVENT_MAPPING`
 * table is a `Partial<Record>` and will happily have no entry, silently
 * dropping the event. apps/api's event-mapping.catalog-coverage.test.ts is
 * the guard: a new key here must be named in every provider's table (or
 * declared as a deliberate omission there) or that test fails.
 */
export const SUBSCRIPTION_BRIDGE_EVENT_KEYS = [
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
  "subscription.paused",
  "subscription.recovered",
  "subscription.revoked",
  // Apple OFFER_REDEEMED (2026-09-03) — see ROVENUE_EVENT_KEYS above for
  // why this is its own meaning rather than `uncancelled`.
  "subscription.offer_redeemed",
] as const satisfies readonly RovenueEventKey[];

/** The one lifecycle key that does NOT come from the SUBSCRIPTION bridge —
 *  it has its own producer and rides the revenue topic. */
export const TRIAL_STARTED_EVENT_KEY = "subscription.trial.started" as const;

// ---------------------------------------------------------------------------
// `subscription.product_changed` — the two-phase contract
// ---------------------------------------------------------------------------
//
// This key has TWO producers, and one real-world plan change can legitimately
// deliver it TWICE. That is deliberate, and consumers must be able to tell the
// deliveries apart — so the payload carries `phase`:
//
//   * NO `phase` field  → ANNOUNCEMENT. Written by the outbox bridge
//     (webhook-processor.ts) from STORE_EVENT_TO_PUBLIC_KEY, keyed on the
//     store event type alone: Apple DID_CHANGE_RENEWAL_PREF, Google
//     SUBSCRIPTION_DEFERRED, Google SUBSCRIPTION_PRICE_CHANGE_CONFIRMED. It
//     means "the store says a change is coming". The product may not have
//     moved at all (a price change on the same product is one of these), and
//     for a scheduled downgrade it will not move for weeks. Payload carries
//     `storeEventType` and `webhookEventId`.
//
//   * `phase: "effective"` → the change HAS TAKEN EFFECT. Written by
//     `emitProductChanged` (apps/api/src/services/subscription-plan-change.ts)
//     from inside the guarded purchase write's transaction, only when the
//     product on the purchase actually moved. Payload carries
//     `previousProductId`, `productId` and `changeType`.
//
// Google's DEFERRED flow is the case that genuinely produces both: an
// announcement at deferral, then an effective row at the renewal that applies
// it. They are separate outbox rows with distinct ids, so `outboxEventId`
// dedup does NOT collapse them and a consumer receives both. Billing-state
// consumers should act on `phase: "effective"`; "your plan changes on the
// 14th" notifications want the announcement.
//
// A missing `phase` is the announcement rather than "unknown": the bridge
// predates this field and is never retrofitted, so absence is meaningful and
// stable. Check `payload.phase === PRODUCT_CHANGE_PHASE_EFFECTIVE`, never
// truthiness of the other fields.
export const PRODUCT_CHANGE_PHASE_EFFECTIVE = "effective" as const;

export type ProductChangePhase = typeof PRODUCT_CHANGE_PHASE_EFFECTIVE;

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
 * The 13-key revenue + subscription-lifecycle catalog that every
 * analytics / attribution / lifecycle provider offers — Wave-1's AMPLITUDE,
 * MIXPANEL, APPSFLYER, ADJUST, FIREBASE_GA4 plus Wave-2's BRAZE, ONESIGNAL,
 * ITERABLE, AIRBRIDGE, SINGULAR — and the drawer's event picker renders for
 * them. It is deliberately NOT the full ROVENUE_EVENT_KEYS:
 * `subscriber.identified`, `paywall.*` and `credit.ledger.appended` have no
 * mapping in those providers. Only the catch-all / general-purpose
 * notification providers (CUSTOM_WEBHOOK, SLACK, DISCORD) offer the complete
 * set.
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
  | "ITERABLE"
  // Wave-2 Task 7 — attribution-category provider (category already exists
  // since Wave-1's APPSFLYER/ADJUST).
  | "AIRBRIDGE"
  // Wave-2 Task 8 — second attribution-category provider added this wave.
  | "SINGULAR"
  // Wave-2 Task 9 — second communication-category provider (category
  // already exists since Wave-1's SLACK); last provider of Wave 2.
  | "DISCORD";

export const WEBHOOK_API_VERSION = "2026-08-24";

export type IntegrationDeliveryStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "dead_letter";
