import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import {
  brazeProvider,
  isAllowedBrazeEndpoint,
  BRAZE_ENDPOINT_HOST_RE,
  BRAZE_VALIDATION_EXTERNAL_ID,
} from "./braze";
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

const VALID_ENDPOINT = "https://rest.iad-01.braze.com";

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
    subscriberAttributes: { appUserId: "app_user_1" },
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

type BrazeIdentityFields = {
  external_id?: string;
  user_alias?: { alias_name: string; alias_label: string };
};

type BrazePurchase = BrazeIdentityFields & {
  product_id: string;
  currency?: string;
  price: number;
  time: string;
  properties: { rovenue_event: string; outbox_event_id: string };
};

type BrazeEvent = BrazeIdentityFields & {
  name: string;
  time: string;
  properties: { rovenue_event: string; outbox_event_id: string };
};

type BrazePurchaseBody = { purchases: BrazePurchase[] };
type BrazeEventBody = { events: BrazeEvent[] };

// ---------------------------------------------------------------------------
// mapEvent — revenue.* -> purchases
// ---------------------------------------------------------------------------

describe("brazeProvider.mapEvent — revenue.* -> purchases", () => {
  it.each([
    ["INITIAL", "revenue.INITIAL"],
    ["TRIAL_CONVERSION", "revenue.TRIAL_CONVERSION"],
    ["RENEWAL", "revenue.RENEWAL"],
    ["CREDIT_PURCHASE", "revenue.CREDIT_PURCHASE"],
    ["CANCELLATION", "revenue.CANCELLATION"],
  ] as const)("maps revenueEventKind %s to a purchases entry (%s)", (kind, expectedKey) => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: kind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(expectedKey);
    const body = payload.body as BrazePurchaseBody;
    expect(body.purchases).toHaveLength(1);
    const purchase = body.purchases[0]!;
    expect(purchase.product_id).toBe("prod_gold");
    expect(purchase.currency).toBe("USD");
    expect(purchase.price).toBe(9.99);
    expect(purchase.time).toBe(new Date("2024-01-15T10:00:00.000Z").toISOString());
    expect(purchase.properties).toEqual({
      rovenue_event: expectedKey,
      outbox_event_id: "ob1",
    });
  });

  it("REFUND is skipped with no_mapping (no documented Braze refund/reversal convention on purchases)", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("defaults product_id to 'unknown' when productId is absent", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ productId: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.product_id).toBe("unknown");
  });

  it("defaults currency to USD when absent (Braze requires currency on a purchase object)", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ currency: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.currency).toBe("USD");
  });

  it("defaults price to 0 when amount is absent/unparseable (Braze requires price on a purchase object)", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ amount: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.price).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapEvent — subscription.* -> events (rovenue_<suffix> custom events)
// ---------------------------------------------------------------------------

