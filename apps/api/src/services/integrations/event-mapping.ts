import type { RovenueEventKey, IntegrationProviderId } from "@rovenue/shared";

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
  },
  TIKTOK_EVENTS: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Subscribe",
    "revenue.CREDIT_PURCHASE": "CompletePayment",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
    // revenue.REFUND / revenue.CANCELLATION: intentionally unmapped (see above).
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
