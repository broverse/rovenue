import type { RovenueEventKey, IntegrationProviderId } from "@rovenue/shared";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";
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

// INTENTIONAL OMISSION — `revenue.REFUND` and `revenue.CANCELLATION` are
// deliberately NOT mapped for either provider. Meta CAPI and TikTok Events
// API have no standard refund/cancellation conversion event; forwarding them
// as a conversion would corrupt the ad platforms' optimization and reported
// ROAS. They therefore resolve to `{ kind: "skip", reason: "no_mapping" }`,
// which is the desired behavior — not a gap. Refund handling on ad platforms
// (e.g. value-based deletion of a prior Purchase) is a separate, provider-
// specific feature, not a default conversion mapping.
export const DEFAULT_EVENT_MAPPING: Record<
  IntegrationProviderId,
  Partial<Record<RovenueEventKey, string>>
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
  // Kept in sync with providers/amplitude.ts's own `defaultEventMapping`
  // export (which the dashboard drawer reads) — see that file for the
  // rationale behind each vendor event name.
  AMPLITUDE: {
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
  },
  // Identical vendor names to AMPLITUDE — kept in sync with
  // providers/mixpanel.ts's own `defaultEventMapping` export (which the
  // dashboard drawer reads). Task 6 brief: "Topics/catalog/mapping keys
  // identical to Amplitude."
  MIXPANEL: {
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
  },
  // Kept in sync with providers/appsflyer.ts's own `defaultEventMapping`
  // export. AppsFlyer's `af_`-prefixed names are its own documented
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
  // DELIBERATELY EMPTY — see providers/adjust.ts's `defaultEventMapping`
  // comment for the full PRE-FLIGHT RULING rationale: Adjust event tokens
  // are opaque, account-specific ids with no vendor-wide vocabulary to
  // default to. `applyEventMapping` falls through to `no_mapping` for every
  // key here unless the connection's own `eventMapping` override supplies
  // a token.
  ADJUST: {},
  // SLACK — every one of the 17 public event keys maps to itself. Slack has
  // no vendor-specific event-name vocabulary (there is no "Subscribe" or
  // "purchase_initial" equivalent) — `providerEvent` is only ever used as a
  // human-readable label. Kept in sync with providers/slack.ts's own
  // `defaultEventMapping` export (which the dashboard drawer reads).
  SLACK: Object.fromEntries(
    ROVENUE_EVENT_KEYS.map((key) => [key, key]),
  ) as Partial<Record<RovenueEventKey, string>>,
  // Kept in sync with providers/firebase-ga4.ts's own `defaultEventMapping`
  // export (which the dashboard drawer reads). GA4 custom event names must
  // match `^[A-Za-z]\w*$`, so unlike AMPLITUDE/MIXPANEL/APPSFLYER these are
  // NOT free-form vendor names — see firebase-ga4.ts for the full mapping
  // rationale (revenue.* collapse onto "purchase"/"refund"/
  // "rovenue_cancellation"; subscription.* derive as "rovenue_" + the event
  // type with dots replaced by underscores).
  FIREBASE_GA4: {
    "revenue.INITIAL": "purchase",
    "revenue.RENEWAL": "purchase",
    "revenue.TRIAL_CONVERSION": "purchase",
    "revenue.CREDIT_PURCHASE": "purchase",
    "revenue.REFUND": "refund",
    "revenue.CANCELLATION": "rovenue_cancellation",
    "subscription.trial.started": "rovenue_subscription_trial_started",
    "subscription.cancel_requested": "rovenue_subscription_cancel_requested",
    "subscription.expired": "rovenue_subscription_expired",
    "subscription.billing_issue": "rovenue_subscription_billing_issue",
    "subscription.grace_period": "rovenue_subscription_grace_period",
    "subscription.uncancelled": "rovenue_subscription_uncancelled",
    "subscription.product_changed": "rovenue_subscription_product_changed",
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
