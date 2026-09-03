import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { STANDARD_PROVIDER_EVENT_KEYS } from "@rovenue/shared";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { singularProvider } from "./singular";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
  DeliveryResult,
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

const SDK_KEY = "sdk_key_abc123SECRET";
const APP_ID = "com.example.app";

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
    subscriberAttributes: { $idfa: "DFC5A647-9043-4699-B2A5-76F03A97064B" },
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

interface SingularPayloadBody {
  endpoint: string;
  fields: Record<string, string>;
}

const V1_ENDPOINT = "https://s2s.singular.net/api/v1/evt";
const V2_ENDPOINT = "https://s2s.singular.net/api/v2/evt";

// ---------------------------------------------------------------------------
// mapEvent — revenue.*
// ---------------------------------------------------------------------------

describe("singularProvider.mapEvent — revenue.*", () => {
  it.each([
    ["INITIAL", "revenue.INITIAL", "sng_subscribe"],
    ["TRIAL_CONVERSION", "revenue.TRIAL_CONVERSION", "sng_subscribe"],
    ["RENEWAL", "revenue.RENEWAL", "sng_ecommerce_purchase"],
    ["CREDIT_PURCHASE", "revenue.CREDIT_PURCHASE", "sng_ecommerce_purchase"],
    ["CANCELLATION", "revenue.CANCELLATION", "rovenue_cancellation"],
  ] as const)("maps revenueEventKind %s to %s (n=%s)", (kind, expectedKey, expectedName) => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ revenueEventKind: kind }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(expectedKey);
    expect(payload.providerEvent).toBe(expectedName);
    const body = payload.body as SingularPayloadBody;
    expect(body.fields.n).toBe(expectedName);
    expect(body.fields.idfa).toBe("DFC5A647-9043-4699-B2A5-76F03A97064B");
    expect(body.fields.p).toBe("iOS");
    expect(body.fields.is_revenue_event).toBe("true");
    expect(body.fields.amt).toBe("9.99");
    expect(body.fields.cur).toBe("USD");
  });

  it("REFUND is intentionally unmapped (no_mapping) — no vendor reversal convention documented", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "REFUND" }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("omits amt/cur (never fabricates a currency) when amount is present but currency is absent", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ amount: "9.99", currency: undefined }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.amt).toBeUndefined();
    expect(body.fields.cur).toBeUndefined();
    // still marked as a revenue event with no amount, per the vendor's own
    // documented convention.
    expect(body.fields.is_revenue_event).toBe("true");
    expect(result).not.toHaveProperty("skip");
  });

  it("omits amt/cur when currency is present but amount is absent", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ amount: undefined, currency: "USD" }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.amt).toBeUndefined();
    expect(body.fields.cur).toBeUndefined();
  });

  it("omits amt/cur when amount is unparseable", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ amount: "not-a-number", currency: "USD" }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.amt).toBeUndefined();
    expect(body.fields.cur).toBeUndefined();
  });

  it("does not carry is_revenue_event/amt/cur on subscription.* (non-revenue) events", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.is_revenue_event).toBeUndefined();
    expect(body.fields.amt).toBeUndefined();
    expect(body.fields.cur).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapEvent — subscription.* -> vendor / custom event names
// ---------------------------------------------------------------------------

describe("singularProvider.mapEvent — subscription.*", () => {
  it("maps subscription.trial.started to the vendor's real sng_start_trial standard event", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).not.toHaveProperty("skip");
    expect((result as ProviderPayload).providerEvent).toBe("sng_start_trial");
  });

  it.each([
    ["subscription.cancel_requested", "rovenue_cancel_requested"],
    ["subscription.expired", "rovenue_expired"],
    ["subscription.billing_issue", "rovenue_billing_issue"],
    ["subscription.grace_period", "rovenue_grace_period"],
    ["subscription.uncancelled", "rovenue_uncancelled"],
    ["subscription.product_changed", "rovenue_product_changed"],
  ] as const)("maps eventType %s to the custom event name %s", (eventType, expectedName) => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe(eventType);
    expect(payload.providerEvent).toBe(expectedName);
  });
});

// ---------------------------------------------------------------------------
// mapEvent — device-id ladder (locked, all four branches)
// ---------------------------------------------------------------------------

