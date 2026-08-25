import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { airbridgeProvider } from "./airbridge";
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
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
];

const APP_NAME = "my-cool-app";

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
    subscriberId: "sub_123",
    productId: "prod_gold",
    subscriberAttributes: { $airbridgeDeviceId: "device_1" },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    connectionId: "conn1",
    projectId: "proj1",
    enabledEvents: ALL_EVENTS,
    eventMapping: {},
    actionSource: "app",
    ...overrides,
  };
}

interface AirbridgeGoal {
  category: string;
  value?: number;
  semanticAttributes: { transactionID: string; currency?: string };
  customAttributes: { rovenue_event: RovenueEventKey };
}

interface AirbridgeEventBody {
  eventTimestamp: number;
  device: { deviceUUID: string };
  app: { packageName: string };
  eventData: { goal: AirbridgeGoal };
}

// ---------------------------------------------------------------------------
// mapEvent — revenue.*
// ---------------------------------------------------------------------------

describe("airbridgeProvider.mapEvent — revenue.*", () => {
  it.each([
    ["INITIAL", "revenue.INITIAL", "airbridge.subscribe"],
    ["TRIAL_CONVERSION", "revenue.TRIAL_CONVERSION", "airbridge.subscribe"],
    ["RENEWAL", "revenue.RENEWAL", "airbridge.ecommerce.order.completed"],
    ["CREDIT_PURCHASE", "revenue.CREDIT_PURCHASE", "airbridge.ecommerce.order.completed"],
    ["REFUND", "revenue.REFUND", "airbridge.ecommerce.order.canceled"],
    ["CANCELLATION", "revenue.CANCELLATION", "airbridge.unsubscribe"],
  ] as const)("maps revenueEventKind %s to %s (category %s)", (kind, expectedKey, expectedCategory) => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: kind }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(expectedKey);
    expect(payload.providerEvent).toBe(expectedCategory);
    const body = payload.body as AirbridgeEventBody;
    expect(body.eventData.goal.category).toBe(expectedCategory);
    expect(body.device.deviceUUID).toBe("device_1");
    expect(body.app.packageName).toBe(APP_NAME);
    expect(body.eventData.goal.semanticAttributes.transactionID).toBe("ob1");
    expect(body.eventData.goal.customAttributes.rovenue_event).toBe(expectedKey);
    expect(body.eventData.goal.value).toBe(9.99);
    expect(body.eventData.goal.semanticAttributes.currency).toBe("USD");
  });

  it("omits value/currency (never fabricates a currency) when amount is present but currency is absent", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ amount: "9.99", currency: undefined }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    const body = (result as ProviderPayload).body as AirbridgeEventBody;
    expect(body.eventData.goal.value).toBeUndefined();
    expect(body.eventData.goal.semanticAttributes.currency).toBeUndefined();
    // event is still forwarded, not skipped
    expect(result).not.toHaveProperty("skip");
  });

  it("omits value/currency when currency is present but amount is absent", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ amount: undefined, currency: "USD" }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    const body = (result as ProviderPayload).body as AirbridgeEventBody;
    expect(body.eventData.goal.value).toBeUndefined();
    expect(body.eventData.goal.semanticAttributes.currency).toBeUndefined();
  });

  it("omits value/currency when amount is unparseable", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ amount: "not-a-number", currency: "USD" }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    const body = (result as ProviderPayload).body as AirbridgeEventBody;
    expect(body.eventData.goal.value).toBeUndefined();
    expect(body.eventData.goal.semanticAttributes.currency).toBeUndefined();
  });

  it("does not carry value/currency on subscription.* (non-revenue) events", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    const body = (result as ProviderPayload).body as AirbridgeEventBody;
    expect(body.eventData.goal.value).toBeUndefined();
    expect(body.eventData.goal.semanticAttributes.currency).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapEvent — subscription.* -> category
// ---------------------------------------------------------------------------

describe("airbridgeProvider.mapEvent — subscription.*", () => {
  it("maps subscription.trial.started to the vendor's real airbridge.startTrial event", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.providerEvent).toBe("airbridge.startTrial");
  });

  it.each([
    ["subscription.cancel_requested", "rovenue_subscription_cancel_requested"],
    ["subscription.expired", "rovenue_subscription_expired"],
    ["subscription.billing_issue", "rovenue_subscription_billing_issue"],
    ["subscription.grace_period", "rovenue_subscription_grace_period"],
    ["subscription.uncancelled", "rovenue_subscription_uncancelled"],
    ["subscription.product_changed", "rovenue_subscription_product_changed"],
  ] as const)("maps eventType %s to the custom category %s", (eventType, expectedCategory) => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(eventType);
    expect(payload.providerEvent).toBe(expectedCategory);
  });
});

