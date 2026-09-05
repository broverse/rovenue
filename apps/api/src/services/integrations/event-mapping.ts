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
  // Task 9 (2026-09-04): AMPLITUDE/MIXPANEL/ONESIGNAL have no reserved
  // vocabulary at all (same as every other key in this table), so these
  // are free-form snake_case names in the same style as their neighbours —
  // not a vendor citation, since there is no vendor vocabulary to cite.
  "revenue.NON_RENEWING_PURCHASE": "non_renewing_purchase",
  "revenue.REACTIVATION": "reactivation",
  "revenue.REFUND": "refund",
  "revenue.CANCELLATION": "cancellation",
  "subscription.trial.started": "trial_started",
  "subscription.cancel_requested": "cancel_requested",
  "subscription.expired": "subscription_expired",
  "subscription.billing_issue": "billing_issue",
  "subscription.grace_period": "grace_period",
  "subscription.uncancelled": "uncancelled",
  "subscription.product_changed": "product_changed",
  "subscription.paused": "paused",
  "subscription.recovered": "recovered",
  "subscription.revoked": "revoked",
  "subscription.offer_redeemed": "offer_redeemed",
};

// ---------------------------------------------------------------------------
// Rovenue-namespaced custom event names — ONE helper for every vendor that
// needs a name for a key its own vocabulary has no equivalent for.
//
// FIREBASE_GA4, BRAZE, ITERABLE and AIRBRIDGE independently landed on the
// identical `rovenue_<key with dots as underscores>` transform and each kept
// a byte-identical private copy of it; they now share this one. BRAZE also
// reuses it at the provider layer (providers/braze.ts) for the revenue keys
// it cannot honestly send as a purchase.
//
// SINGULAR deliberately does NOT use this and keeps its own hand-written,
// shorter table (SINGULAR_LIFECYCLE_EVENT_NAMES below): Singular's EVENT
// Endpoint Reference caps the event name `n` at 32 ASCII characters and
// `rovenue_subscription_product_changed` is 36 — a real vendor constraint,
// not a missed de-duplication.
// ---------------------------------------------------------------------------

/** Prefix that marks a vendor-side event name as Rovenue-originated. */
export const ROVENUE_CUSTOM_EVENT_PREFIX = "rovenue_";

/** "subscription.trial.started" -> "rovenue_subscription_trial_started". */
export function rovenueCustomEventName(key: RovenueEventKey): string {
  return `${ROVENUE_CUSTOM_EVENT_PREFIX}${key.replace(/\./g, "_")}`;
}

// GA4 custom event names must match `^[A-Za-z]\w*$`, so unlike
// AMPLITUDE/MIXPANEL/APPSFLYER these are not free-form vendor names: the
// revenue keys collapse onto GA4's own recommended `purchase`/`refund`
// events, and every subscription.* key derives as a namespaced custom name
// via `rovenueCustomEventName` (GA4 has no standard subscription-lifecycle
// vocabulary at all).
const GA4_PURCHASE_EVENT = "purchase";
const GA4_REFUND_EVENT = "refund";
const GA4_CANCELLATION_EVENT = `${ROVENUE_CUSTOM_EVENT_PREFIX}cancellation`;

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
// FIREBASE_GA4 — both through the shared `rovenueCustomEventName` above.
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
// custom-category convention BRAZE/GA4/ITERABLE already use, through the
// shared `rovenueCustomEventName` helper above.
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
// their shared `rovenueCustomEventName` helper (its output keeps the literal
// word "subscription" from the key):
// Singular's EVENT Endpoint Reference caps `n` (event name) at "Maximum 32
// ASCII characters", and several of those derivations blow past it —
// `rovenue_subscription_product_changed` alone is 36 characters. SINGULAR
// gets its own short, hand-picked table below (drops the redundant
// "subscription" word) instead, verified to stay under the limit by a
// dedicated static-config test in singular.test.ts.
const SINGULAR_CANCELLATION_EVENT = "rovenue_cancellation";
// revenue.REACTIVATION (Task 9, 2026-09-04) — Singular's FULL standard-event
// list (see the SINGULAR header comment above) has no reactivation/win-back
// event, so this follows SINGULAR_CANCELLATION_EVENT's precedent: a
// Rovenue-namespaced custom name rather than `rovenueCustomEventName`'s
// output ("rovenue_revenue_REACTIVATION", 28 chars — actually under the cap
// here too, but the double "revenue" reads oddly and this stays consistent
// with the hand-picked table's shorter, "subscription"-word-dropping
// style). 20 chars, comfortably inside the 32-ASCII `n` cap.
const SINGULAR_REACTIVATION_EVENT = "rovenue_reactivation";
const SINGULAR_LIFECYCLE_EVENT_NAMES: Readonly<
  Record<(typeof SUBSCRIPTION_BRIDGE_EVENT_KEYS)[number], string>