describe("singularProvider.mapEvent — device-id ladder", () => {
  it("prefers $singularDeviceId -> V2 endpoint, field sdid", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {
          $singularDeviceId: "40009df0-d618-4d81-9da1-cbb3337b8dec",
          $idfa: "should-not-be-used",
          $gpsAdId: "should-not-be-used",
        },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.endpoint).toBe(V2_ENDPOINT);
    expect(body.fields.sdid).toBe("40009df0-d618-4d81-9da1-cbb3337b8dec");
    expect(body.fields.idfa).toBeUndefined();
    expect(body.fields.aifa).toBeUndefined();
  });

  it("derives p from the subscriber's platform attribute on the sdid branch", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {
          $singularDeviceId: "sdid-1",
          platform: "android",
        },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.p).toBe("Android");
  });

  it("omits p on the sdid branch when platform is absent (never guesses)", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: { $singularDeviceId: "sdid-1" } }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.p).toBeUndefined();
  });

  it("falls back to $idfa -> V1 endpoint, field idfa, p=iOS when no singularDeviceId", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { $idfa: "DFC5A647-9043-4699-B2A5-76F03A97064B" },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.endpoint).toBe(V1_ENDPOINT);
    expect(body.fields.idfa).toBe("DFC5A647-9043-4699-B2A5-76F03A97064B");
    expect(body.fields.p).toBe("iOS");
    expect(body.fields.sdid).toBeUndefined();
  });

  it("falls back to $gpsAdId -> V1 endpoint, field aifa, p=Android when no singularDeviceId/idfa", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: { $gpsAdId: "8ecd7512-2864-440c-93f3-a3cabe62525b" },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.endpoint).toBe(V1_ENDPOINT);
    expect(body.fields.aifa).toBe("8ecd7512-2864-440c-93f3-a3cabe62525b");
    expect(body.fields.p).toBe("Android");
    expect(body.fields.sdid).toBeUndefined();
    expect(body.fields.idfa).toBeUndefined();
  });

  it("skips with no_user_data when none of the ladder attributes are present", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: {}, subscriberId: "sub_should_not_be_used" }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: undefined }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — ip / custom-arg / scope / idempotency
// ---------------------------------------------------------------------------

describe("singularProvider.mapEvent — ip, custom arg, scope and idempotency", () => {
  it("carries identityContext.ip as the ip field when present", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ identityContext: { ip: "172.58.29.235" } }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.ip).toBe("172.58.29.235");
  });

  it("omits ip when identityContext has none (never falls back to use_ip)", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ identityContext: undefined }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.ip).toBeUndefined();
    expect(body.fields.use_ip).toBeUndefined();
  });

  it("carries outboxEventId inside the `e` custom-attributes JSON", () => {
    const result = singularProvider.mapEvent(makeEnvelope(), makeConfig(), {
      sdk_key: SDK_KEY,
    });
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    const e = JSON.parse(body.fields.e) as Record<string, string>;
    expect(e.outbox_event_id).toBe("ob1");
    expect(e.rovenue_event).toBe("revenue.RENEWAL");
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      singularProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), {
        sdk_key: SDK_KEY,
      }),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = singularProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      config,
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips unmapped envelope eventTypes with no_mapping", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });
});

// ---------------------------------------------------------------------------
// mapEvent — att_authorization_status (post-review correction: "Always
// required" for iOS per Singular's docs, but never fabricated)
// ---------------------------------------------------------------------------