describe("brazeProvider.mapEvent — subscription.* -> events", () => {
  it.each([
    ["subscription.trial.started", "rovenue_subscription_trial_started"],
    ["subscription.cancel_requested", "rovenue_subscription_cancel_requested"],
    ["subscription.expired", "rovenue_subscription_expired"],
    ["subscription.billing_issue", "rovenue_subscription_billing_issue"],
    ["subscription.grace_period", "rovenue_subscription_grace_period"],
    ["subscription.uncancelled", "rovenue_subscription_uncancelled"],
    ["subscription.product_changed", "rovenue_subscription_product_changed"],
  ] as const)("maps eventType %s -> Braze custom event %s", (eventType, expectedName) => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(eventType);
    expect(payload.providerEvent).toBe(expectedName);
    const body = payload.body as BrazeEventBody;
    expect(body.events).toHaveLength(1);
    const event = body.events[0]!;
    expect(event.name).toBe(expectedName);
    expect(event.time).toBe(new Date("2024-01-15T10:00:00.000Z").toISOString());
    expect(event.properties).toEqual({
      rovenue_event: eventType,
      outbox_event_id: "ob1",
    });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — identity resolution
// ---------------------------------------------------------------------------

describe("brazeProvider.mapEvent — identity resolution", () => {
  it("uses external_id = appUserId when present", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { appUserId: "app_1", $brazeAliasName: "alias_1" },
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.external_id).toBe("app_1");
    expect(body.purchases[0]!.user_alias).toBeUndefined();
  });

  it("uses user_alias {alias_name, alias_label: 'rovenue'} INSTEAD of external_id when appUserId is absent and $brazeAliasName is present", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { $brazeAliasName: "alias_only" },
        subscriberId: "sub_should_not_be_used",
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.external_id).toBeUndefined();
    expect(body.purchases[0]!.user_alias).toEqual({
      alias_name: "alias_only",
      alias_label: "rovenue",
    });
  });

  it("falls back to external_id = subscriberId when neither appUserId nor $brazeAliasName is present", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: {}, subscriberId: "sub_fallback" }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as BrazePurchaseBody;
    expect(body.purchases[0]!.external_id).toBe("sub_fallback");
  });

  it("skips with no_user_data when no identity is resolvable at all", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: {}, subscriberId: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — scope / idempotency
// ---------------------------------------------------------------------------

describe("brazeProvider.mapEvent — scope and idempotency", () => {
  it("throws when outboxEventId is empty", () => {
    expect(() =>
      brazeProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), {}),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = brazeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      config,
      {},
    );
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips unmapped envelope eventTypes with no_mapping", () => {
    const result = brazeProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema + host allowlist
// ---------------------------------------------------------------------------

describe("brazeProvider.credentialsSchema", () => {
  it("accepts a valid .com rest_endpoint", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: VALID_ENDPOINT,
      }).success,
    ).toBe(true);
  });

  it("accepts a valid .eu rest_endpoint", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "https://rest.fra-02.braze.eu",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(brazeProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty rest_api_key", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "",
        rest_endpoint: VALID_ENDPOINT,
      }).success,
    ).toBe(false);
  });

  it("rejects http:// (non-https)", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "http://rest.iad-01.braze.com",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong TLD/host", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "https://rest.iad-01.braze.io",
      }).success,
    ).toBe(false);
  });

  it("rejects the rest.iad-01.braze.com.evil.example bypass attempt", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "https://rest.iad-01.braze.com.evil.example",
      }).success,
    ).toBe(false);
  });

  it("rejects a host missing the rest. prefix", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "https://iad-01.braze.com",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL string", () => {
    expect(
      brazeProvider.credentialsSchema.safeParse({
        rest_api_key: "k",
        rest_endpoint: "not a url",
      }).success,
    ).toBe(false);
  });
});

