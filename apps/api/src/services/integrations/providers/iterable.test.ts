import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { iterableProvider } from "./iterable";
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
    subscriberAttributes: { $iterableUserId: "it_user_1" },
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

interface IterableTrackPurchaseBody {
  user: { userId?: string; email?: string };
  items: Array<{ id: string; name: string; price: number; quantity: number }>;
  total: number;
  createdAt: number;
  id: string;
}

interface IterableEventsTrackBody {
  userId?: string;
  email?: string;
  eventName: string;
  id: string;
  createdAt: number;
  dataFields: { rovenue_event: string; product_id?: string };
}

/** MockAgent/undici header casing isn't guaranteed stable across versions —
 *  read case-insensitively, same defensive pattern as tiktok-events.test.ts. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// mapEvent — revenue.* -> commerce/trackPurchase
// ---------------------------------------------------------------------------

describe("iterableProvider.mapEvent — revenue.* -> trackPurchase", () => {
  it.each([
    ["INITIAL", "revenue.INITIAL"],
    ["TRIAL_CONVERSION", "revenue.TRIAL_CONVERSION"],
    ["RENEWAL", "revenue.RENEWAL"],
    ["CREDIT_PURCHASE", "revenue.CREDIT_PURCHASE"],
    ["CANCELLATION", "revenue.CANCELLATION"],
  ] as const)("maps revenueEventKind %s to a trackPurchase body (%s)", (kind, expectedKey) => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ revenueEventKind: kind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(expectedKey);
    const body = payload.body as IterableTrackPurchaseBody;
    expect(body.user).toEqual({ userId: "it_user_1" });
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.id).toBe("prod_gold");
    expect(item.name).toBe("prod_gold");
    expect(item.price).toBe(9.99);
    expect(item.quantity).toBe(1);
    expect(body.total).toBe(9.99);
    expect(body.createdAt).toBe(Date.parse("2024-01-15T10:00:00.000Z"));
    expect(body.id).toBe("ob1");
  });

  it("REFUND is skipped with no_mapping (no documented Iterable trackPurchase reversal convention)", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("defaults item id to 'unknown' and item name to the mapped provider event when productId is absent", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ productId: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.items[0]!.id).toBe("unknown");
    expect(body.items[0]!.name).toBe((result as ProviderPayload).providerEvent);
  });

  it("defaults price/total to 0 when amount is absent/unparseable (trackPurchase requires a numeric total)", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ amount: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.items[0]!.price).toBe(0);
    expect(body.total).toBe(0);

    const resultBadAmount = iterableProvider.mapEvent(
      makeEnvelope({ amount: "not-a-number" }),
      makeConfig(),
      {},
    );
    const bodyBadAmount = (resultBadAmount as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(bodyBadAmount.total).toBe(0);
  });

  it("CROSS-PROVIDER CURRENCY RULING: total is populated from amount even when currency is absent, and currency is never sent (trackPurchase has no currency field)", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ amount: "9.99", currency: undefined }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as unknown as Record<string, unknown>;
    expect(body.total).toBe(9.99);
    expect(body).not.toHaveProperty("currency");
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty("currency");
  });
});

// ---------------------------------------------------------------------------
// mapEvent — subscription.* -> events/track
// ---------------------------------------------------------------------------

describe("iterableProvider.mapEvent — subscription.* -> events/track", () => {
  it.each([
    ["subscription.trial.started", "rovenue_subscription_trial_started"],
    ["subscription.cancel_requested", "rovenue_subscription_cancel_requested"],
    ["subscription.expired", "rovenue_subscription_expired"],
    ["subscription.billing_issue", "rovenue_subscription_billing_issue"],
    ["subscription.grace_period", "rovenue_subscription_grace_period"],
    ["subscription.uncancelled", "rovenue_subscription_uncancelled"],
    ["subscription.product_changed", "rovenue_subscription_product_changed"],
  ] as const)("maps eventType %s -> Iterable custom event %s", (eventType, expectedName) => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(eventType);
    expect(payload.providerEvent).toBe(expectedName);
    const body = payload.body as IterableEventsTrackBody;
    expect(body.userId).toBe("it_user_1");
    expect(body.email).toBeUndefined();
    expect(body.eventName).toBe(expectedName);
    expect(body.id).toBe("ob1");
    expect(body.createdAt).toBe(Date.parse("2024-01-15T10:00:00.000Z"));
    expect(body.dataFields.rovenue_event).toBe(eventType);
  });

  it("carries product_id in dataFields when productId is present, omits it otherwise", () => {
    const withProduct = iterableProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
        productId: "prod_gold",
      }),
      makeConfig(),
      {},
    );
    expect(
      ((withProduct as ProviderPayload).body as IterableEventsTrackBody).dataFields.product_id,
    ).toBe("prod_gold");

    const withoutProduct = iterableProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
        productId: undefined,
      }),
      makeConfig(),
      {},
    );
    expect(
      ((withoutProduct as ProviderPayload).body as IterableEventsTrackBody).dataFields,
    ).not.toHaveProperty("product_id");
  });
});

// ---------------------------------------------------------------------------
// mapEvent — identity resolution
// ---------------------------------------------------------------------------

describe("iterableProvider.mapEvent — identity resolution", () => {
  it("uses userId = subscriberAttributes.$iterableUserId when present", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: { $iterableUserId: "it_42" } }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.user).toEqual({ userId: "it_42" });
  });

  it("falls back to email = enriched identityContext.email when $iterableUserId is absent", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {},
        identityContext: { email: "user@example.com" },
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.user).toEqual({ email: "user@example.com" });
  });

  it("falls back to email = subscriberAttributes.$email when neither $iterableUserId nor identityContext.email is present", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { $email: "raw@example.com" },
        identityContext: undefined,
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.user).toEqual({ email: "raw@example.com" });
  });

  it("prefers $iterableUserId over identityContext.email when both are present", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { $iterableUserId: "it_42" },
        identityContext: { email: "user@example.com" },
      }),
      makeConfig(),
      {},
    );
    const body = (result as ProviderPayload).body as IterableTrackPurchaseBody;
    expect(body.user).toEqual({ userId: "it_42" });
  });

  it("skips with no_user_data when no identity is resolvable at all (no subscriberId fallback)", () => {
    const result = iterableProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {},
        identityContext: undefined,
        subscriberId: "sub_should_not_be_used",
      }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — scope / idempotency
// ---------------------------------------------------------------------------

describe("iterableProvider.mapEvent — scope and idempotency", () => {
  it("throws when outboxEventId is empty", () => {
    expect(() =>
      iterableProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), {}),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = iterableProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      config,
      {},
    );
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips unmapped envelope eventTypes with no_mapping", () => {
    const result = iterableProvider.mapEvent(
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

describe("iterableProvider.credentialsSchema", () => {
  it("accepts api_key alone (region optional)", () => {
    expect(
      iterableProvider.credentialsSchema.safeParse({ api_key: "k" }).success,
    ).toBe(true);
  });

  it("accepts api_key + region us/eu", () => {
    expect(
      iterableProvider.credentialsSchema.safeParse({ api_key: "k", region: "us" }).success,
    ).toBe(true);
    expect(
      iterableProvider.credentialsSchema.safeParse({ api_key: "k", region: "eu" }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(iterableProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty api_key", () => {
    expect(
      iterableProvider.credentialsSchema.safeParse({ api_key: "" }).success,
    ).toBe(false);
  });

  it("rejects an invalid region value", () => {
    expect(
      iterableProvider.credentialsSchema.safeParse({ api_key: "k", region: "apac" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — real zero-footprint GET /api/lists
// ---------------------------------------------------------------------------

describe("iterableProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("2xx -> ok, GETs /api/lists with Api-Key header (US default)", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    agent
      .get("https://api.iterable.com")
      .intercept({ path: "/api/lists", method: "GET" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        return { statusCode: 200, data: '{"lists":[]}' };
      });
    const http = createUndiciHttpClient();
    const result = await iterableProvider.validateCredentials({ api_key: "good_key" }, http);
    expect(result).toEqual({ ok: true });
    expect(header(observedHeaders, "Api-Key")).toBe("good_key");
    expect(observedPath).toBe("/api/lists");
  });

  it("routes to api.eu.iterable.com when region=eu", async () => {
    agent
      .get("https://api.eu.iterable.com")
      .intercept({ path: "/api/lists", method: "GET" })
      .reply(200, '{"lists":[]}');
    const http = createUndiciHttpClient();
    const result = await iterableProvider.validateCredentials(
      { api_key: "k", region: "eu" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("401 -> !ok", async () => {
    agent
      .get("https://api.iterable.com")
      .intercept({ path: "/api/lists", method: "GET" })
      .reply(401, "");
    const http = createUndiciHttpClient();
    const result = await iterableProvider.validateCredentials({ api_key: "bad_key" }, http);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix + routing
// ---------------------------------------------------------------------------

describe("iterableProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  const purchasePayload: ProviderPayload = {
    eventKey: "revenue.RENEWAL",
    providerEvent: "renewal",
    body: {
      user: { userId: "it_user_1" },
      items: [{ id: "prod_gold", name: "prod_gold", price: 9.99, quantity: 1 }],
      total: 9.99,
      createdAt: 1705312800000,
      id: "ob1",
    },
  };

  const eventPayload: ProviderPayload = {
    eventKey: "subscription.trial.started",
    providerEvent: "rovenue_subscription_trial_started",
    body: {
      userId: "it_user_1",
      eventName: "rovenue_subscription_trial_started",
      id: "ob1",
      createdAt: 1705312800000,
      dataFields: { rovenue_event: "subscription.trial.started" },
    },
  };

  it.each([
    [200, true, false],
    [201, false, false],
    [400, false, false],
    [401, false, false],
    [403, false, false],
    [429, false, true],
    [500, false, true],
    [503, false, true],
  ] as const)("http %s -> ok:%s retriable:%s", async (status, ok, retriable) => {
    agent
      .get("https://api.iterable.com")
      .intercept({ path: "/api/commerce/trackPurchase", method: "POST" })
      .reply(status, '{"code":"result"}');
    const http = createUndiciHttpClient();
    const result = await iterableProvider.deliver(purchasePayload, { api_key: "k" }, http);
    expect(result.ok).toBe(ok);
    expect(result.retriable).toBe(retriable);
    expect(result.httpStatus).toBe(status);
  });

  it("routes revenue.* payloads to POST /api/commerce/trackPurchase with the Api-Key header", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    agent
      .get("https://api.iterable.com")
      .intercept({ path: "/api/commerce/trackPurchase", method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        return { statusCode: 200, data: "{}" };
      });
    const http = createUndiciHttpClient();
    await iterableProvider.deliver(purchasePayload, { api_key: "my_key" }, http);
    expect(header(observedHeaders, "Api-Key")).toBe("my_key");
    expect(observedPath).toBe("/api/commerce/trackPurchase");
  });

  it("routes subscription.* payloads to POST /api/events/track", async () => {
    let observedPath = "";
    agent
      .get("https://api.iterable.com")
      .intercept({ path: "/api/events/track", method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        return { statusCode: 200, data: "{}" };
      });
    const http = createUndiciHttpClient();
    const result = await iterableProvider.deliver(eventPayload, { api_key: "k" }, http);
    expect(observedPath).toBe("/api/events/track");
    expect(result.ok).toBe(true);
  });

  it("routes to api.eu.iterable.com when region=eu", async () => {
    agent
      .get("https://api.eu.iterable.com")
      .intercept({ path: "/api/commerce/trackPurchase", method: "POST" })
      .reply(200, "{}");
    const http = createUndiciHttpClient();
    const result = await iterableProvider.deliver(
      purchasePayload,
      { api_key: "k", region: "eu" },
      http,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

describe("iterableProvider static config", () => {
  it("id is ITERABLE", () => {
    expect(iterableProvider.id).toBe("ITERABLE");
  });

  it("topics are revenue + subscription only", () => {
    expect(iterableProvider.topics).toEqual(["rovenue.revenue", "rovenue.subscription"]);
  });

  it("allowMultipleConnections is false", () => {
    expect(iterableProvider.allowMultipleConnections).toBe(false);
  });

  it("has no retryPolicy of its own (falls through to DEFAULT_RETRY_POLICY)", () => {
    expect(iterableProvider.retryPolicy).toBeUndefined();
  });

  it("eventCatalog is the 13-key STANDARD_PROVIDER_EVENT_KEYS set", () => {
    expect(iterableProvider.eventCatalog).toHaveLength(13);
    expect(iterableProvider.eventCatalog).toContain("revenue.REFUND");
    expect(iterableProvider.eventCatalog).toContain("subscription.trial.started");
  });

  it("defaultEventMapping omits revenue.REFUND but maps every other catalog key", () => {
    expect(iterableProvider.defaultEventMapping["revenue.REFUND"]).toBeUndefined();
    for (const key of iterableProvider.eventCatalog) {
      if (key === "revenue.REFUND") continue;
      expect(iterableProvider.defaultEventMapping[key]).toBeTruthy();
    }
  });
});
