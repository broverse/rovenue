import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { onesignalProvider } from "./onesignal";
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

const APP_ID = "11111111-2222-3333-4444-555555555555";

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
    subscriberAttributes: { $onesignalId: "os_user_1" },
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

interface OnesignalCustomEvent {
  name: string;
  onesignal_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

type OnesignalCustomEventsBody = { events: OnesignalCustomEvent[] };

// ---------------------------------------------------------------------------
// mapEvent — revenue.* and subscription.* -> custom_events
// ---------------------------------------------------------------------------

describe("onesignalProvider.mapEvent — revenue.*", () => {
  it.each([
    ["INITIAL", "revenue.INITIAL"],
    ["TRIAL_CONVERSION", "revenue.TRIAL_CONVERSION"],
    ["RENEWAL", "revenue.RENEWAL"],
    ["CREDIT_PURCHASE", "revenue.CREDIT_PURCHASE"],
    ["REFUND", "revenue.REFUND"],
    ["CANCELLATION", "revenue.CANCELLATION"],
  ] as const)("maps revenueEventKind %s to a custom event (%s)", (kind, expectedKey) => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ revenueEventKind: kind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(expectedKey);
    const body = payload.body as OnesignalCustomEventsBody;
    expect(body.events).toHaveLength(1);
    const event = body.events[0]!;
    expect(event.onesignal_id).toBe("os_user_1");
    expect(event.timestamp).toBe(new Date("2024-01-15T10:00:00.000Z").toISOString());
    expect(event.payload.rovenue_event).toBe(expectedKey);
    expect(event.payload.outbox_event_id).toBe("ob1");
    expect(event.payload.amount).toBe(9.99);
    expect(event.payload.currency).toBe("USD");
    expect(event.payload.product_id).toBe("prod_gold");
  });

  it("omits amount and currency (never fabricates a currency) when amount is present but currency is absent", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ amount: "9.99", currency: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as OnesignalCustomEventsBody;
    expect(body.events[0]!.payload.amount).toBeUndefined();
    expect(body.events[0]!.payload.currency).toBeUndefined();
    // event is still forwarded, not skipped
    expect(result).not.toHaveProperty("skip");
  });

  it("omits amount/currency when currency is present but amount is absent", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ amount: undefined, currency: "USD" }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as OnesignalCustomEventsBody;
    expect(body.events[0]!.payload.amount).toBeUndefined();
    expect(body.events[0]!.payload.currency).toBeUndefined();
  });

  it("omits amount/currency when amount is unparseable", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ amount: "not-a-number", currency: "USD" }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as OnesignalCustomEventsBody;
    expect(body.events[0]!.payload.amount).toBeUndefined();
    expect(body.events[0]!.payload.currency).toBeUndefined();
  });

  it("does not carry product_id/amount/currency on subscription.* (non-revenue) events", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as OnesignalCustomEventsBody;
    expect(body.events[0]!.payload.amount).toBeUndefined();
    expect(body.events[0]!.payload.product_id).toBeUndefined();
  });
});

describe("onesignalProvider.mapEvent — subscription.* -> custom_events", () => {
  it.each([
    "subscription.trial.started",
    "subscription.cancel_requested",
    "subscription.expired",
    "subscription.billing_issue",
    "subscription.grace_period",
    "subscription.uncancelled",
    "subscription.product_changed",
  ] as const)("maps eventType %s to a custom event", (eventType) => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(eventType);
    const body = payload.body as OnesignalCustomEventsBody;
    expect(body.events[0]!.payload.rovenue_event).toBe(eventType);
  });
});

// ---------------------------------------------------------------------------
// mapEvent — identity resolution: REQUIRES $onesignalId
// ---------------------------------------------------------------------------

describe("onesignalProvider.mapEvent — identity resolution", () => {
  it("uses onesignal_id = subscriberAttributes.$onesignalId", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: { $onesignalId: "os_42" } }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as OnesignalCustomEventsBody;
    expect(body.events[0]!.onesignal_id).toBe("os_42");
  });

  it("skips with no_user_data when $onesignalId is absent (no subscriberId fallback)", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: {}, subscriberId: "sub_should_not_be_used" }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — scope / idempotency
// ---------------------------------------------------------------------------

