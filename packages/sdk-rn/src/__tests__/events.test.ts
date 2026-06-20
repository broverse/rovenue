// =============================================================
// M7.2 — EventEnvelope + IdentityContext serialiser tests
// =============================================================

import { describe, expect, it } from "vitest";
import { serializeEnvelope, type EventEnvelope } from "../events";

describe("serializeEnvelope", () => {
  it("round-trips with all 9 identityContext fields", () => {
    const env: EventEnvelope = {
      eventType: "revenue.event.recorded",
      occurredAt: "2026-05-28T10:00:00Z",
      subscriberId: "sub_abc",
      productId: "prod_xyz",
      amount: "9.99",
      currency: "USD",
      eventSourceUrl: "https://example.com/app",
      identityContext: {
        email: "user@example.com",
        externalId: "uid_123",
        phone: "+15005550006",
        ip: "203.0.113.1",
        userAgent: "Mozilla/5.0",
        firstName: "Jane",
        lastName: "Doe",
        city: "Istanbul",
        countryCode: "TR",
      },
    };

    const json = serializeEnvelope(env);
    const parsed = JSON.parse(json);

    expect(parsed.identityContext).toBeDefined();
    expect(parsed.identityContext.externalId).toBe("uid_123");
    expect(parsed.identityContext.userAgent).toBe("Mozilla/5.0");
    expect(parsed.identityContext.firstName).toBe("Jane");
    expect(parsed.identityContext.lastName).toBe("Doe");
    expect(parsed.identityContext.countryCode).toBe("TR");
    expect(parsed.identityContext.email).toBe("user@example.com");
    expect(parsed.identityContext.phone).toBe("+15005550006");
    expect(parsed.identityContext.ip).toBe("203.0.113.1");
    expect(parsed.identityContext.city).toBe("Istanbul");
  });

  it("omits undefined identityContext fields", () => {
    const env: EventEnvelope = {
      eventType: "subscription.trial.started",
      occurredAt: "2026-05-28T12:00:00Z",
      identityContext: {
        email: "a@b.co",
        // all other fields left undefined
      },
    };

    const json = serializeEnvelope(env);
    const parsed = JSON.parse(json);

    expect(parsed.identityContext).toEqual({ email: "a@b.co" });
    // No undefined-valued keys should be present
    expect(Object.keys(parsed.identityContext)).toEqual(["email"]);
  });

  it("passes wire version and eventId through when supplied", () => {
    const env: EventEnvelope = {
      version: 1,
      eventId: "evt_custom",
      eventType: "purchase.completed",
      occurredAt: "2026-05-28T14:00:00Z",
    };

    const parsed = JSON.parse(serializeEnvelope(env));

    expect(parsed.version).toBe(1);
    expect(parsed.eventId).toBe("evt_custom");
  });

  it("omits identityContext entirely when not provided", () => {
    const env: EventEnvelope = {
      eventType: "subscription.expired",
      occurredAt: "2026-05-28T13:00:00Z",
      subscriberId: "sub_no_ic",
    };

    const json = serializeEnvelope(env);
    const parsed = JSON.parse(json);

    expect(parsed.identityContext).toBeUndefined();
    // Backwards-compat: absent from payload
    expect("identityContext" in parsed).toBe(false);
  });
});
