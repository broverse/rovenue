import type { RovenueEventKey, IntegrationProviderId } from "@rovenue/shared";
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