describe("singularProvider.mapEvent — att_authorization_status", () => {
  it.each([
    ["notDetermined", "0"],
    ["restricted", "1"],
    ["denied", "2"],
    ["authorized", "3"],
  ] as const)("maps $attConsentStatus=%s to att_authorization_status=%s on the iOS (idfa) branch", (consentStatus, expected) => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {
          $idfa: "DFC5A647-9043-4699-B2A5-76F03A97064B",
          $attConsentStatus: consentStatus,
        },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.att_authorization_status).toBe(expected);
  });

  it("omits att_authorization_status when $attConsentStatus is absent (never fabricates 0)", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({ subscriberAttributes: { $idfa: "DFC5A647-9043-4699-B2A5-76F03A97064B" } }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.att_authorization_status).toBeUndefined();
  });

  it("does not send att_authorization_status on the Android (aifa) branch", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {
          $gpsAdId: "8ecd7512-2864-440c-93f3-a3cabe62525b",
          $attConsentStatus: "authorized",
        },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.att_authorization_status).toBeUndefined();
  });

  it("sends att_authorization_status on the sdid branch only when platform resolves to iOS", () => {
    const result = singularProvider.mapEvent(
      makeEnvelope({
        subscriberAttributes: {
          $singularDeviceId: "sdid-1",
          platform: "ios",
          $attConsentStatus: "denied",
        },
      }),
      makeConfig(),
      { sdk_key: SDK_KEY, app_id: APP_ID },
    );
    const body = (result as ProviderPayload).body as SingularPayloadBody;
    expect(body.fields.att_authorization_status).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("singularProvider.credentialsSchema", () => {
  it("accepts sdk_key + app_id", () => {
    expect(
      singularProvider.credentialsSchema.safeParse({ sdk_key: SDK_KEY, app_id: APP_ID }).success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(singularProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty sdk_key", () => {
    expect(
      singularProvider.credentialsSchema.safeParse({ sdk_key: "", app_id: APP_ID }).success,
    ).toBe(false);
  });

  // app_id (post-review, 2026-08-25): `i` (app identifier) is a genuinely
  // required Singular wire parameter with no other honest source — see
  // providers/singular.ts's credentialsSchema comment. Missing/empty must
  // reject, the same as sdk_key.
  it("rejects a missing app_id", () => {
    expect(singularProvider.credentialsSchema.safeParse({ sdk_key: SDK_KEY }).success).toBe(
      false,
    );
  });

  it("rejects an empty app_id", () => {
    expect(
      singularProvider.credentialsSchema.safeParse({ sdk_key: SDK_KEY, app_id: "" }).success,
    ).toBe(false);
  });

  it("accepts unrelated extra string keys via catchall", () => {
    expect(
      singularProvider.credentialsSchema.safeParse({
        sdk_key: SDK_KEY,
        app_id: APP_ID,
        note: "x",
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — SHAPE-ONLY (no zero-footprint, non-destructive check exists)
// ---------------------------------------------------------------------------

describe("singularProvider.validateCredentials", () => {
  it("ok when credentials are well-formed (sends no request)", async () => {
    const http = {
      request: async () => {
        throw new Error("validateCredentials must not send any request");
      },
    };
    const result = await singularProvider.validateCredentials({ sdk_key: SDK_KEY, app_id: APP_ID }, http);
    expect(result).toEqual({ ok: true });
  });

  it("fails when sdk_key is missing", async () => {
    const http = { request: async () => ({ status: 200, body: "" }) };
    const result = await singularProvider.validateCredentials({ app_id: APP_ID }, http);
    expect(result.ok).toBe(false);
  });

  it("fails when app_id is missing", async () => {
    const http = { request: async () => ({ status: 200, body: "" }) };
    const result = await singularProvider.validateCredentials({ sdk_key: SDK_KEY }, http);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix + wire shape
// ---------------------------------------------------------------------------

describe("singularProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  function dummyPayload(endpoint: string, extraFields: Record<string, string> = {}): ProviderPayload {
    return {
      eventKey: "revenue.RENEWAL",
      providerEvent: "sng_ecommerce_purchase",
      body: {
        endpoint,
        fields: {
          n: "sng_ecommerce_purchase",
          idfa: "DFC5A647-9043-4699-B2A5-76F03A97064B",
          p: "iOS",
          is_revenue_event: "true",
          amt: "9.99",
          cur: "USD",
          e: JSON.stringify({ outbox_event_id: "ob1", rovenue_event: "revenue.RENEWAL" }),
          ...extraFields,
        },
      } satisfies SingularPayloadBody,
    };
  }

  it("200 with body status=ok -> ok, not retriable", async () => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(200, JSON.stringify({ status: "ok" }));
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
    expect(result.httpStatus).toBe(200);
  });

  it.each([
    ["missing argument: a", false],
    ["invalid platform: Desktop", false],
    ["no device ID supplied", false],
    ["platform: PC should have an sdid param", false],
    ["internal error, try again", true],
  ] as const)(
    "200 with body status=error reason=%s -> ok:false retriable:%s",
    async (reason, retriable) => {
      agent
        .get("https://s2s.singular.net")
        .intercept({ path: "/api/v1/evt", method: "POST" })
        .reply(200, JSON.stringify({ status: "error", reason }));
      const http = createUndiciHttpClient();
      const result = await singularProvider.deliver(
        dummyPayload(V1_ENDPOINT),
        { sdk_key: SDK_KEY, app_id: APP_ID },
        http,
      );
      expect(result.ok).toBe(false);
      expect(result.retriable).toBe(retriable);
      expect(result.httpStatus).toBe(200);
    },
  );

  it("200 with an unparseable body -> ok:false, retriable (conservative)", async () => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(200, "not json");
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it.each([
    [400, false, false],
    [401, false, false],
    [403, false, false],
    [429, false, true],
    [500, false, true],
    [503, false, true],
  ] as const)("non-200 http %s -> ok:%s retriable:%s (defensive fallback)", async (status, ok, retriable) => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(status, "");
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    expect(result.ok).toBe(ok);
    expect(result.retriable).toBe(retriable);
    expect(result.httpStatus).toBe(status);
  });

  it("POSTs form-urlencoded to the V1 endpoint with `a` (sdk_key) and `i` (app_id) in the BODY, not the URL", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedPath = "";
    let observedBody = "";
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        observedPath = opts.path;
        observedBody = opts.body as string;
        return { statusCode: 200, data: JSON.stringify({ status: "ok" }) };
      });
    const http = createUndiciHttpClient();
    await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    expect(observedHeaders["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(observedPath).toBe("/api/v1/evt");
    const params = new URLSearchParams(observedBody);
    expect(params.get("a")).toBe(SDK_KEY);
    expect(params.get("i")).toBe(APP_ID);
    expect(params.get("idfa")).toBe("DFC5A647-9043-4699-B2A5-76F03A97064B");
    expect(params.get("n")).toBe("sng_ecommerce_purchase");
  });

  it("carries `i` (app_id) on the V2 endpoint too", async () => {
    let observedBody = "";
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v2/evt", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: JSON.stringify({ status: "ok" }) };
      });
    const http = createUndiciHttpClient();
    await singularProvider.deliver(
      dummyPayload(V2_ENDPOINT, { sdid: "40009df0-d618-4d81-9da1-cbb3337b8dec", idfa: "" }),
      { sdk_key: SDK_KEY, app_id: APP_ID },
      http,
    );
    const params = new URLSearchParams(observedBody);
    expect(params.get("i")).toBe(APP_ID);
  });

  it("POSTs to the V2 endpoint when payload.body.endpoint is V2", async () => {
    let observedPath = "";
    let observedBody = "";
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v2/evt", method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        observedBody = opts.body as string;
        return { statusCode: 200, data: JSON.stringify({ status: "ok" }) };
      });
    const http = createUndiciHttpClient();
    await singularProvider.deliver(
      dummyPayload(V2_ENDPOINT, { sdid: "40009df0-d618-4d81-9da1-cbb3337b8dec", idfa: "" }),
      { sdk_key: SDK_KEY, app_id: APP_ID },
      http,
    );
    expect(observedPath).toBe("/api/v2/evt");
    const params = new URLSearchParams(observedBody);
    expect(params.get("sdid")).toBe("40009df0-d618-4d81-9da1-cbb3337b8dec");
  });

  // -------------------------------------------------------------------------
  // SECRET-IN-QUERY CONSTRAINT — binding test: DeliveryResult must never
  // surface the raw sdk_key or the request URL, on either the ok or error
  // branch.
  // -------------------------------------------------------------------------

  function assertNoSecretLeak(result: DeliveryResult) {
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SDK_KEY);
    expect(serialized).not.toContain(V1_ENDPOINT);
    expect(serialized).not.toContain(V2_ENDPOINT);
    expect(serialized).not.toContain("s2s.singular.net");
  }

  it("DeliveryResult never contains the sdk_key or the request URL (ok branch)", async () => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(200, JSON.stringify({ status: "ok" }));
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    assertNoSecretLeak(result);
  });

  it("DeliveryResult never contains the sdk_key or the request URL (error branch)", async () => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(200, JSON.stringify({ status: "error", reason: "missing argument: a" }));
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    assertNoSecretLeak(result);
  });

  it("DeliveryResult never contains the sdk_key or the request URL (non-200 branch)", async () => {
    agent
      .get("https://s2s.singular.net")
      .intercept({ path: "/api/v1/evt", method: "POST" })
      .reply(500, "");
    const http = createUndiciHttpClient();
    const result = await singularProvider.deliver(dummyPayload(V1_ENDPOINT), { sdk_key: SDK_KEY, app_id: APP_ID }, http);
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

describe("singularProvider static config", () => {
  it("id is SINGULAR", () => {
    expect(singularProvider.id).toBe("SINGULAR");
  });

  it("topics are revenue + subscription only", () => {
    expect(singularProvider.topics).toEqual(["rovenue.revenue", "rovenue.subscription"]);
  });

  it("allowMultipleConnections is false", () => {
    expect(singularProvider.allowMultipleConnections).toBe(false);
  });

  it("has no retryPolicy of its own (falls through to DEFAULT_RETRY_POLICY)", () => {
    expect(singularProvider.retryPolicy).toBeUndefined();
  });

  it("eventCatalog IS STANDARD_PROVIDER_EVENT_KEYS (length pinned to the constant, not a literal)", () => {
    expect(singularProvider.eventCatalog).toHaveLength(STANDARD_PROVIDER_EVENT_KEYS.length);
    expect(singularProvider.eventCatalog).toContain("revenue.REFUND");
    expect(singularProvider.eventCatalog).toContain("subscription.trial.started");
  });

  it("defaultEventMapping maps every catalog key except revenue.REFUND", () => {
    for (const key of singularProvider.eventCatalog) {
      if (key === "revenue.REFUND") {
        expect(singularProvider.defaultEventMapping[key]).toBeUndefined();
      } else {
        expect(singularProvider.defaultEventMapping[key]).toBeTruthy();
      }
    }
  });

  it("every mapped event name stays within Singular's documented 32-ASCII-character cap", () => {
    for (const key of singularProvider.eventCatalog) {
      const name = singularProvider.defaultEventMapping[key];
      if (!name) continue;
      expect(name.length).toBeLessThanOrEqual(32);
    }
  });
});
