import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { amplitudeProvider } from "./amplitude";
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
    subscriberAttributes: { $amplitudeUserId: "amp_user_1" },
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

type AmplitudeEventBody = {
  user_id: string;
  device_id?: string;
  event_type: string;
  time: number;
  insert_id: string;
  event_properties: { rovenue_event: string; product_id?: string };
  revenue?: number;
  price?: number;
  quantity?: number;
  revenueType?: string;
};

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("amplitudeProvider.mapEvent", () => {
  it("maps RENEWAL -> renewal with insert_id from outboxEventId", () => {
    const result = amplitudeProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-renewal-1" }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as AmplitudeEventBody;
    expect(body.event_type).toBe("renewal");
    expect(body.insert_id).toBe("ob-renewal-1");
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    expect(payload.providerEvent).toBe("renewal");
  });

  it.each([
    ["revenue.INITIAL", "RENEWAL_OVERRIDE_UNUSED", "purchase_initial"],
    ["revenue.TRIAL_CONVERSION", undefined, "trial_conversion"],
    ["revenue.CREDIT_PURCHASE", undefined, "credit_purchase"],
    ["revenue.REFUND", undefined, "refund"],
    ["revenue.CANCELLATION", undefined, "cancellation"],
  ] as const)("maps %s -> %s", (kind, _unused, expected) => {
    const revenueKind = kind.split(".")[1] as RovenueEventEnvelope["revenueEventKind"];
    const result = amplitudeProvider.mapEvent(
      makeEnvelope({ revenueEventKind: revenueKind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as AmplitudeEventBody;
    expect(body.event_type).toBe(expected);
  });

  it.each([
    ["subscription.trial.started", "trial_started"],
    ["subscription.cancel_requested", "cancel_requested"],
    ["subscription.expired", "subscription_expired"],
    ["subscription.billing_issue", "billing_issue"],
    ["subscription.grace_period", "grace_period"],
    ["subscription.uncancelled", "uncancelled"],
    ["subscription.product_changed", "product_changed"],
  ] as const)("maps subscription eventType %s -> %s", (eventType, expected) => {
    const result = amplitudeProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as AmplitudeEventBody;
    expect(body.event_type).toBe(expected);
  });

  it("skips unmapped event types with no_mapping", () => {
    const result = amplitudeProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = amplitudeProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips with no_user_data when no identity is resolvable", () => {
    const envelope = makeEnvelope({
      subscriberAttributes: {},
      subscriberId: undefined,
    });
    const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      amplitudeProvider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        {},
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  // -------------------------------------------------------------------------
  // Identity fallback chain: $amplitudeUserId ?? appUserId ?? subscriberId
  // -------------------------------------------------------------------------

  describe("identity fallback chain", () => {
    it("prefers $amplitudeUserId when present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {
          $amplitudeUserId: "amp_id",
          appUserId: "app_id",
        },
        subscriberId: "sub_id",
      });
      const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.user_id).toBe("amp_id");
    });

    it("falls back to appUserId when $amplitudeUserId is absent", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { appUserId: "app_id" },
        subscriberId: "sub_id",
      });
      const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.user_id).toBe("app_id");
    });

    it("falls back to subscriberId when neither attribute is present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {},
        subscriberId: "sub_id",
      });
      const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.user_id).toBe("sub_id");
    });

    it("sets device_id from $amplitudeDeviceId when present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {
          $amplitudeUserId: "amp_id",
          $amplitudeDeviceId: "device_1",
        },
      });
      const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.device_id).toBe("device_1");
    });

    it("omits device_id when $amplitudeDeviceId is absent", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $amplitudeUserId: "amp_id" },
      });
      const result = amplitudeProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.device_id).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Revenue fields
  // -------------------------------------------------------------------------

  describe("revenue fields", () => {
    it("sets revenue/price/quantity/revenueType on a revenue.* event", () => {
      const result = amplitudeProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "RENEWAL", amount: "19.99", currency: "EUR" }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as AmplitudeEventBody & {
        currency?: string;
      };
      expect(body.revenue).toBe(19.99);
      expect(body.price).toBe(19.99);
      expect(body.quantity).toBe(1);
      expect(body.revenueType).toBe("revenue.RENEWAL");
      expect(body.currency).toBe("EUR");
    });

    it("stores REFUND revenue/price as NEGATIVE per Amplitude convention", () => {
      const result = amplitudeProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.revenue).toBe(-5);
      expect(body.price).toBe(-5);
    });

    it("does NOT set revenue fields on a subscription lifecycle event", () => {
      const result = amplitudeProvider.mapEvent(
        makeEnvelope({
          eventType: "subscription.trial.started",
          revenueEventKind: undefined,
          amount: undefined,
        }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.revenue).toBeUndefined();
      expect(body.price).toBeUndefined();
      expect(body.revenueType).toBeUndefined();
    });

    it("event_properties always carries rovenue_event and product_id", () => {
      const result = amplitudeProvider.mapEvent(makeEnvelope(), makeConfig(), {});
      const body = (result as ProviderPayload).body as AmplitudeEventBody;
      expect(body.event_properties.rovenue_event).toBe("revenue.RENEWAL");
      expect(body.event_properties.product_id).toBe("prod_gold");
    });
  });
});

