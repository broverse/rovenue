import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { firebaseGa4Provider } from "./firebase-ga4";
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
    subscriberAttributes: { $firebaseAppInstanceId: "fai_1" },
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
    actionSource: "app",
    ...overrides,
  };
}

type Ga4EventBody = {
  app_instance_id: string;
  timestamp_micros: number;
  events: [
    {
      name: string;
      params: {
        currency?: string;
        value?: number;
        transaction_id: string;
        product_id?: string;
        rovenue_event: string;
      };
    },
  ];
};

// ---------------------------------------------------------------------------
// defaultEventMapping — GA4 custom event name regex
// ---------------------------------------------------------------------------

describe("firebaseGa4Provider.defaultEventMapping", () => {
  const GA4_EVENT_NAME_PATTERN = /^[A-Za-z]\w*$/;

  it("every mapping value matches GA4's custom-event-name regex ^[A-Za-z]\\w*$", () => {
    for (const [key, value] of Object.entries(firebaseGa4Provider.defaultEventMapping)) {
      expect(value, `mapping for ${key}`).toMatch(GA4_EVENT_NAME_PATTERN);
    }
  });

  it("has exactly the 13-key Wave-1 catalog", () => {
    expect(Object.keys(firebaseGa4Provider.defaultEventMapping).sort()).toEqual(
      [...ALL_EVENTS].sort(),
    );
  });

  it("eventCatalog matches defaultEventMapping's keys", () => {
    expect([...firebaseGa4Provider.eventCatalog].sort()).toEqual(
      Object.keys(firebaseGa4Provider.defaultEventMapping).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("firebaseGa4Provider.mapEvent", () => {
  it.each([
    ["revenue.INITIAL", "purchase"],
    ["revenue.RENEWAL", "purchase"],
    ["revenue.TRIAL_CONVERSION", "purchase"],
    ["revenue.CREDIT_PURCHASE", "purchase"],
    ["revenue.REFUND", "refund"],
    ["revenue.CANCELLATION", "rovenue_cancellation"],
  ] as const)("maps %s -> %s", (kind, expected) => {
    const revenueKind = kind.split(".")[1] as RovenueEventEnvelope["revenueEventKind"];
    const result = firebaseGa4Provider.mapEvent(
      makeEnvelope({ revenueEventKind: revenueKind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as Ga4EventBody;
    expect(body.events[0]!.name).toBe(expected);
  });

  it.each([
    ["subscription.trial.started", "rovenue_subscription_trial_started"],
    ["subscription.cancel_requested", "rovenue_subscription_cancel_requested"],
    ["subscription.expired", "rovenue_subscription_expired"],
    ["subscription.billing_issue", "rovenue_subscription_billing_issue"],
    ["subscription.grace_period", "rovenue_subscription_grace_period"],
    ["subscription.uncancelled", "rovenue_subscription_uncancelled"],
    ["subscription.product_changed", "rovenue_subscription_product_changed"],
  ] as const)("maps subscription eventType %s -> %s", (eventType, expected) => {
    const result = firebaseGa4Provider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as Ga4EventBody;
    expect(body.events[0]!.name).toBe(expected);
  });

  it("skips unmapped event types with no_mapping", () => {
    const result = firebaseGa4Provider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = firebaseGa4Provider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      firebaseGa4Provider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        {},
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  // -------------------------------------------------------------------------
  // Identity — REQUIRES $firebaseAppInstanceId, no fallback chain
  // -------------------------------------------------------------------------

  describe("identity requirement", () => {
    it("uses $firebaseAppInstanceId as app_instance_id", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $firebaseAppInstanceId: "fai_specific" },
      });
      const result = firebaseGa4Provider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as Ga4EventBody;
      expect(body.app_instance_id).toBe("fai_specific");
    });

    it("skips with no_user_data when $firebaseAppInstanceId is absent (no fallback to appUserId/subscriberId)", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { appUserId: "app_id" },
        subscriberId: "sub_id",
      });
      const result = firebaseGa4Provider.mapEvent(envelope, makeConfig(), {});
      expect(result).toEqual({ skip: true, reason: "no_user_data" });
    });

    it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
      const envelope = makeEnvelope({ subscriberAttributes: undefined });
      const result = firebaseGa4Provider.mapEvent(envelope, makeConfig(), {});
      expect(result).toEqual({ skip: true, reason: "no_user_data" });
    });
  });

  // -------------------------------------------------------------------------
  // timestamp_micros
  // -------------------------------------------------------------------------

  describe("timestamp_micros", () => {
    it("converts occurredAt (ms) to micros (x1000)", () => {
      const occurredAt = "2024-01-15T10:00:00.000Z";
      const expectedMicros = Date.parse(occurredAt) * 1000;
      const result = firebaseGa4Provider.mapEvent(
        makeEnvelope({ occurredAt }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as Ga4EventBody;
      expect(body.timestamp_micros).toBe(expectedMicros);
    });
  });

  // -------------------------------------------------------------------------
  // Revenue fields
  // -------------------------------------------------------------------------

  describe("revenue fields", () => {
    it("sets value/currency/transaction_id/product_id/rovenue_event on a revenue.* event", () => {
      const result = firebaseGa4Provider.mapEvent(
        makeEnvelope({
          revenueEventKind: "RENEWAL",
          amount: "19.99",
          currency: "EUR",
          outboxEventId: "ob-renewal-1",
        }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as Ga4EventBody;
      const params = body.events[0]!.params;
      expect(params.value).toBe(19.99);
      expect(params.currency).toBe("EUR");
      expect(params.transaction_id).toBe("ob-renewal-1");
      expect(params.product_id).toBe("prod_gold");
      expect(params.rovenue_event).toBe("revenue.RENEWAL");
    });

    it("stores REFUND value as POSITIVE (GA4 convention — opposite of Amplitude/Mixpanel)", () => {
      const result = firebaseGa4Provider.mapEvent(
        makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as Ga4EventBody;
      expect(body.events[0]!.params.value).toBe(5);
      expect(body.events[0]!.name).toBe("refund");
    });

    it("does NOT set value/currency on a subscription lifecycle event", () => {
      const result = firebaseGa4Provider.mapEvent(
        makeEnvelope({
          eventType: "subscription.trial.started",
          revenueEventKind: undefined,
          amount: undefined,
        }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as Ga4EventBody;
      expect(body.events[0]!.params.value).toBeUndefined();
      expect(body.events[0]!.params.currency).toBeUndefined();
    });

    it("event params always carry transaction_id and rovenue_event regardless of event family", () => {
      const result = firebaseGa4Provider.mapEvent(
        makeEnvelope({
          eventType: "subscription.expired",
          revenueEventKind: undefined,
          amount: undefined,
          outboxEventId: "ob-exp-1",
        }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as Ga4EventBody;
      expect(body.events[0]!.params.transaction_id).toBe("ob-exp-1");
      expect(body.events[0]!.params.rovenue_event).toBe("subscription.expired");
    });
  });

  // -------------------------------------------------------------------------
  // Mapping overrides / eventMapping
  // -------------------------------------------------------------------------

  it("uses an override eventName when the connection's eventMapping supplies one", () => {
    const config = makeConfig({
      eventMapping: { "revenue.RENEWAL": { eventName: "rovenue_custom_renewal" } },
    });
    const result = firebaseGa4Provider.mapEvent(makeEnvelope(), config, {});
    const body = (result as ProviderPayload).body as Ga4EventBody;
    expect(body.events[0]!.name).toBe("rovenue_custom_renewal");
  });
});

// ---------------------------------------------------------------------------
// validateCredentials + deliver
// ---------------------------------------------------------------------------

describe("firebaseGa4Provider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("empty validationMessages -> ok", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/debug\/mp\/collect/, method: "POST" })
      .reply(200, JSON.stringify({ validationMessages: [] }));
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.validateCredentials(
      { api_secret: "secret", firebase_app_id: "1:123:android:abc" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("non-empty validationMessages -> !ok", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/debug\/mp\/collect/, method: "POST" })
      .reply(
        200,
        JSON.stringify({
          validationMessages: [
            {
              fieldPath: "events",
              description: "Event at index: [0] has invalid name.",
              validationCode: "NAME_INVALID",
            },
          ],
        }),
      );
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.validateCredentials(
      { api_secret: "secret", firebase_app_id: "1:123:android:abc" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("hits the debug endpoint with firebase_app_id + api_secret as query params", async () => {
    let observedPath: string | undefined;
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/debug\/mp\/collect/, method: "POST" })
      .reply((opts) => {
        observedPath = opts.path as string;
        return { statusCode: 200, data: JSON.stringify({ validationMessages: [] }) };
      });
    const http = createUndiciHttpClient();
    await firebaseGa4Provider.validateCredentials(
      { api_secret: "my_secret", firebase_app_id: "my_app_id" },
      http,
    );
    expect(observedPath).toContain("firebase_app_id=my_app_id");
    expect(observedPath).toContain("api_secret=my_secret");
    expect(observedPath).toContain("/debug/mp/collect");
  });

  it("non-2xx http status -> !ok", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/debug\/mp\/collect/, method: "POST" })
      .reply(500, "server error");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.validateCredentials(
      { api_secret: "secret", firebase_app_id: "app" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("unparseable response body -> !ok", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/debug\/mp\/collect/, method: "POST" })
      .reply(200, "not json");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.validateCredentials(
      { api_secret: "secret", firebase_app_id: "app" },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

describe("firebaseGa4Provider.deliver", () => {
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
    providerEvent: "purchase",
    body: {
      app_instance_id: "fai_1",
      timestamp_micros: 1,
      events: [{ name: "purchase", params: { transaction_id: "ob1", rovenue_event: "revenue.RENEWAL" } }],
    },
  };

  it("200 -> ok + retriable:false", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(200, "");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("204 -> ok + retriable:false", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(204, "");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("400 -> !ok + retriable:false", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(400, "bad request");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("403 -> !ok + retriable:false", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(403, "forbidden");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(500, "server error");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("503 -> !ok + retriable:true", async () => {
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply(503, "unavailable");
    const http = createUndiciHttpClient();
    const result = await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "k", firebase_app_id: "a" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("hits the collect endpoint with firebase_app_id + api_secret as query params and forwards the body verbatim", async () => {
    let observedPath: string | undefined;
    let observedBody: string | undefined;
    agent
      .get("https://www.google-analytics.com")
      .intercept({ path: /\/mp\/collect/, method: "POST" })
      .reply((opts) => {
        observedPath = opts.path as string;
        observedBody = opts.body as string;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await firebaseGa4Provider.deliver(
      dummyPayload,
      { api_secret: "my_secret", firebase_app_id: "my_app_id" },
      http,
    );
    expect(observedPath).toContain("/mp/collect");
    expect(observedPath).toContain("firebase_app_id=my_app_id");
    expect(observedPath).toContain("api_secret=my_secret");
    const sent = JSON.parse(observedBody ?? "{}") as Ga4EventBody;
    expect(sent.app_instance_id).toBe("fai_1");
    expect(sent.events[0]!.name).toBe("purchase");
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("firebaseGa4Provider.credentialsSchema", () => {
  it("accepts api_secret + firebase_app_id", () => {
    expect(
      firebaseGa4Provider.credentialsSchema.safeParse({
        api_secret: "s",
        firebase_app_id: "a",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(firebaseGa4Provider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects missing firebase_app_id", () => {
    expect(
      firebaseGa4Provider.credentialsSchema.safeParse({ api_secret: "s" }).success,
    ).toBe(false);
  });

  it("rejects missing api_secret", () => {
    expect(
      firebaseGa4Provider.credentialsSchema.safeParse({ firebase_app_id: "a" }).success,
    ).toBe(false);
  });

  it("rejects an empty api_secret", () => {
    expect(
      firebaseGa4Provider.credentialsSchema.safeParse({
        api_secret: "",
        firebase_app_id: "a",
      }).success,
    ).toBe(false);
  });
});
