import { describe, expect, it } from "vitest";
import { enrichEnvelope } from "./enrich-envelope";
import type { RovenueEventEnvelope } from "./types";
import type { SubscriberIdentity } from "./subscriber-identity-cache";

function baseEnvelope(
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId: "ob1",
    projectId: "p1",
    eventType: "revenue.event.recorded",
    occurredAt: new Date().toISOString(),
    subscriberId: "sub_1",
    ...overrides,
  };
}

describe("enrichEnvelope", () => {
  it("returns the envelope unchanged when identity is null", () => {
    const envelope = baseEnvelope({ identityContext: { email: "keep@example.com" } });
    const result = enrichEnvelope(envelope, null);
    expect(result).toBe(envelope);
  });

  it("fills in email/phone from attributes when the envelope has none", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: "user_1",
      attributes: { $email: "attr@example.com", $phoneNumber: "+15551234567" },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.identityContext?.email).toBe("attr@example.com");
    expect(result.identityContext?.phone).toBe("+15551234567");
  });

  it("envelope-provided identityContext values WIN over attributes", () => {
    const envelope = baseEnvelope({
      identityContext: { email: "envelope@example.com", phone: "+15550000000" },
    });
    const identity: SubscriberIdentity = {
      appUserId: "user_1",
      attributes: { $email: "attr@example.com", $phoneNumber: "+15551234567" },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.identityContext?.email).toBe("envelope@example.com");
    expect(result.identityContext?.phone).toBe("+15550000000");
  });

  it("preserves other identityContext fields untouched", () => {
    const envelope = baseEnvelope({
      identityContext: { externalId: "ext-1", ip: "1.2.3.4" },
    });
    const identity: SubscriberIdentity = {
      appUserId: "user_1",
      attributes: { $email: "attr@example.com" },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.identityContext?.externalId).toBe("ext-1");
    expect(result.identityContext?.ip).toBe("1.2.3.4");
    expect(result.identityContext?.email).toBe("attr@example.com");
  });

  it("sets subscriberAttributes to attributes + appUserId when appUserId is present", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: "user_1",
      attributes: { platform: "ios", country: "US" },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.subscriberAttributes).toEqual({
      platform: "ios",
      country: "US",
      appUserId: "user_1",
    });
  });

  it("omits appUserId from subscriberAttributes when appUserId is null", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: null,
      attributes: { platform: "android" },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.subscriberAttributes).toEqual({ platform: "android" });
    expect(result.subscriberAttributes).not.toHaveProperty("appUserId");
  });

  it("ATT gate: strips $idfa/$gpsAdId when $attConsentStatus is present and denied", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: null,
      attributes: {
        $attConsentStatus: "denied",
        $idfa: "idfa-value",
        $gpsAdId: "gpsadid-value",
        platform: "ios",
      },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.subscriberAttributes).not.toHaveProperty("$idfa");
    expect(result.subscriberAttributes).not.toHaveProperty("$gpsAdId");
    expect(result.subscriberAttributes?.$attConsentStatus).toBe("denied");
    expect(result.subscriberAttributes?.platform).toBe("ios");
  });

  it("ATT gate: keeps $idfa/$gpsAdId when $attConsentStatus is authorized", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: null,
      attributes: {
        $attConsentStatus: "authorized",
        $idfa: "idfa-value",
        $gpsAdId: "gpsadid-value",
      },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.subscriberAttributes?.$idfa).toBe("idfa-value");
    expect(result.subscriberAttributes?.$gpsAdId).toBe("gpsadid-value");
  });

  it("ATT gate: keeps $idfa/$gpsAdId when $attConsentStatus is absent", () => {
    const envelope = baseEnvelope();
    const identity: SubscriberIdentity = {
      appUserId: null,
      attributes: {
        $idfa: "idfa-value",
        $gpsAdId: "gpsadid-value",
      },
    };

    const result = enrichEnvelope(envelope, identity);

    expect(result.subscriberAttributes?.$idfa).toBe("idfa-value");
    expect(result.subscriberAttributes?.$gpsAdId).toBe("gpsadid-value");
  });
});
