import { describe, expect, it } from "vitest";
import { metaCapiProvider } from "./meta-capi";
import { hashPii } from "../hash-pii";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";

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
    outboxEventId: "ob1",
    projectId: "proj1",
    eventType: "revenue.event.recorded",
    occurredAt: "2024-01-15T10:00:00.000Z",
    revenueEventKind: "RENEWAL",
    amount: "9.99",
    currency: "USD",
    identityContext: { email: "u@x.com" },
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

// ---------------------------------------------------------------------------
// M1.5 — mapEvent tests
// ---------------------------------------------------------------------------

describe("metaCapiProvider.mapEvent", () => {
  it("maps RENEWAL → Purchase with hashed email", () => {
    const result = metaCapiProvider.mapEvent(makeEnvelope(), makeConfig());
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: { em: string[] };
        custom_data: { value: number };
      }>;
    };
    expect(body.data[0].event_name).toBe("Purchase");
    expect(body.data[0].event_id).toBe("ob1");
    expect(body.data[0].user_data.em[0]).toBe(hashPii("u@x.com"));
    expect(body.data[0].custom_data.value).toBe(9.99);
  });

  it("skips when not in enabled_events", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = metaCapiProvider.mapEvent(makeEnvelope(), config);
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips when identityContext is empty", () => {
    const envelope = makeEnvelope({ identityContext: {} });
    const result = metaCapiProvider.mapEvent(envelope, makeConfig());
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("test_event_code is forwarded into body", () => {
    const config = makeConfig({ testEventCode: "TEST123" });
    const result = metaCapiProvider.mapEvent(makeEnvelope(), config);
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as Record<string, unknown>;
    expect(body.test_event_code).toBe("TEST123");
  });
});
