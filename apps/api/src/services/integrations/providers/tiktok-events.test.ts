import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { tiktokEventsProvider } from "./tiktok-events";
import { hashPii } from "../hash-pii";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
  ProviderCredentials,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import { createUndiciHttpClient } from "../http-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_EVENTS: RovenueEventKey[] = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
];

function makeEnvelope(
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId: "ob2",
    projectId: "proj1",
    eventType: "revenue.event.recorded",
    occurredAt: "2024-01-15T10:00:00.000Z",
    revenueEventKind: "RENEWAL",
    amount: "19.99",
    currency: "USD",
    identityContext: { email: "u@x.com", phone: "15550001111" },
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    connectionId: "conn1",
    projectId: "proj1",
    enabledEvents: ALL_EVENTS,
    eventMapping: {},
    actionSource: "website",
    ...overrides,
  };
}

const makeCreds = (overrides: Partial<ProviderCredentials> = {}): ProviderCredentials => ({
  access_token: "tok",
  pixel_code: "CXX",
  ...overrides,
});

// ---------------------------------------------------------------------------
// M1.7 — mapEvent tests
// ---------------------------------------------------------------------------

describe("tiktokEventsProvider.mapEvent", () => {
  it("RENEWAL → Subscribe with hashed email + phone", () => {
    const result = tiktokEventsProvider.mapEvent(
      makeEnvelope(),
      makeConfig(),
      makeCreds(),
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as {
      event_source: string;
      event_source_id: string;
      data: Array<{
        event: string;
        user: { email: string; phone: string };
        properties: { value: number };
      }>;
    };
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("CXX");
    expect(body.data[0].user.email).toBe(hashPii("u@x.com"));
    expect(body.data[0].user.phone).toBe(hashPii("15550001111"));
    expect(body.data[0].properties.value).toBe(19.99);
  });

  it("CREDIT_PURCHASE → CompletePayment", () => {
    const envelope = makeEnvelope({ revenueEventKind: "CREDIT_PURCHASE" });
    const result = tiktokEventsProvider.mapEvent(
      envelope,
      makeConfig(),
      makeCreds(),
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.providerEvent).toBe("CompletePayment");
  });

  it("skips when identityContext is empty", () => {
    const envelope = makeEnvelope({ identityContext: {} });
    const result = tiktokEventsProvider.mapEvent(
      envelope,
      makeConfig(),
      makeCreds(),
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});