// ---------------------------------------------------------------------------
// mapEvent — identity resolution: REQUIRES $airbridgeDeviceId
// ---------------------------------------------------------------------------

describe("airbridgeProvider.mapEvent — identity resolution", () => {
  it("uses device.deviceUUID = subscriberAttributes.$airbridgeDeviceId", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: { $airbridgeDeviceId: "abr_42" } }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    const body = (result as ProviderPayload).body as AirbridgeEventBody;
    expect(body.device.deviceUUID).toBe("abr_42");
  });

  it("skips with no_user_data when $airbridgeDeviceId is absent (no subscriberId fallback)", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: {}, subscriberId: "sub_should_not_be_used" }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: undefined }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — scope / idempotency
// ---------------------------------------------------------------------------

describe("airbridgeProvider.mapEvent — scope and idempotency", () => {
  it("throws when outboxEventId is empty", () => {
    expect(() =>
      airbridgeProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), {
        app_name: APP_NAME,
        api_token: "tok",
      }),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      config,
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips unmapped envelope eventTypes with no_mapping", () => {
    const result = airbridgeProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      { app_name: APP_NAME, api_token: "tok" },
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("airbridgeProvider.credentialsSchema", () => {
  it("accepts app_name + api_token", () => {
    expect(
      airbridgeProvider.credentialsSchema.safeParse({
        app_name: APP_NAME,
        api_token: "k",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(airbridgeProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a missing api_token", () => {
    expect(
      airbridgeProvider.credentialsSchema.safeParse({ app_name: APP_NAME }).success,
    ).toBe(false);
  });

  it("rejects a missing app_name", () => {
    expect(
      airbridgeProvider.credentialsSchema.safeParse({ api_token: "k" }).success,
    ).toBe(false);
  });

  it("rejects an empty app_name", () => {
    expect(
      airbridgeProvider.credentialsSchema.safeParse({ app_name: "", api_token: "k" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — SHAPE-ONLY (no zero-footprint app+token check exists)
// ---------------------------------------------------------------------------

describe("airbridgeProvider.validateCredentials", () => {
  it("ok when credentials are well-formed (sends no request)", async () => {
    const http = {
      request: async () => {
        throw new Error("validateCredentials must not send any request");
      },
    };
    const result = await airbridgeProvider.validateCredentials(
      { app_name: APP_NAME, api_token: "tok" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails when app_name is missing", async () => {
    const http = { request: async () => ({ status: 200, body: "" }) };
    const result = await airbridgeProvider.validateCredentials({ api_token: "tok" }, http);
    expect(result.ok).toBe(false);
  });

  it("fails when api_token is missing", async () => {
    const http = { request: async () => ({ status: 200, body: "" }) };
    const result = await airbridgeProvider.validateCredentials({ app_name: APP_NAME }, http);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix + wire shape
// ---------------------------------------------------------------------------

describe("airbridgeProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  const dummyPayload: ProviderPayload = {
    eventKey: "revenue.RENEWAL",
    providerEvent: "airbridge.ecommerce.order.completed",
    body: {
      eventTimestamp: 1705312800000,
      device: { deviceUUID: "device_1" },
      app: { packageName: APP_NAME },
      eventData: {
        goal: {
          category: "airbridge.ecommerce.order.completed",
          value: 9.99,
          semanticAttributes: { transactionID: "ob1", currency: "USD" },
          customAttributes: { rovenue_event: "revenue.RENEWAL" },
        },
      },
    },
  };

  it.each([
    [200, true, false],
    [201, true, false],
    [400, false, false],
    [401, false, false],
    [403, false, false],
    [429, false, true],
    [500, false, true],
    [503, false, true],
  ] as const)("http %s -> ok:%s retriable:%s", async (status, ok, retriable) => {
    agent
      .get("https://api.airbridge.io")
      .intercept({ path: `/events/v2/apps/${APP_NAME}/mobile-app/9360`, method: "POST" })
      .reply(status, '{"at":"now","data":"Event(9360) is successfully proccessed."}');
    const http = createUndiciHttpClient();
    const result = await airbridgeProvider.deliver(
      dummyPayload,
      { app_name: APP_NAME, api_token: "tok" },
      http,
    );
    expect(result.ok).toBe(ok);
    expect(result.retriable).toBe(retriable);
    expect(result.httpStatus).toBe(status);
  });

  it("POSTs to /events/v2/apps/{app_name}/mobile-app/9360 with Authorization: Bearer <api_token>", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    let observedBody = "";
    agent
      .get("https://api.airbridge.io")
      .intercept({ path: `/events/v2/apps/${APP_NAME}/mobile-app/9360`, method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        observedBody = opts.body as string;
        return { statusCode: 200, data: "{}" };
      });
    const http = createUndiciHttpClient();
    await airbridgeProvider.deliver(
      dummyPayload,
      { app_name: APP_NAME, api_token: "my_token" },
      http,
    );
    expect(observedHeaders["authorization"]).toBe("Bearer my_token");
    expect(observedPath).toBe(`/events/v2/apps/${APP_NAME}/mobile-app/9360`);
    expect(JSON.parse(observedBody)).toEqual(dummyPayload.body);
  });

  it("URL-encodes app_name in the path", async () => {
    let observedPath = "";
    agent
      .get("https://api.airbridge.io")
      .intercept({ path: "/events/v2/apps/my%20app/mobile-app/9360", method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        return { statusCode: 200, data: "{}" };
      });
    const http = createUndiciHttpClient();
    await airbridgeProvider.deliver(dummyPayload, { app_name: "my app", api_token: "tok" }, http);
    expect(observedPath).toBe("/events/v2/apps/my%20app/mobile-app/9360");
  });
});

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

describe("airbridgeProvider static config", () => {
  it("id is AIRBRIDGE", () => {
    expect(airbridgeProvider.id).toBe("AIRBRIDGE");
  });

  it("topics are revenue + subscription only", () => {
    expect(airbridgeProvider.topics).toEqual(["rovenue.revenue", "rovenue.subscription"]);
  });

  it("allowMultipleConnections is false", () => {
    expect(airbridgeProvider.allowMultipleConnections).toBe(false);
  });

  it("has no retryPolicy of its own (falls through to DEFAULT_RETRY_POLICY)", () => {
    expect(airbridgeProvider.retryPolicy).toBeUndefined();
  });

  it("eventCatalog is the 13-key STANDARD_PROVIDER_EVENT_KEYS set", () => {
    expect(airbridgeProvider.eventCatalog).toHaveLength(13);
    expect(airbridgeProvider.eventCatalog).toContain("revenue.REFUND");
    expect(airbridgeProvider.eventCatalog).toContain("subscription.trial.started");
  });

  it("defaultEventMapping maps every catalog key", () => {
    for (const key of airbridgeProvider.eventCatalog) {
      expect(airbridgeProvider.defaultEventMapping[key]).toBeTruthy();
    }
  });
});