describe("onesignalProvider.mapEvent — scope and idempotency", () => {
  it("throws when outboxEventId is empty", () => {
    expect(() =>
      onesignalProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), {}),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      config,
      {},
    );
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips unmapped envelope eventTypes with no_mapping", () => {
    const result = onesignalProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("onesignalProvider.credentialsSchema", () => {
  it("accepts app_id + rest_api_key", () => {
    expect(
      onesignalProvider.credentialsSchema.safeParse({
        app_id: APP_ID,
        rest_api_key: "k",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(onesignalProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a missing rest_api_key", () => {
    expect(
      onesignalProvider.credentialsSchema.safeParse({ app_id: APP_ID }).success,
    ).toBe(false);
  });

  it("rejects a missing app_id", () => {
    expect(
      onesignalProvider.credentialsSchema.safeParse({ rest_api_key: "k" }).success,
    ).toBe(false);
  });

  it("rejects an empty app_id", () => {
    expect(
      onesignalProvider.credentialsSchema.safeParse({ app_id: "", rest_api_key: "k" })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — real zero-footprint GET /apps/{app_id}
// ---------------------------------------------------------------------------

describe("onesignalProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("2xx -> ok, GETs /apps/{app_id} with Authorization: Key <rest_api_key>", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    agent
      .get("https://api.onesignal.com")
      .intercept({ path: `/apps/${APP_ID}`, method: "GET" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        return { statusCode: 200, data: '{"id":"' + APP_ID + '"}' };
      });
    const http = createUndiciHttpClient();
    const result = await onesignalProvider.validateCredentials(
      { app_id: APP_ID, rest_api_key: "good_key" },
      http,
    );
    expect(result).toEqual({ ok: true });
    expect(observedHeaders["authorization"]).toBe("Key good_key");
    expect(observedPath).toBe(`/apps/${APP_ID}`);
  });

  it("401 -> !ok", async () => {
    agent
      .get("https://api.onesignal.com")
      .intercept({ path: `/apps/${APP_ID}`, method: "GET" })
      .reply(401, "");
    const http = createUndiciHttpClient();
    const result = await onesignalProvider.validateCredentials(
      { app_id: APP_ID, rest_api_key: "bad_key" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("404 (unknown app_id) -> !ok", async () => {
    agent
      .get("https://api.onesignal.com")
      .intercept({ path: `/apps/${APP_ID}`, method: "GET" })
      .reply(404, "");
    const http = createUndiciHttpClient();
    const result = await onesignalProvider.validateCredentials(
      { app_id: APP_ID, rest_api_key: "k" },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix
// ---------------------------------------------------------------------------

describe("onesignalProvider.deliver", () => {
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
    providerEvent: "renewal",
    body: {
      events: [
        {
          name: "renewal",
          onesignal_id: "os_user_1",
          timestamp: "2024-01-15T10:00:00.000Z",
          payload: { rovenue_event: "revenue.RENEWAL", outbox_event_id: "ob1" },
        },
      ],
    },
  };

  it.each([
    [200, true, false],
    [202, true, false],
    [400, false, false],
    [401, false, false],
    [403, false, false],
    [429, false, true],
    [500, false, true],
    [503, false, true],
  ] as const)("http %s -> ok:%s retriable:%s", async (status, ok, retriable) => {
    agent
      .get("https://api.onesignal.com")
      .intercept({ path: `/apps/${APP_ID}/custom_events`, method: "POST" })
      .reply(status, '{"result":"ok"}');
    const http = createUndiciHttpClient();
    const result = await onesignalProvider.deliver(
      dummyPayload,
      { app_id: APP_ID, rest_api_key: "k" },
      http,
    );
    expect(result.ok).toBe(ok);
    expect(result.retriable).toBe(retriable);
    expect(result.httpStatus).toBe(status);
  });

  it("sends Authorization: Key <rest_api_key> to POST /apps/{app_id}/custom_events", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    agent
      .get("https://api.onesignal.com")
      .intercept({ path: `/apps/${APP_ID}/custom_events`, method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        return { statusCode: 200, data: "{}" };
      });
    const http = createUndiciHttpClient();
    await onesignalProvider.deliver(
      dummyPayload,
      { app_id: APP_ID, rest_api_key: "my_key" },
      http,
    );
    expect(observedHeaders["authorization"]).toBe("Key my_key");
    expect(observedPath).toBe(`/apps/${APP_ID}/custom_events`);
  });
});

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

describe("onesignalProvider static config", () => {
  it("id is ONESIGNAL", () => {
    expect(onesignalProvider.id).toBe("ONESIGNAL");
  });

  it("topics are revenue + subscription only", () => {
    expect(onesignalProvider.topics).toEqual(["rovenue.revenue", "rovenue.subscription"]);
  });

  it("allowMultipleConnections is false", () => {
    expect(onesignalProvider.allowMultipleConnections).toBe(false);
  });

  it("has no retryPolicy of its own (falls through to DEFAULT_RETRY_POLICY)", () => {
    expect(onesignalProvider.retryPolicy).toBeUndefined();
  });

  it("eventCatalog is the 13-key STANDARD_PROVIDER_EVENT_KEYS set", () => {
    expect(onesignalProvider.eventCatalog).toHaveLength(13);
    expect(onesignalProvider.eventCatalog).toContain("revenue.REFUND");
    expect(onesignalProvider.eventCatalog).toContain("subscription.trial.started");
  });

  it("defaultEventMapping maps every catalog key", () => {
    for (const key of onesignalProvider.eventCatalog) {
      expect(onesignalProvider.defaultEventMapping[key]).toBeTruthy();
    }
  });
});
