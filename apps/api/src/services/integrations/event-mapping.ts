import type { RovenueEventKey, IntegrationProviderId } from "@rovenue/shared";
import {
  ROVENUE_EVENT_KEYS,
  SUBSCRIPTION_LIFECYCLE_KEYS,
  SUBSCRIPTION_BRIDGE_EVENT_KEYS,
} from "@rovenue/shared";
import type { RovenueEventEnvelope } from "./types";

// ---------------------------------------------------------------------------
// deriveRevenueEventKey — shared revenue-kind → eventKey derivation.
// Meta CAPI / TikTok Events / CUSTOM_WEBHOOK all fold a revenue envelope's
// `revenueEventKind` into the same `revenue.${kind}` public event key; keep
// that one mapping in one place instead of re-deriving it per provider.
// ---------------------------------------------------------------------------
export function deriveRevenueEventKey(
  envelope: Pick<RovenueEventEnvelope, "eventType" | "revenueEventKind">,
): RovenueEventKey | undefined {
  if (
    envelope.eventType === "revenue.event.recorded" &&
    envelope.revenueEventKind
  ) {
    return `revenue.${envelope.revenueEventKind}` as RovenueEventKey;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Vendor event names that are DERIVED rather than spelled out
// ---------------------------------------------------------------------------

// AMPLITUDE and MIXPANEL use identical names: neither vendor has a
// reserved/standard vocabulary for these, so the same free-form snake_case
// names are used as consistent defaults across both analytics providers
// (Task 6 brief: "Topics/catalog/mapping keys identical to Amplitude").
// One object, referenced twice — not two hand-synced copies.
const ANALYTICS_DEFAULT_EVENT_NAMES: Partial<Record<RovenueEventKey, string>> = {
  "revenue.INITIAL": "purchase_initial",
  "revenue.TRIAL_CONVERSION": "trial_conversion",
  "revenue.RENEWAL": "renewal",
  "revenue.CREDIT_PURCHASE": "credit_purchase",
  "revenue.REFUND": "refund",
  "revenue.CANCELLATION": "cancellation",
  "subscription.trial.started": "trial_started",
  "subscription.cancel_requested": "cancel_requested",
  "subscription.expired": "subscription_expired",
  "subscription.billing_issue": "billing_issue",
  "subscription.grace_period": "grace_period",
  "subscription.uncancelled": "uncancelled",
  "subscription.product_changed": "product_changed",
};

// GA4 custom event names must match `^[A-Za-z]\w*$`, so unlike
// AMPLITUDE/MIXPANEL/APPSFLYER these are not free-form vendor names: the
// revenue keys collapse onto GA4's own recommended `purchase`/`refund`
// events, and every subscription.* key derives as a namespaced custom name
// (GA4 has no standard subscription-lifecycle vocabulary at all).
const GA4_PURCHASE_EVENT = "purchase";
const GA4_REFUND_EVENT = "refund";
const GA4_CANCELLATION_EVENT = "rovenue_cancellation";
const GA4_CUSTOM_EVENT_PREFIX = "rovenue_";

/** "subscription.trial.started" -> "rovenue_subscription_trial_started". */
function ga4SubscriptionEventName(key: RovenueEventKey): string {
  return `${GA4_CUSTOM_EVENT_PREFIX}${key.replace(/\./g, "_")}`;
}

// BRAZE — the first LIFECYCLE-category provider (Wave-2 Task 4). Its
// `revenue.*` keys don't need a Braze-side event NAME at all: they ride
// Braze's dedicated `users/track` `purchases` array (keyed by `product_id`,
// not an event name — see providers/braze.ts), and the value mapped here is
// only read back as the `properties.rovenue_event` tag stamped onto that
// purchase entry. Each revenue key therefore maps to ITSELF, an identity
// map exactly like SLACK's below — `providerEvent` is a label, not a wire
// event name, for this provider's revenue keys. Lifecycle keys have no
// Braze-native equivalent, so each becomes a Rovenue-namespaced Braze
// custom event via `events`, the same `rovenue_<suffix>` convention as
// FIREBASE_GA4's `ga4SubscriptionEventName`.
//
// `revenue.REFUND` is intentionally OMITTED — the fallback ruling from the
// Task 4 controller context: Braze's users/track / purchase-object
// reference (https://www.braze.com/docs/api/endpoints/user_data/
// post_user_track/ and .../objects_filters/purchase_object/, fetched
// 2026-08-25) documents `purchases` as an append-only revenue record
// (required `product_id`/`currency`/`price`/`time`, no reversal or
// negative-price refund convention anywhere in the schema) — forwarding a
// REFUND through `purchases` would double-count revenue in Braze's own
// reporting rather than reverse it. Falls through to `no_mapping`/skip.
const BRAZE_LIFECYCLE_EVENT_PREFIX = "rovenue_";
function brazeLifecycleEventName(key: RovenueEventKey): string {
  return `${BRAZE_LIFECYCLE_EVENT_PREFIX}${key.replace(/\./g, "_")}`;
}

// INTENTIONAL OMISSION — `revenue.REFUND` and `revenue.CANCELLATION` are
// deliberately NOT mapped for either provider. Meta CAPI and TikTok Events
// API have no standard refund/cancellation conversion event; forwarding them
// as a conversion would corrupt the ad platforms' optimization and reported
// ROAS. They therefore resolve to `{ kind: "skip", reason: "no_mapping" }`,
// which is the desired behavior — not a gap. Refund handling on ad platforms
// (e.g. value-based deletion of a prior Purchase) is a separate, provider-
// specific feature, not a default conversion mapping.
// AIRBRIDGE (Wave-2 Task 7) — vendor category names verified against
// Airbridge's own first-party docs (help.airbridge.io/en/guides/
// airbridge-event-types, fetched 2026-08-25; the developers.airbridge.io
// portal itself is a JS-rendered SPA shell that returns no content to a
// plain fetch, so help.airbridge.io — the same content, server-rendered —
// was used instead, corroborated by help.airbridge.io/en/references/
// s2s-event's own request/response examples for the wire shape). Airbridge's
// standard e-commerce/subscription vocabulary covers 6 of the 13 keys with a
// real vendor event name; the remaining 6 subscription-lifecycle keys (Wave-1
// narrow store-lifecycle normalization — cancel_requested/expired/
// billing_issue/grace_period/uncancelled/product_changed) have no Airbridge
// equivalent, so they get the same Rovenue-namespaced `rovenue_<suffix>`
// custom-category convention BRAZE/GA4/ITERABLE already use (own local copy
// of the string transform, matching BRAZE's pattern rather than importing
// GA4's helper).
//
// revenue.INITIAL / revenue.TRIAL_CONVERSION -> "airbridge.subscribe" — both
// are "a paid subscription just started" moments (first purchase, or a
// trial converting to paid), mirroring META_CAPI/TIKTOK_EVENTS' identical
// choice to map both keys to their platforms' "Subscribe" event above.
// revenue.RENEWAL / revenue.CREDIT_PURCHASE -> "airbridge.ecommerce.
// order.completed" — a repeat charge or one-time IAP is a completed order,
// not a new "subscribe" action; same INITIAL-vs-repeat split META_CAPI makes
// (RENEWAL/CREDIT_PURCHASE -> "Purchase" there).
//
// revenue.REFUND -> "airbridge.ecommerce.order.canceled" — UNLIKE BRAZE/
// ITERABLE (which drop REFUND because their vendor docs document no reversal
// convention at all), Airbridge's own standard-events table documents a
// dedicated "Order Cancel" event alongside "Order Complete". Its guide
// frames the example around pre-fulfillment cart cancellation rather than a
// post-purchase refund specifically, so this is not a perfect semantic
// match — but it is the vendor's own, only standard event for reversing a
// completed order's revenue, and mapping it prevents a refunded purchase
// from staying permanently double-counted in Airbridge's own LTV/ROAS
// rollups (which silently dropping REFUND, as BRAZE/ITERABLE do, would
// cause). revenue.CANCELLATION -> "airbridge.unsubscribe" — a clean,
// documented match for "this subscriber's subscription ended".
//
// subscription.trial.started -> "airbridge.startTrial" — exact documented
// vendor match.
const AIRBRIDGE_LIFECYCLE_EVENT_PREFIX = "rovenue_";
function airbridgeLifecycleEventName(key: RovenueEventKey): string {
  return `${AIRBRIDGE_LIFECYCLE_EVENT_PREFIX}${key.replace(/\./g, "_")}`;
}

// SINGULAR (Wave-2 Task 8) — vendor vocabulary verified against Singular's
// own first-party support docs (support.singular.net/hc/en-us/articles/
// 7648172966299 "Singular Standard Events: Full List", fetched 2026-08-25
// via a plain-text reader proxy after support.singular.net's own Zendesk
// front door 403'd every direct fetch attempt from this environment — same
// bot-wall shape AIRBRIDGE's/APPSFLYER's sourcing notes describe; the
// reader-proxied content matches the vendor's documented title/canonical
// URL exactly, so this is still first-party evidence, just retrieved
// through a mirror). Singular's FULL standard-event list has only three
// subscription-shaped events: sng_subscribe, sng_start_trial,
// sng_ecommerce_purchase — no standard cancellation/refund/renewal event
// exists at all (the only cancellation-adjacent idea, "Order Canceled", is
// listed as a freeform, non-standard "Custom Event" suggestion with no
// reserved name and no documented reversal/negative-amount semantics — the
// same absence of a convention BRAZE/ITERABLE found for their own vendors).
//
// revenue.INITIAL / revenue.TRIAL_CONVERSION -> "sng_subscribe" — both are
// "a paid subscription just started" (mirrors META_CAPI/TIKTOK_EVENTS/
// AIRBRIDGE's identical INITIAL+TRIAL_CONVERSION -> Subscribe choice).
// revenue.RENEWAL / revenue.CREDIT_PURCHASE -> "sng_ecommerce_purchase" —
// Singular's own doc note reads "User makes a purchase/order... Other names
// for this event are order success, order confirmed, or payment success",
// which covers a repeat charge or a one-time IAP equally well; no dedicated
// "renewal" standard event exists.
// revenue.REFUND -> intentionally UNMAPPED — no standard reversal event and
// no amt-sign convention anywhere in the EVENT Endpoint Reference (`amt`'s
// own docs never mention negative values); this follows BRAZE/ITERABLE's
// drop-with-citation precedent, not AIRBRIDGE's map-with-citation one —
// Airbridge had a real, dedicated "Order Cancel" *standard* event; Singular's
// closest analog is a non-standard, freeform suggestion with no semantics
// defined anywhere.
// revenue.CANCELLATION -> no standard match either (same absence) — sent as
// a Rovenue-namespaced custom event (SINGULAR_CANCELLATION_EVENT below),
// the same convention as GA4_CANCELLATION_EVENT, rather than reusing the
// vendor's own ambiguous, e-commerce-flavored "Order Canceled" suggestion.
// subscription.trial.started -> "sng_start_trial" — exact documented match.
//
// The six SUBSCRIPTION_BRIDGE_EVENT_KEYS (cancel_requested/expired/
// billing_issue/grace_period/uncancelled/product_changed) have no Singular
// equivalent, so — like BRAZE/GA4/AIRBRIDGE — they get a Rovenue-namespaced
// `rovenue_<suffix>` custom event name. UNLIKE those three, this can't reuse
// their shared `rovenue_subscription_<key>`-shaped helper
// (ga4SubscriptionEventName/brazeLifecycleEventName/
// airbridgeLifecycleEventName all include the literal word "subscription"):
// Singular's EVENT Endpoint Reference caps `n` (event name) at "Maximum 32
// ASCII characters", and several of those derivations blow past it —
// `rovenue_subscription_product_changed` alone is 36 characters. SINGULAR
// gets its own short, hand-picked table below (drops the redundant
// "subscription" word) instead, verified to stay under the limit by a
// dedicated static-config test in singular.test.ts.
const SINGULAR_CANCELLATION_EVENT = "rovenue_cancellation";
const SINGULAR_LIFECYCLE_EVENT_NAMES: Readonly<
  Record<(typeof SUBSCRIPTION_BRIDGE_EVENT_KEYS)[number], string>
> = {
  "subscription.cancel_requested": "rovenue_cancel_requested",
  "subscription.expired": "rovenue_expired",
  "subscription.billing_issue": "rovenue_billing_issue",
  "subscription.grace_period": "rovenue_grace_period",
  "subscription.uncancelled": "rovenue_uncancelled",
  "subscription.product_changed": "rovenue_product_changed",
};

export const DEFAULT_EVENT_MAPPING: Readonly<
  Record<IntegrationProviderId, Readonly<Partial<Record<RovenueEventKey, string>>>>
> = {
  META_CAPI: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Purchase",
    "revenue.CREDIT_PURCHASE": "Purchase",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
    // revenue.REFUND / revenue.CANCELLATION: intentionally unmapped (see above).
    // v2 additions: not mapped to Meta CAPI events (provider-specific, Task 7+).
  },
  TIKTOK_EVENTS: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Subscribe",
    "revenue.CREDIT_PURCHASE": "CompletePayment",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
    // revenue.REFUND / revenue.CANCELLATION: intentionally unmapped (see above).
    // v2 additions: not mapped to TikTok Events API events (provider-specific, Task 7+).
  },
  CUSTOM_WEBHOOK: {
    // CUSTOM_WEBHOOK has no default event mappings; user configures all via dashboard.
  },
  AMPLITUDE: ANALYTICS_DEFAULT_EVENT_NAMES,
  MIXPANEL: ANALYTICS_DEFAULT_EVENT_NAMES,
  // AppsFlyer's `af_`-prefixed names are its own documented
  // in-app-event vocabulary (unlike AMPLITUDE/MIXPANEL's free-form names).
  APPSFLYER: {
    "revenue.INITIAL": "af_purchase",
    "revenue.TRIAL_CONVERSION": "af_subscribe",
    "revenue.RENEWAL": "af_subscription_renewal",
    "revenue.CREDIT_PURCHASE": "af_credit_purchase",
    "revenue.REFUND": "af_refund",
    "revenue.CANCELLATION": "af_cancel",
    "subscription.trial.started": "af_start_trial",
    "subscription.cancel_requested": "af_cancel_requested",
    "subscription.expired": "af_subscription_expired",
    "subscription.billing_issue": "af_billing_issue",
    "subscription.grace_period": "af_grace_period",
    "subscription.uncancelled": "af_uncancel",
    "subscription.product_changed": "af_product_change",
  },
  // DELIBERATELY EMPTY — see providers/adjust.ts's "Default event mapping"
  // header comment for the full PRE-FLIGHT RULING rationale: Adjust event tokens
  // are opaque, account-specific ids with no vendor-wide vocabulary to
  // default to. `applyEventMapping` falls through to `no_mapping` for every
  // key here unless the connection's own `eventMapping` override supplies
  // a token.
  ADJUST: {},
  // SLACK — every one of the 17 public event keys maps to itself. Slack has
  // no vendor-specific event-name vocabulary (there is no "Subscribe" or
  // "purchase_initial" equivalent) — `providerEvent` is only ever used as a
  // human-readable label.
  SLACK: Object.fromEntries(
    ROVENUE_EVENT_KEYS.map((key) => [key, key]),
  ) as Partial<Record<RovenueEventKey, string>>,
  FIREBASE_GA4: {
    "revenue.INITIAL": GA4_PURCHASE_EVENT,
    "revenue.RENEWAL": GA4_PURCHASE_EVENT,
    "revenue.TRIAL_CONVERSION": GA4_PURCHASE_EVENT,
    "revenue.CREDIT_PURCHASE": GA4_PURCHASE_EVENT,
    "revenue.REFUND": GA4_REFUND_EVENT,
    "revenue.CANCELLATION": GA4_CANCELLATION_EVENT,
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, ga4SubscriptionEventName(key)]),
    ),
  },
  BRAZE: {
    "revenue.INITIAL": "revenue.INITIAL",
    "revenue.TRIAL_CONVERSION": "revenue.TRIAL_CONVERSION",
    "revenue.RENEWAL": "revenue.RENEWAL",
    "revenue.CREDIT_PURCHASE": "revenue.CREDIT_PURCHASE",
    // revenue.REFUND: intentionally unmapped — see comment above.
    "revenue.CANCELLATION": "revenue.CANCELLATION",
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, brazeLifecycleEventName(key)]),
    ),
  },
  // ONESIGNAL (Wave-2 Task 5) — unlike BRAZE, OneSignal's custom_events API
  // has no structured purchase-object equivalent to forward revenue through
  // (see providers/onesignal.ts) — every one of the 13 keys, revenue.REFUND
  // included, becomes a plain custom event named via free-form vendor
  // vocabulary. OneSignal has no reserved event-name vocabulary of its own
  // (same as AMPLITUDE/MIXPANEL), so it reuses that identical default-name
  // table rather than re-typing 13 near-duplicate strings a third time.
  ONESIGNAL: ANALYTICS_DEFAULT_EVENT_NAMES,
  // ITERABLE (Wave-2 Task 6) — a mapping value is used TWO ways in
  // providers/iterable.ts, unlike every other table here: (1) as the
  // `eventName` sent to `events/track` for subscription-lifecycle keys, and
  // (2) as the fallback `items[].name` on a `commerce/trackPurchase` item
  // when the revenue envelope has no `productId` — so, unlike ONESIGNAL,
  // this is NOT a straight reuse of ANALYTICS_DEFAULT_EVENT_NAMES for every
  // key: revenue.* keys reuse its free-form names (they read fine as either
  // a fallback item label or a tag), but subscription-lifecycle keys reuse
  // FIREBASE_GA4's `rovenue_<suffix>` derivation (`ga4SubscriptionEventName`
  // — the function is GA4-named but its body is vendor-agnostic string
  // manipulation) rather than the free-form names, since Iterable's
  // events/track eventName is a real custom-event name that benefits from
  // the same unambiguous, Rovenue-namespaced convention Braze/GA4 already
  // use for lifecycle keys, and Iterable (like GA4) has "Allow new custom
  // events" project-level gating where a clearly-namespaced name matters.
  //
  // `revenue.REFUND` is intentionally OMITTED — see providers/iterable.ts's
  // "REFUND" comment: Iterable's trackPurchase reference documents no
  // negative-total/reversal convention, and RevenueCat's own Iterable
  // integration (a directly comparable subscription-revenue forwarder)
  // routes its "Cancellation" event through the Custom Events API rather
  // than trackPurchase and states plainly that "revenue for Iterable
  // campaign reporting will not be accurate due to refund events" — i.e.
  // even the vendor's own reference integration does not attempt a
  // trackPurchase reversal. Falls through to `no_mapping`/skip, the Braze
  // pattern.
  ITERABLE: {
    "revenue.INITIAL": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.INITIAL"],
    "revenue.TRIAL_CONVERSION": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.TRIAL_CONVERSION"],
    "revenue.RENEWAL": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.RENEWAL"],
    "revenue.CREDIT_PURCHASE": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.CREDIT_PURCHASE"],
    // revenue.REFUND: intentionally unmapped — see comment above.
    "revenue.CANCELLATION": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.CANCELLATION"],
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, ga4SubscriptionEventName(key)]),
    ),
  },
  AIRBRIDGE: {
    "revenue.INITIAL": "airbridge.subscribe",
    "revenue.TRIAL_CONVERSION": "airbridge.subscribe",
    "revenue.RENEWAL": "airbridge.ecommerce.order.completed",
    "revenue.CREDIT_PURCHASE": "airbridge.ecommerce.order.completed",
    // revenue.REFUND: MAPPED (unlike BRAZE/ITERABLE) — see the AIRBRIDGE
    // header comment above for the full citation/rationale.
    "revenue.REFUND": "airbridge.ecommerce.order.canceled",
    "revenue.CANCELLATION": "airbridge.unsubscribe",
    "subscription.trial.started": "airbridge.startTrial",
    ...Object.fromEntries(
      SUBSCRIPTION_BRIDGE_EVENT_KEYS.map((key) => [key, airbridgeLifecycleEventName(key)]),
    ),
  },
  SINGULAR: {
    "revenue.INITIAL": "sng_subscribe",
    "revenue.TRIAL_CONVERSION": "sng_subscribe",
    "revenue.RENEWAL": "sng_ecommerce_purchase",
    "revenue.CREDIT_PURCHASE": "sng_ecommerce_purchase",
    // revenue.REFUND: intentionally unmapped — see the SINGULAR header
    // comment above for the full citation/rationale.
    "revenue.CANCELLATION": SINGULAR_CANCELLATION_EVENT,
    "subscription.trial.started": "sng_start_trial",
    ...SINGULAR_LIFECYCLE_EVENT_NAMES,
  },
};

export type ApplyEventMappingInput = {
  providerId: IntegrationProviderId;
  eventKey: RovenueEventKey;
  enabledEvents: RovenueEventKey[];
  override: Record<string, { eventName?: string; skip?: true }>;
};

export type ApplyEventMappingResult =
  | { kind: "use"; providerEvent: string }
  | { kind: "skip"; reason: "no_mapping" | "filtered_by_event_scope" };

export function applyEventMapping(
  input: ApplyEventMappingInput,
): ApplyEventMappingResult {
  if (!input.enabledEvents.includes(input.eventKey)) {
    return { kind: "skip", reason: "filtered_by_event_scope" };
  }
  const ovRaw = input.override[input.eventKey];
  const ov = ovRaw && typeof ovRaw === "object" ? ovRaw : undefined;
  if (ov?.skip === true) {
    return { kind: "skip", reason: "no_mapping" };
  }
  const defaultName = DEFAULT_EVENT_MAPPING[input.providerId][input.eventKey];
  const providerEvent = ov?.eventName ?? defaultName;
  if (!providerEvent) {
    return { kind: "skip", reason: "no_mapping" };
  }
  return { kind: "use", providerEvent };
}
