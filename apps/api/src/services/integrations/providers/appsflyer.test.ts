import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { appsflyerProvider, formatAppsflyerEventTime } from "./appsflyer";
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
    subscriberAttributes: { $appsflyerId: "af-device-1", platform: "ios" },
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

interface AppsflyerWireBody {
  appsflyer_id: string;
  customer_user_id?: string;
  eventName: string;
  eventTime: string;
  eventCurrency?: string;
  eventValue: string;
}

interface AppsflyerPayloadBody {
  appId: string;
  wire: AppsflyerWireBody;
}

function wireOf(result: ReturnType<typeof appsflyerProvider.mapEvent>): AppsflyerWireBody {
  const payload = result as ProviderPayload;
  return (payload.body as AppsflyerPayloadBody).wire;
}

function eventValueOf(result: ReturnType<typeof appsflyerProvider.mapEvent>): Record<string, unknown> {
  return JSON.parse(wireOf(result).eventValue) as Record<string, unknown>;
}

const IOS_AND_ANDROID_CREDS = {
  dev_key: "dev-key-1",
  app_id_ios: "id123456789",
  app_id_android: "com.rovenue.app",
};

// ---------------------------------------------------------------------------
// mapEvent — mapping table
// ---------------------------------------------------------------------------

describe("appsflyerProvider.mapEvent", () => {
  it("maps RENEWAL -> af_subscription_renewal", () => {
    const result = appsflyerProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-renewal-1" }),
      makeConfig(),
      IOS_AND_ANDROID_CREDS,
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const wire = wireOf(result);
    expect(wire.eventName).toBe("af_subscription_renewal");
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    expect(payload.providerEvent).toBe("af_subscription_renewal");
  });

  it.each([
    ["revenue.INITIAL", "af_purchase"],
    ["revenue.TRIAL_CONVERSION", "af_subscribe"],
    ["revenue.CREDIT_PURCHASE", "af_credit_purchase"],
    ["revenue.REFUND", "af_refund"],
    ["revenue.CANCELLATION", "af_cancel"],
  ] as const)("maps %s -> %s", (kind, expected) => {
    const revenueKind = kind.split(".")[1] as RovenueEventEnvelope["revenueEventKind"];
    const result = appsflyerProvider.mapEvent(
      makeEnvelope({ revenueEventKind: revenueKind }),
      makeConfig(),
      IOS_AND_ANDROID_CREDS,
    );
    expect(result).not.toHaveProperty("skip");
    expect(wireOf(result).eventName).toBe(expected);
  });

  it.each([
    ["subscription.trial.started", "af_start_trial"],
    ["subscription.cancel_requested", "af_cancel_requested"],
    ["subscription.expired", "af_subscription_expired"],
    ["subscription.billing_issue", "af_billing_issue"],
    ["subscription.grace_period", "af_grace_period"],
    ["subscription.uncancelled", "af_uncancel"],
    ["subscription.product_changed", "af_product_change"],
  ] as const)("maps subscription eventType %s -> %s", (eventType, expected) => {
    const result = appsflyerProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      IOS_AND_ANDROID_CREDS,
    );
    expect(result).not.toHaveProperty("skip");
    expect(wireOf(result).eventName).toBe(expected);
  });

  it("skips unmapped event types with no_mapping", () => {
    const result = appsflyerProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      IOS_AND_ANDROID_CREDS,
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = appsflyerProvider.mapEvent(makeEnvelope(), config, IOS_AND_ANDROID_CREDS);
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      appsflyerProvider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  // -------------------------------------------------------------------------
  // Identity: $appsflyerId missing -> no_user_data
  // -------------------------------------------------------------------------

  describe("identity — $appsflyerId", () => {
    it("skips with no_user_data when $appsflyerId is absent", () => {
      const envelope = makeEnvelope({ subscriberAttributes: { platform: "ios" } });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(result).toEqual({ skip: true, reason: "no_user_data" });
    });

    it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
      const envelope = makeEnvelope({ subscriberAttributes: undefined });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(result).toEqual({ skip: true, reason: "no_user_data" });
    });

    it("uses $appsflyerId as appsflyer_id when present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-uid-42", platform: "ios" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(wireOf(result).appsflyer_id).toBe("af-uid-42");
    });

    it("carries customer_user_id from appUserId when present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {
          $appsflyerId: "af-uid-1",
          platform: "ios",
          appUserId: "app_user_7",
        },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(wireOf(result).customer_user_id).toBe("app_user_7");
    });

    it("omits customer_user_id when appUserId is absent", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-uid-1", platform: "ios" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(wireOf(result).customer_user_id).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // App-id selection decision matrix (§4.2)
  // -------------------------------------------------------------------------

  describe("app-id selection", () => {
    it("uses app_id_ios when platform=ios and both ids are configured (platform match)", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1", platform: "ios" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect((result as ProviderPayload & { body: AppsflyerPayloadBody }).body.appId).toBe(
        IOS_AND_ANDROID_CREDS.app_id_ios,
      );
    });

    it("uses app_id_android when platform=android and both ids are configured (platform match)", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1", platform: "android" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect((result as ProviderPayload & { body: AppsflyerPayloadBody }).body.appId).toBe(
        IOS_AND_ANDROID_CREDS.app_id_android,
      );
    });

    it("uses the single configured app id regardless of platform (ios-only creds, platform=android)", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1", platform: "android" },
      });
      const creds = { dev_key: "dk1", app_id_ios: "ios-app-id" };
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), creds);
      expect((result as ProviderPayload & { body: AppsflyerPayloadBody }).body.appId).toBe(
        "ios-app-id",
      );
    });

    it("uses the single configured app id regardless of platform (android-only creds, platform absent)", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1" },
      });
      const creds = { dev_key: "dk1", app_id_android: "android-app-id" };
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), creds);
      expect((result as ProviderPayload & { body: AppsflyerPayloadBody }).body.appId).toBe(
        "android-app-id",
      );
    });

    it("skips with no_platform_app_id when both ids configured and platform is absent", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(result).toEqual({ skip: true, reason: "no_platform_app_id" });
    });

    it("skips with no_platform_app_id when both ids configured and platform=web", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1", platform: "web" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(result).toEqual({ skip: true, reason: "no_platform_app_id" });
    });

    it("skips with no_platform_app_id when both ids configured and platform is an unknown value", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { $appsflyerId: "af-1", platform: "smart_tv" },
      });
      const result = appsflyerProvider.mapEvent(envelope, makeConfig(), IOS_AND_ANDROID_CREDS);
      expect(result).toEqual({ skip: true, reason: "no_platform_app_id" });
    });
  });

  // -------------------------------------------------------------------------
  // eventTime formatting
  // -------------------------------------------------------------------------

  describe("eventTime formatting", () => {
    it("formats occurredAt as 'yyyy-MM-dd HH:mm:ss.SSS' in UTC", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({ occurredAt: "2024-03-07T05:06:07.008Z" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      expect(wireOf(result).eventTime).toBe("2024-03-07 05:06:07.008");
    });

    it("zero-pads single-digit month/day/hour/minute/second", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({ occurredAt: "2024-01-02T03:04:05.000Z" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      expect(wireOf(result).eventTime).toBe("2024-01-02 03:04:05.000");
    });

    it("zero-pads milliseconds to 3 digits", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({ occurredAt: "2024-01-02T03:04:05.007Z" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      expect(wireOf(result).eventTime).toBe("2024-01-02 03:04:05.007");
    });
  });

  describe("formatAppsflyerEventTime (pure helper)", () => {
    it("formats a Date-parseable ISO string in UTC", () => {
      expect(formatAppsflyerEventTime("2024-12-31T23:59:59.999Z")).toBe(
        "2024-12-31 23:59:59.999",
      );
    });

    it("converts a non-UTC offset into UTC before formatting", () => {
      // 2024-06-01T00:00:00-05:00 === 2024-06-01T05:00:00Z
      expect(formatAppsflyerEventTime("2024-06-01T00:00:00-05:00")).toBe(
        "2024-06-01 05:00:00.000",
      );
    });
  });

  // -------------------------------------------------------------------------
  // eventValue JSON contents
  // -------------------------------------------------------------------------

  describe("eventValue JSON contents", () => {
    it("carries af_revenue/af_currency/af_order_id/product_id on a revenue.* event", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({
          revenueEventKind: "RENEWAL",
          amount: "19.99",
          currency: "EUR",
          outboxEventId: "ob-xyz",
          productId: "prod_gold",
        }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      const eventValue = eventValueOf(result);
      expect(eventValue.af_revenue).toBe(19.99);
      expect(eventValue.af_currency).toBe("EUR");
      expect(eventValue.af_order_id).toBe("ob-xyz");
      expect(eventValue.product_id).toBe("prod_gold");
    });

    it("sets top-level eventCurrency on a revenue.* event", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "RENEWAL", amount: "19.99", currency: "EUR" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      expect(wireOf(result).eventCurrency).toBe("EUR");
    });

    it("REFUND amount is sent POSITIVE (no documented AppsFlyer negative-value convention)", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      const eventValue = eventValueOf(result);
      expect(eventValue.af_revenue).toBe(5);
    });

    it("omits af_revenue/af_currency and top-level eventCurrency on a subscription lifecycle event", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({
          eventType: "subscription.trial.started",
          revenueEventKind: undefined,
          amount: undefined,
          currency: undefined,
        }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      const eventValue = eventValueOf(result);
      expect(eventValue.af_revenue).toBeUndefined();
      expect(eventValue.af_currency).toBeUndefined();
      expect(wireOf(result).eventCurrency).toBeUndefined();
    });

    it("still carries af_order_id and product_id on a subscription lifecycle event", () => {
      const result = appsflyerProvider.mapEvent(
        makeEnvelope({
          eventType: "subscription.trial.started",
          revenueEventKind: undefined,
          amount: undefined,
          outboxEventId: "ob-trial-1",
          productId: "prod_gold",
        }),
        makeConfig(),
        IOS_AND_ANDROID_CREDS,
      );
      const eventValue = eventValueOf(result);
      expect(eventValue.af_order_id).toBe("ob-trial-1");
      expect(eventValue.product_id).toBe("prod_gold");
    });
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — shape-only (no vendor probe endpoint)
// ---------------------------------------------------------------------------

describe("appsflyerProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("valid shape (dev_key + one app id) -> ok, with NO network call", async () => {
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.validateCredentials(IOS_AND_ANDROID_CREDS, http);
    expect(result).toEqual({ ok: true });
  });

  it("missing dev_key -> !ok", async () => {
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.validateCredentials(
      { app_id_ios: "id123" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("neither app id configured -> !ok (schema refine)", async () => {
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.validateCredentials(
      { dev_key: "dk1" },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

describe("appsflyerProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  function makePayload(appId = "id123456789"): ProviderPayload {
    return {
      eventKey: "revenue.RENEWAL",
      providerEvent: "af_subscription_renewal",
      body: {
        appId,
        wire: {
          appsflyer_id: "af-1",
          eventName: "af_subscription_renewal",
          eventTime: "2024-01-15 10:00:00.000",
          eventCurrency: "USD",
          eventValue: JSON.stringify({ af_revenue: 9.99, af_currency: "USD", af_order_id: "ob1", product_id: "prod_gold" }),
        },
      } satisfies AppsflyerPayloadBody,
    };
  }

  it("POSTs to https://api2.appsflyer.com/inappevent/{appId}", async () => {
    let observedPath: string | undefined;
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(observedPath).toBe("/inappevent/id123456789");
  });

  it("sends the 'authentication' header set to dev_key", async () => {
    let observedAuth: string | undefined;
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply((opts) => {
        const h = opts.headers;
        if (Array.isArray(h)) {
          for (let i = 0; i < h.length; i += 2) {
            if (String(h[i]).toLowerCase() === "authentication") {
              observedAuth = String(h[i + 1]);
            }
          }
        } else if (h && typeof h === "object") {
          observedAuth =
            (h as Record<string, string>)["authentication"] ??
            (h as Record<string, string>)["Authentication"];
        }
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(observedAuth).toBe(IOS_AND_ANDROID_CREDS.dev_key);
  });

  it("sends the wire body verbatim as JSON (no appId leaking into the body)", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    const payload = makePayload();
    await appsflyerProvider.deliver(payload, IOS_AND_ANDROID_CREDS, http);
    const sent = JSON.parse(observedBody ?? "{}") as Record<string, unknown>;
    expect(sent).toEqual((payload.body as AppsflyerPayloadBody).wire);
    expect(sent.appId).toBeUndefined();
  });

  it("200 -> ok + retriable:false", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(200, "");
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("400 -> !ok + retriable:false", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(400, '{"error":"invalid request"}');
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("401 -> !ok + retriable:false", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(401, "unauthorized");
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("403 -> !ok + retriable:false", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(403, "forbidden");
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(429, "too many requests");
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://api2.appsflyer.com")
      .intercept({ path: "/inappevent/id123456789", method: "POST" })
      .reply(500, "server error");
    const http = createUndiciHttpClient();
    const result = await appsflyerProvider.deliver(makePayload(), IOS_AND_ANDROID_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("appsflyerProvider.credentialsSchema", () => {
  it("accepts dev_key + app_id_ios only", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({
        dev_key: "dk1",
        app_id_ios: "ios-id",
      }).success,
    ).toBe(true);
  });

  it("accepts dev_key + app_id_android only", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({
        dev_key: "dk1",
        app_id_android: "com.rovenue.app",
      }).success,
    ).toBe(true);
  });

  it("accepts dev_key + both app ids", () => {
    expect(appsflyerProvider.credentialsSchema.safeParse(IOS_AND_ANDROID_CREDS).success).toBe(
      true,
    );
  });

  it("rejects an empty object", () => {
    expect(appsflyerProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects missing dev_key", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({ app_id_ios: "ios-id" }).success,
    ).toBe(false);
  });

  it("rejects dev_key with neither app id (refine)", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({ dev_key: "dk1" }).success,
    ).toBe(false);
  });

  it("rejects an empty dev_key", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({
        dev_key: "",
        app_id_ios: "ios-id",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty app_id_ios string (treated as not-configured, and no other id present)", () => {
    expect(
      appsflyerProvider.credentialsSchema.safeParse({
        dev_key: "dk1",
        app_id_ios: "",
      }).success,
    ).toBe(false);
  });
});
