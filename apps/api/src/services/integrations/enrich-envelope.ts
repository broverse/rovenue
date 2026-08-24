// =============================================================
// enrich-envelope — delivery-time subscriber identity enrichment (Task 2)
// =============================================================
//
// Pure function. Called by the deliver worker (runDeliverStep) after
// credential decrypt and before mapEvent, guarded by a try/catch there —
// enrichment is SOFT: any failure upstream (the loader) must never fail a
// delivery. This function itself never throws.

import type { IdentityContext, RovenueEventEnvelope } from "./types";
import type { SubscriberIdentity } from "./subscriber-identity-cache";

/** ATT consent value that keeps device-advertising ids on the wire. Any
 *  other reported value (or the gate wouldn't apply if the key were
 *  simply absent) strips them. */
const ATT_CONSENT_AUTHORIZED = "authorized";

export function enrichEnvelope(
  envelope: RovenueEventEnvelope,
  identity: SubscriberIdentity | null,
): RovenueEventEnvelope {
  if (identity === null) return envelope;

  const attributes = identity.attributes;

  // Envelope-provided identityContext values WIN — attributes only fill
  // gaps the envelope didn't already carry.
  const identityContext: IdentityContext = { ...envelope.identityContext };
  if (identityContext.email === undefined && attributes.$email !== undefined) {
    identityContext.email = attributes.$email;
  }
  if (identityContext.phone === undefined && attributes.$phoneNumber !== undefined) {
    identityContext.phone = attributes.$phoneNumber;
  }

  // subscriberAttributes = the flattened attribute map + appUserId (when
  // the subscriber has one). `platform`, vendor ids, etc. ride along
  // unchanged since they're already keys in `attributes`.
  const subscriberAttributes: Record<string, string> = { ...attributes };
  if (identity.appUserId) {
    subscriberAttributes.appUserId = identity.appUserId;
  }

  // ATT gate: device-advertising ids only travel to ad-platform providers
  // when the subscriber has affirmatively authorized tracking. Absent
  // status (never asked / pre-ATT SDK) keeps them — the gate only fires
  // when a status was reported and it isn't "authorized".
  const consentStatus = subscriberAttributes.$attConsentStatus;
  if (consentStatus !== undefined && consentStatus !== ATT_CONSENT_AUTHORIZED) {
    delete subscriberAttributes.$idfa;
    delete subscriberAttributes.$gpsAdId;
  }

  return {
    ...envelope,
    identityContext,
    subscriberAttributes,
  };
}