describe("isAllowedBrazeEndpoint / BRAZE_ENDPOINT_HOST_RE — allowlist matrix", () => {
  it("BRAZE_ENDPOINT_HOST_RE matches documented cluster host shapes", () => {
    expect(BRAZE_ENDPOINT_HOST_RE.test("rest.iad-01.braze.com")).toBe(true);
    expect(BRAZE_ENDPOINT_HOST_RE.test("rest.fra-02.braze.eu")).toBe(true);
  });

  it("BRAZE_ENDPOINT_HOST_RE rejects a suffix-bypass host", () => {
    expect(BRAZE_ENDPOINT_HOST_RE.test("rest.iad-01.braze.com.evil.example")).toBe(false);
  });

  it.each([
    ["https://rest.iad-01.braze.com", true],
    ["https://rest.fra-02.braze.eu", true],
    ["http://rest.iad-01.braze.com", false],
    ["https://rest.iad-01.braze.com.evil.example", false],
    ["https://evil.example/rest.iad-01.braze.com", false],
    ["https://iad-01.braze.com", false],
    ["https://rest..braze.com", false],
    ["https://rest.iad-01.braze.io", false],
    ["not a url", false],
  ] as const)("isAllowedBrazeEndpoint(%s) -> %s", (value, expected) => {
    expect(isAllowedBrazeEndpoint(value)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials
// ---------------------------------------------------------------------------

describe("brazeProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("2xx -> ok, probes users/track with the fixed validation external_id + Bearer auth", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedBody = "";
    agent
      .get("https://rest.iad-01.braze.com")
      .intercept({ path: "/users/track", method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedBody = opts.body as string;
        return { statusCode: 201, data: '{"message":"success"}' };
      });
    const http = createUndiciHttpClient();
    const result = await brazeProvider.validateCredentials(
      { rest_api_key: "good_key", rest_endpoint: VALID_ENDPOINT },
      http,
    );
    expect(result).toEqual({ ok: true });
    expect(observedHeaders["authorization"]).toBe("Bearer good_key");
    const sent = JSON.parse(observedBody) as { events: Array<{ external_id: string }> };
    expect(sent.events[0]!.external_id).toBe(BRAZE_VALIDATION_EXTERNAL_ID);
  });

  it("401 -> !ok", async () => {
    agent
      .get("https://rest.iad-01.braze.com")
      .intercept({ path: "/users/track", method: "POST" })
      .reply(401, '{"message":"invalid_api_key"}');
    const http = createUndiciHttpClient();
    const result = await brazeProvider.validateCredentials(
      { rest_api_key: "bad_key", rest_endpoint: VALID_ENDPOINT },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a disallowed rest_endpoint without making a network call", async () => {
    const http = createUndiciHttpClient();
    const result = await brazeProvider.validateCredentials(
      { rest_api_key: "k", rest_endpoint: "https://evil.example.com" },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix
// ---------------------------------------------------------------------------

describe("brazeProvider.deliver", () => {
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
    providerEvent: "revenue.RENEWAL",
    body: {
      purchases: [
        {
          external_id: "u1",
          product_id: "prod_gold",
          currency: "USD",
          price: 9.99,
          time: "2024-01-15T10:00:00.000Z",
          properties: { rovenue_event: "revenue.RENEWAL", outbox_event_id: "ob1" },
        },
      ],
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
      .get("https://rest.iad-01.braze.com")
      .intercept({ path: "/users/track", method: "POST" })
      .reply(status, '{"message":"result"}');
    const http = createUndiciHttpClient();
    const result = await brazeProvider.deliver(
      dummyPayload,
      { rest_api_key: "k", rest_endpoint: VALID_ENDPOINT },
      http,
    );
    expect(result.ok).toBe(ok);
    expect(result.retriable).toBe(retriable);
    expect(result.httpStatus).toBe(status);
  });

  it("sends Authorization: Bearer <rest_api_key> to {rest_endpoint}/users/track", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    agent
      .get("https://rest.iad-01.braze.com")
      .intercept({ path: "/users/track", method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        return { statusCode: 201, data: '{"message":"success"}' };
      });
    const http = createUndiciHttpClient();
    await brazeProvider.deliver(
      dummyPayload,
      { rest_api_key: "my_key", rest_endpoint: VALID_ENDPOINT },
      http,
    );
    expect(observedHeaders["authorization"]).toBe("Bearer my_key");
    expect(observedPath).toBe("/users/track");
  });

  it("re-checks the host allowlist at delivery time and never calls the network on a mutated bad endpoint", async () => {
    const http = createUndiciHttpClient();
    const result = await brazeProvider.deliver(
      dummyPayload,
      { rest_api_key: "k", rest_endpoint: "https://evil.example.com" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

describe("brazeProvider static config", () => {
  it("id is BRAZE", () => {
    expect(brazeProvider.id).toBe("BRAZE");
  });

  it("topics are revenue + subscription only", () => {
    expect(brazeProvider.topics).toEqual(["rovenue.revenue", "rovenue.subscription"]);
  });

  it("allowMultipleConnections is false", () => {
    expect(brazeProvider.allowMultipleConnections).toBe(false);
  });

  it("eventCatalog is the 13-key STANDARD_PROVIDER_EVENT_KEYS set", () => {
    expect(brazeProvider.eventCatalog).toHaveLength(13);
    expect(brazeProvider.eventCatalog).toContain("revenue.REFUND");
    expect(brazeProvider.eventCatalog).toContain("subscription.trial.started");
  });

  it("defaultEventMapping omits revenue.REFUND", () => {
    expect(brazeProvider.defaultEventMapping["revenue.REFUND"]).toBeUndefined();
  });
});