> = {
  "subscription.cancel_requested": "rovenue_cancel_requested",
  "subscription.expired": "rovenue_expired",
  "subscription.billing_issue": "rovenue_billing_issue",
  "subscription.grace_period": "rovenue_grace_period",
  "subscription.uncancelled": "rovenue_uncancelled",
  "subscription.product_changed": "rovenue_product_changed",
  "subscription.paused": "rovenue_paused",
  "subscription.recovered": "rovenue_recovered",
  "subscription.revoked": "rovenue_revoked",
  // 21 chars — comfortably inside Singular's 32-ASCII `n` cap, unlike
  // `rovenueCustomEventName`'s "rovenue_subscription_offer_redeemed" (35).
  "subscription.offer_redeemed": "rovenue_offer_redeemed",
};

// ---------------------------------------------------------------------------
// Task 9 (2026-09-04) — publishing revenue.NON_RENEWING_PURCHASE and
// revenue.REACTIVATION as public event keys. Every (provider, key) pair
// below got a real decision; this block is the citation trail for the ones
// not already covered by an inline comment at the table entry itself.
// ---------------------------------------------------------------------------
//
// META_CAPI / TIKTOK_EVENTS — revenue.NON_RENEWING_PURCHASE maps to their
// purchase-shaped event, NOT "Subscribe": Meta's own Standard Events
// reference (developers.facebook.com/docs/meta-pixel/reference, fetched
// 2026-09-05) describes `Purchase` as "When a purchase is made or checkout
// flow is completed" — genuinely purchase-shaped, distinct from `Subscribe`
// ("applies to start a paid subscription"). TikTok's own Events API uses a
// separate app-events vocabulary from its web-pixel Standard Events page
// (ads.tiktok.com/help/article/standard-events-parameters, fetched
// 2026-09-05, lists only the web-pixel set and does not include
// `CompletePayment`/`Subscribe`/`StartTrial` at all); `CompletePayment` is
// TikTok's own documented (now-legacy, aliased to `Purchase`, but still
// live through 2027) app purchase event and is reused here for consistency
// with the CREDIT_PURCHASE entry already in this same table, rather than
// introducing a second one-time-purchase name. revenue.REACTIVATION is
// NOT added to either provider: both hand-pick a narrow `eventCatalog`
// (meta-capi.ts / tiktok-events.ts) that never advertises subscription-
// lifecycle-shaped signals, and a lifecycle event masquerading as a
// conversion would corrupt ad-platform optimization — so this is not a
// declared omission (an omission is for a key the provider DOES advertise;
// see event-mapping.catalog-coverage.test.ts), it is simply not offered.
//
// APPSFLYER — verified against AppsFlyer's own iOS SDK reference
// (dev.appsflyer.com/hc/docs/in-app-events-ios, fetched 2026-09-05; the
// Zendesk-hosted support.appsflyer.com overview 403'd every direct fetch
// from this environment, the same bot-wall shape AIRBRIDGE's/SINGULAR's
// sourcing notes describe, so the dev-portal SDK reference — a first-party
// AppsFlyer property — was used instead). Its full predefined-event-name
// table has no distinct "non-renewing purchase" event: `af_purchase` is
// the vendor's own sole standard Purchase event (its own docs note
// `validateReceipt` auto-generates `af_purchase` for a validated IAP), so
// it is reused rather than left unmapped — this is safe against the same
// invariant the ad platforms are held to, because `af_purchase` is
// AppsFlyer's Purchase-shaped event, not its `af_subscribe`. For
// revenue.REACTIVATION, the one name that LOOKS close — `af_re_engage`
// — is documented purely as a re-engagement-CAMPAIGN-attribution event
// (fired when a user returns via a retargeting ad click), a different
// concept from a subscriber's billing state resuming; reusing it would
// misattribute reactivation revenue as ad-driven re-engagement and could
// corrupt AppsFlyer's own re-engagement campaign reporting. No genuine
// vendor event exists for this meaning, so — breaking from this table's
// own af_-prefixed convention on purpose, to avoid presenting a
// Rovenue-invented name as if AppsFlyer defined it — it gets the same
// Rovenue-namespaced custom-event convention FIREBASE_GA4/BRAZE/ITERABLE/
// AIRBRIDGE use below via `rovenueCustomEventName`.
//
// FIREBASE_GA4 — revenue.NON_RENEWING_PURCHASE reuses GA4_PURCHASE_EVENT
// ("purchase", Google's own recommended ecommerce event, already the
// vendor name for every other revenue.* key in this table): a one-time IAP
// or Stripe package is exactly the transaction GA4's `purchase` event
// models. revenue.REACTIVATION has no GA4 recommended-event equivalent, so
// it takes the same `rovenueCustomEventName` namespaced-custom-event path
// every subscription-lifecycle key already does here.
//
// BRAZE / ITERABLE — both revenue keys ride the SAME generic revenue-key
// path their existing revenue.* entries do (see each provider's mapEvent:
// BRAZE's `isRevenue` branch onto `purchases`, ITERABLE's `isRevenue`
// branch onto `commerce/trackPurchase`), so no new vendor lookup applies —
// this is a structural, not a vendor-name, decision. BRAZE maps both new
// keys to themselves (identity — the value is only ever read back as a
// tag, never sent as a Braze event name, per the existing BRAZE header
// comment). ITERABLE reuses ANALYTICS_DEFAULT_EVENT_NAMES's free-form
// names for both, the same choice already made for its other revenue.*
// entries (INITIAL/RENEWAL/CREDIT_PURCHASE/CANCELLATION).
//
// AIRBRIDGE — revenue.NON_RENEWING_PURCHASE joins RENEWAL/CREDIT_PURCHASE
// on "airbridge.ecommerce.order.completed": the AIRBRIDGE header comment's
// own rationale for that event ("a repeat charge or one-time IAP is a
// completed order, not a new subscribe action") already describes a
// non-renewing one-time purchase, verbatim, so this is the same decision,
// not a new one. revenue.REACTIVATION has no standard Airbridge event
// (its full standard-events table, cited above, covers only the 7 keys
// enumerated in that comment) — since AIRBRIDGE's `eventCatalog` is
// STANDARD_PROVIDER_EVENT_KEYS wholesale, it WILL advertise this key, so
// leaving it unmapped is not an option; it takes the `rovenueCustomEventName`
// path.
//
// SINGULAR — revenue.NON_RENEWING_PURCHASE joins RENEWAL/CREDIT_PURCHASE on
// "sng_ecommerce_purchase" for the identical reason (Singular's own doc
// note: "User makes a purchase/order... other names... order success,
// order confirmed, or payment success" — a one-time IAP fits this
// unchanged). revenue.REACTIVATION gets SINGULAR_REACTIVATION_EVENT (see
// its definition above) rather than `rovenueCustomEventName`'s output,
// verified against the 32-ASCII cap by the same static-config test in
// singular.test.ts that already pins every other entry here.
//
// SLACK / DISCORD — NOT hand-edited: both tables are
// `Object.fromEntries(ROVENUE_EVENT_KEYS.map(...))` below, so adding a key
// to ROVENUE_EVENT_KEYS (@rovenue/shared) is the only change either needs;
// confirmed by event-mapping.catalog-coverage.test.ts and
// integrations.test.ts rather than asserted here.
//
// ADJUST / CUSTOM_WEBHOOK — no table entry for either key, by the same
// standing rule as every other key: ADJUST has no vendor-wide token
// vocabulary to default to (IDENTITY_MAPPED_PROVIDERS in the coverage
// test), and CUSTOM_WEBHOOK passes the Rovenue key through verbatim.