// ---------------------------------------------------------------------------
// validateCredentials + deliver
// ---------------------------------------------------------------------------

describe("amplitudeProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("200 -> ok", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(200, '{"code":200,"events_ingested":1}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.validateCredentials(
      { api_key: "good_key" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("400 invalid api key -> !ok", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(400, '{"code":400,"error":"Invalid API key"}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.validateCredentials(
      { api_key: "bad_key" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("uses the EU endpoint when region=eu", async () => {
    agent
      .get("https://api.eu.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(200, '{"code":200}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.validateCredentials(
      { api_key: "good_key", region: "eu" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("amplitudeProvider.deliver", () => {
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
    body: { user_id: "u1", event_type: "renewal", time: 1, insert_id: "ob1" },
  };

  it("200 -> ok + retriable:false", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(200, '{"code":200,"events_ingested":1}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.deliver(dummyPayload, { api_key: "k" }, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("400 invalid_api_key -> !ok + retriable:false", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(400, '{"code":400,"error":"Invalid API key"}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.deliver(dummyPayload, { api_key: "bad" }, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("413 -> !ok + retriable:true", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(413, '{"code":413,"error":"Payload too large"}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.deliver(dummyPayload, { api_key: "k" }, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(429, '{"code":429,"error":"Too many requests"}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.deliver(dummyPayload, { api_key: "k" }, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply(500, '{"error":"server_error"}');
    const http = createUndiciHttpClient();
    const result = await amplitudeProvider.deliver(dummyPayload, { api_key: "k" }, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("outgoing body wraps the event in { api_key, events: [event] } with insert_id preserved", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://api2.amplitude.com")
      .intercept({ path: "/2/httpapi", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: '{"code":200}' };
      });
    const http = createUndiciHttpClient();
    await amplitudeProvider.deliver(dummyPayload, { api_key: "my_key" }, http);

    const sent = JSON.parse(observedBody ?? "{}") as {
      api_key: string;
      events: Array<{ insert_id: string }>;
    };
    expect(sent.api_key).toBe("my_key");
    expect(sent.events[0]!.insert_id).toBe("ob1");
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("amplitudeProvider.credentialsSchema", () => {
  it("accepts api_key alone", () => {
    expect(
      amplitudeProvider.credentialsSchema.safeParse({ api_key: "k" }).success,
    ).toBe(true);
  });

  it("accepts api_key + region us/eu", () => {
    expect(
      amplitudeProvider.credentialsSchema.safeParse({ api_key: "k", region: "us" })
        .success,
    ).toBe(true);
    expect(
      amplitudeProvider.credentialsSchema.safeParse({ api_key: "k", region: "eu" })
        .success,
    ).toBe(true);
  });

  it("rejects an empty object (missing api_key)", () => {
    expect(amplitudeProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty api_key", () => {
    expect(
      amplitudeProvider.credentialsSchema.safeParse({ api_key: "" }).success,
    ).toBe(false);
  });

  it("rejects an invalid region", () => {
    expect(
      amplitudeProvider.credentialsSchema.safeParse({ api_key: "k", region: "asia" })
        .success,
    ).toBe(false);
  });
});