export const DEFAULT_EVENT_MAPPING: Readonly<
  Record<IntegrationProviderId, Readonly<Partial<Record<RovenueEventKey, string>>>>
> = {
  META_CAPI: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Purchase",
    "revenue.CREDIT_PURCHASE": "Purchase",
    // Task 9 (2026-09-04): purchase-shaped, NOT "Subscribe" — see the
    // Task 9 citation block above. Also added to meta-capi.ts's
    // eventCatalog (and step-events.tsx's mirror), since this provider's
    // catalog is hand-picked rather than derived from
    // STANDARD_PROVIDER_EVENT_KEYS. revenue.REACTIVATION is deliberately
    // NOT added anywhere for this provider — see the citation block.
    "revenue.NON_RENEWING_PURCHASE": "Purchase",
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
    // Task 9 (2026-09-04): reuses CREDIT_PURCHASE's own "CompletePayment"
    // (purchase-shaped, not "Subscribe") — see the Task 9 citation block
    // above. Also added to tiktok-events.ts's eventCatalog (and
    // step-events.tsx's mirror). revenue.REACTIVATION deliberately NOT
    // added anywhere for this provider — see the citation block.
    "revenue.NON_RENEWING_PURCHASE": "CompletePayment",
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
    // Task 9 (2026-09-04): reuses AppsFlyer's own sole standard Purchase
    // event (already INITIAL's name here) — no distinct non-renewing
    // event is documented; see the Task 9 citation block above.
    "revenue.NON_RENEWING_PURCHASE": "af_purchase",
    // Task 9 (2026-09-04): NOT af_-prefixed — see the Task 9 citation
    // block above for why `af_re_engage` is the wrong vendor event here.
    "revenue.REACTIVATION": rovenueCustomEventName("revenue.REACTIVATION"),
    "revenue.REFUND": "af_refund",
    "revenue.CANCELLATION": "af_cancel",
    "subscription.trial.started": "af_start_trial",
    "subscription.cancel_requested": "af_cancel_requested",
    "subscription.expired": "af_subscription_expired",
    "subscription.billing_issue": "af_billing_issue",
    "subscription.grace_period": "af_grace_period",
    "subscription.uncancelled": "af_uncancel",
    "subscription.product_changed": "af_product_change",
    "subscription.paused": "af_paused",
    "subscription.recovered": "af_recovered",
    "subscription.revoked": "af_revoked",
    "subscription.offer_redeemed": "af_offer_redeemed",
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
    // Task 9 (2026-09-04): reuses GA4's own recommended `purchase` event —
    // see the Task 9 citation block above.
    "revenue.NON_RENEWING_PURCHASE": GA4_PURCHASE_EVENT,
    // Task 9 (2026-09-04): no GA4 recommended-event equivalent, so this
    // takes the same namespaced-custom-event path the lifecycle keys use.
    "revenue.REACTIVATION": rovenueCustomEventName("revenue.REACTIVATION"),
    "revenue.REFUND": GA4_REFUND_EVENT,
    "revenue.CANCELLATION": GA4_CANCELLATION_EVENT,
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, rovenueCustomEventName(key)]),
    ),
  },
  BRAZE: {
    "revenue.INITIAL": "revenue.INITIAL",
    "revenue.TRIAL_CONVERSION": "revenue.TRIAL_CONVERSION",
    "revenue.RENEWAL": "revenue.RENEWAL",
    "revenue.CREDIT_PURCHASE": "revenue.CREDIT_PURCHASE",
    // Task 9 (2026-09-04): identity, same as every other revenue.* key —
    // both ride the generic `isRevenue` branch in providers/braze.ts (see
    // the Task 9 citation block above).
    "revenue.NON_RENEWING_PURCHASE": "revenue.NON_RENEWING_PURCHASE",
    "revenue.REACTIVATION": "revenue.REACTIVATION",
    // revenue.REFUND: intentionally unmapped — see comment above.
    "revenue.CANCELLATION": "revenue.CANCELLATION",
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, rovenueCustomEventName(key)]),
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
  // a fallback item label or a tag), but subscription-lifecycle keys use the
  // shared `rovenue_<suffix>` derivation (`rovenueCustomEventName`)
  // rather than the free-form names, since Iterable's
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
    // Task 9 (2026-09-04): reuses ANALYTICS_DEFAULT_EVENT_NAMES's free-form
    // names, the same choice already made for every other revenue.* key
    // here (see the Task 9 citation block above).
    "revenue.NON_RENEWING_PURCHASE":
      ANALYTICS_DEFAULT_EVENT_NAMES["revenue.NON_RENEWING_PURCHASE"],
    "revenue.REACTIVATION": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.REACTIVATION"],
    // revenue.REFUND: intentionally unmapped — see comment above.
    "revenue.CANCELLATION": ANALYTICS_DEFAULT_EVENT_NAMES["revenue.CANCELLATION"],
    ...Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_KEYS.map((key) => [key, rovenueCustomEventName(key)]),
    ),
  },
  AIRBRIDGE: {
    "revenue.INITIAL": "airbridge.subscribe",
    "revenue.TRIAL_CONVERSION": "airbridge.subscribe",
    "revenue.RENEWAL": "airbridge.ecommerce.order.completed",
    "revenue.CREDIT_PURCHASE": "airbridge.ecommerce.order.completed",
    // Task 9 (2026-09-04): joins RENEWAL/CREDIT_PURCHASE — see the Task 9
    // citation block above.
    "revenue.NON_RENEWING_PURCHASE": "airbridge.ecommerce.order.completed",
    // Task 9 (2026-09-04): no standard Airbridge event; namespaced custom
    // event, same as the lifecycle keys below — see the Task 9 citation
    // block above.
    "revenue.REACTIVATION": rovenueCustomEventName("revenue.REACTIVATION"),
    // revenue.REFUND: MAPPED (unlike BRAZE/ITERABLE) — see the AIRBRIDGE
    // header comment above for the full citation/rationale.
    "revenue.REFUND": "airbridge.ecommerce.order.canceled",
    "revenue.CANCELLATION": "airbridge.unsubscribe",
    "subscription.trial.started": "airbridge.startTrial",
    ...Object.fromEntries(
      SUBSCRIPTION_BRIDGE_EVENT_KEYS.map((key) => [key, rovenueCustomEventName(key)]),
    ),
  },
  SINGULAR: {
    "revenue.INITIAL": "sng_subscribe",
    "revenue.TRIAL_CONVERSION": "sng_subscribe",
    "revenue.RENEWAL": "sng_ecommerce_purchase",
    "revenue.CREDIT_PURCHASE": "sng_ecommerce_purchase",
    // Task 9 (2026-09-04): joins RENEWAL/CREDIT_PURCHASE — see the Task 9
    // citation block above.
    "revenue.NON_RENEWING_PURCHASE": "sng_ecommerce_purchase",
    // Task 9 (2026-09-04): see SINGULAR_REACTIVATION_EVENT's definition
    // above (32-ASCII cap, pinned by singular.test.ts's static-config test).
    "revenue.REACTIVATION": SINGULAR_REACTIVATION_EVENT,
    // revenue.REFUND: intentionally unmapped — see the SINGULAR header
    // comment above for the full citation/rationale.
    "revenue.CANCELLATION": SINGULAR_CANCELLATION_EVENT,
    "subscription.trial.started": "sng_start_trial",
    ...SINGULAR_LIFECYCLE_EVENT_NAMES,
  },
  // DISCORD (Wave-2 Task 9) — same shape as SLACK: every one of the 17
  // public event keys maps to itself. Discord has no vendor-specific
  // event-name vocabulary either (identical rationale to SLACK's entry
  // above) — `providerEvent` is only ever used as a human-readable label,
  // derived from the shared ROVENUE_EVENT_KEYS const rather than hand-typed
  // a second time.
  DISCORD: Object.fromEntries(
    ROVENUE_EVENT_KEYS.map((key) => [key, key]),
  ) as Partial<Record<RovenueEventKey, string>>,
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
