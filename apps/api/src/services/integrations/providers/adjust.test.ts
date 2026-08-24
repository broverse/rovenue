import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { adjustProvider } from "./adjust";
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
    subscriberAttributes: { $adjustId: "adjust-device-1" },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    connectionId: "conn1",
    projectId: "proj1",
    enabledEvents: ALL_EVENTS,
    // ADJUST has NO default event mapping — every key must be overridden
    // with the vendor's event token, or the event is skipped (no_mapping).
    eventMapping: {
      "revenue.INITIAL": { eventName: "tok_initial" },
      "revenue.TRIAL_CONVERSION": { eventName: "tok_trial_conv" },
      "revenue.RENEWAL": { eventName: "tok_renewal" },
      "revenue.CREDIT_PURCHASE": { eventName: "tok_credit" },
      "revenue.REFUND": { eventName: "tok_refund" },
      "revenue.CANCELLATION": { eventName: "tok_cancel" },
      "subscription.trial.started": { eventName: "tok_trial_started" },
      "subscription.cancel_requested": { eventName: "tok_cancel_requested" },
      "subscription.expired": { eventName: "tok_expired" },
      "subscription.billing_issue": { eventName: "tok_billing_issue" },
      "subscription.grace_period": { eventName: "tok_grace_period" },
      "subscription.uncancelled": { eventName: "tok_uncancelled" },
      "subscription.product_changed": { eventName: "tok_product_changed" },
    },
    actionSource: "app",
    ...overrides,
  };
}

const CREDS = { app_token: "app-token-1" };

interface AdjustWireBody {
  event_token: string;
  s2s: 1;
  adid?: string;
  idfa?: string;
  gps_adid?: string;
  revenue?: number;
  currency?: string;
  created_at_unix: number;
  callback_params: string;
  deduplication_id: string;
}

function wireOf(result: ReturnType<typeof adjustProvider.mapEvent>): AdjustWireBody {
  return (result as ProviderPayload).body as AdjustWireBody;
}

function callbackParamsOf(result: ReturnType<typeof adjustProvider.mapEvent>): Record<string, unknown> {
  return JSON.parse(wireOf(result).callback_params) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// mapEvent — no default mapping
// ---------------------------------------------------------------------------

describe("adjustProvider.mapEvent — no default mapping", () => {
  it("uses eventMapping[key].eventName verbatim as the Adjust event_token", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL" }),
      makeConfig(),
      CREDS,
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.providerEvent).toBe("tok_renewal");
    expect(wireOf(result).event_token).toBe("tok_renewal");
  });

  it("skips with no_mapping when no eventName is configured for the key (no default exists)", () => {
    const config = makeConfig({ eventMapping: {} });
    const result = adjustProvider.mapEvent(makeEnvelope(), config, CREDS);
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it.each(ALL_EVENTS)("every catalog key %s requires an explicit token (no vendor default)", (key) => {
    // Confirms defaultEventMapping truly has no entries — every single
    // catalog key falls through to no_mapping without an override.
    const config = makeConfig({ eventMapping: {}, enabledEvents: [key] });
    const envelope =
      key.startsWith("revenue.")
        ? makeEnvelope({ revenueEventKind: key.split(".")[1] as RovenueEventEnvelope["revenueEventKind"] })
        : makeEnvelope({ eventType: key as RovenueEventEnvelope["eventType"], revenueEventKind: undefined, amount: undefined });
    const result = adjustProvider.mapEvent(envelope, config, CREDS);
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = adjustProvider.mapEvent(makeEnvelope(), config, CREDS);
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      adjustProvider.mapEvent(makeEnvelope({ outboxEventId: "" }), makeConfig(), CREDS),
    ).toThrow(/non-empty outboxEventId/);
  });
});

// ---------------------------------------------------------------------------
// Device-id ladder — $adjustId -> $idfa -> $gpsAdId -> no_user_data
// ---------------------------------------------------------------------------

describe("adjustProvider.mapEvent — device-id ladder", () => {
  it("uses $adjustId as adid when present", () => {
    const envelope = makeEnvelope({
      subscriberAttributes: { $adjustId: "adj-1", $idfa: "idfa-1", $gpsAdId: "gps-1" },
    });
    const result = adjustProvider.mapEvent(envelope, makeConfig(), CREDS);
    const wire = wireOf(result);
    expect(wire.adid).toBe("adj-1");
    expect(wire.idfa).toBeUndefined();
    expect(wire.gps_adid).toBeUndefined();
  });

  it("falls back to $idfa as idfa when $adjustId is absent", () => {
    const envelope = makeEnvelope({
      subscriberAttributes: { $idfa: "idfa-1", $gpsAdId: "gps-1" },
    });
    const result = adjustProvider.mapEvent(envelope, makeConfig(), CREDS);
    const wire = wireOf(result);
    expect(wire.idfa).toBe("idfa-1");
    expect(wire.adid).toBeUndefined();
    expect(wire.gps_adid).toBeUndefined();
  });

  it("falls back to $gpsAdId as gps_adid when $adjustId and $idfa are absent", () => {
    const envelope = makeEnvelope({
      subscriberAttributes: { $gpsAdId: "gps-1" },
    });
    const result = adjustProvider.mapEvent(envelope, makeConfig(), CREDS);
    const wire = wireOf(result);
    expect(wire.gps_adid).toBe("gps-1");
    expect(wire.adid).toBeUndefined();
    expect(wire.idfa).toBeUndefined();
  });

  it("skips with no_user_data when none of the three device ids are present", () => {
    const envelope = makeEnvelope({ subscriberAttributes: {} });
    const result = adjustProvider.mapEvent(envelope, makeConfig(), CREDS);
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("skips with no_user_data when subscriberAttributes is entirely absent", () => {
    const envelope = makeEnvelope({ subscriberAttributes: undefined });
    const result = adjustProvider.mapEvent(envelope, makeConfig(), CREDS);
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});

// ---------------------------------------------------------------------------
// Wire-body shape: revenue/currency, created_at_unix, callback_params,
// deduplication_id
// ---------------------------------------------------------------------------

describe("adjustProvider.mapEvent — wire body", () => {
  it("carries revenue/currency on a revenue.* event", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "RENEWAL", amount: "19.99", currency: "EUR" }),
      makeConfig(),
      CREDS,
    );
    const wire = wireOf(result);
    expect(wire.revenue).toBe(19.99);
    expect(wire.currency).toBe("EUR");
  });

  it("REFUND revenue is sent POSITIVE (no documented Adjust negative-value convention)", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
      makeConfig(),
      CREDS,
    );
    expect(wireOf(result).revenue).toBe(5);
  });

  it("omits revenue/currency on a subscription lifecycle event", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.trial.started",
        revenueEventKind: undefined,
        amount: undefined,
        currency: undefined,
      }),
      makeConfig(),
      CREDS,
    );
    const wire = wireOf(result);
    expect(wire.revenue).toBeUndefined();
    expect(wire.currency).toBeUndefined();
  });

  it("sets created_at_unix to the epoch SECONDS of occurredAt", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ occurredAt: "2024-01-15T10:00:00.000Z" }),
      makeConfig(),
      CREDS,
    );
    expect(wireOf(result).created_at_unix).toBe(1705312800);
  });

  it("sets s2s to 1", () => {
    const result = adjustProvider.mapEvent(makeEnvelope(), makeConfig(), CREDS);
    expect(wireOf(result).s2s).toBe(1);
  });

  it("sets deduplication_id to outboxEventId", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-xyz" }),
      makeConfig(),
      CREDS,
    );
    expect(wireOf(result).deduplication_id).toBe("ob-xyz");
  });

  it("callback_params JSON carries rovenue_event, outbox_event_id, and product_id", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-xyz", productId: "prod_gold", revenueEventKind: "RENEWAL" }),
      makeConfig(),
      CREDS,
    );
    const cb = callbackParamsOf(result);
    expect(cb.rovenue_event).toBe("revenue.RENEWAL");
    expect(cb.outbox_event_id).toBe("ob-xyz");
    expect(cb.product_id).toBe("prod_gold");
  });

  it("callback_params omits product_id when productId is absent", () => {
    const result = adjustProvider.mapEvent(
      makeEnvelope({ productId: undefined }),
      makeConfig(),
      CREDS,
    );
    const cb = callbackParamsOf(result);
    expect(cb.product_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — shape-only (no vendor probe endpoint)
// ---------------------------------------------------------------------------

describe("adjustProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("valid shape (app_token present) -> ok, with NO network call", async () => {
    const http = createUndiciHttpClient();
    const result = await adjustProvider.validateCredentials(CREDS, http);
    expect(result).toEqual({ ok: true });
  });

  it("missing app_token -> !ok", async () => {
    const http = createUndiciHttpClient();
    const result = await adjustProvider.validateCredentials({}, http);
    expect(result.ok).toBe(false);
  });

  it("empty app_token -> !ok", async () => {
    const http = createUndiciHttpClient();
    const result = await adjustProvider.validateCredentials({ app_token: "" }, http);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

describe("adjustProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  function makePayload(overrides: Partial<AdjustWireBody> = {}): ProviderPayload {
    return {
      eventKey: "revenue.RENEWAL",
      providerEvent: "tok_renewal",
      body: {
        event_token: "tok_renewal",
        s2s: 1,
        adid: "adj-1",
        revenue: 9.99,
        currency: "USD",
        created_at_unix: 1705312800,
        callback_params: JSON.stringify({ rovenue_event: "revenue.RENEWAL", outbox_event_id: "ob1", product_id: "prod_gold" }),
        deduplication_id: "ob1",
        ...overrides,
      } satisfies AdjustWireBody,
    };
  }

  it("POSTs form-encoded to https://s2s.adjust.com/event", async () => {
    let observedPath: string | undefined;
    let observedContentType: string | undefined;
    agent
      .get("https://s2s.adjust.com")
      .intercept({ path: "/event", method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        const h = opts.headers;
        if (Array.isArray(h)) {
          for (let i = 0; i < h.length; i += 2) {
            if (String(h[i]).toLowerCase() === "content-type") observedContentType = String(h[i + 1]);
          }
        } else if (h && typeof h === "object") {
          observedContentType =
            (h as Record<string, string>)["content-type"] ??
            (h as Record<string, string>)["Content-Type"];
        }
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(observedPath).toBe("/event");
    expect(observedContentType).toBe("application/x-www-form-urlencoded");
  });

  it("form-encodes app_token, event_token, s2s, adid, revenue, currency, created_at_unix, callback_params, deduplication_id", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://s2s.adjust.com")
      .intercept({ path: "/event", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await adjustProvider.deliver(makePayload(), CREDS, http);
    const params = new URLSearchParams(observedBody ?? "");
    expect(params.get("app_token")).toBe(CREDS.app_token);
    expect(params.get("event_token")).toBe("tok_renewal");
    expect(params.get("s2s")).toBe("1");
    expect(params.get("adid")).toBe("adj-1");
    expect(params.get("revenue")).toBe("9.99");
    expect(params.get("currency")).toBe("USD");
    expect(params.get("created_at_unix")).toBe("1705312800");
    expect(params.get("deduplication_id")).toBe("ob1");
    expect(JSON.parse(params.get("callback_params") ?? "{}")).toEqual({
      rovenue_event: "revenue.RENEWAL",
      outbox_event_id: "ob1",
      product_id: "prod_gold",
    });
  });

  it("sends idfa param when the wire body carries idfa instead of adid", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://s2s.adjust.com")
      .intercept({ path: "/event", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await adjustProvider.deliver(
      makePayload({ adid: undefined, idfa: "idfa-1" }),
      CREDS,
      http,
    );
    const params = new URLSearchParams(observedBody ?? "");
    expect(params.get("idfa")).toBe("idfa-1");
    expect(params.has("adid")).toBe(false);
  });

  it("omits revenue/currency params when absent from the wire body", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://s2s.adjust.com")
      .intercept({ path: "/event", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "" };
      });
    const http = createUndiciHttpClient();
    await adjustProvider.deliver(
      makePayload({ revenue: undefined, currency: undefined }),
      CREDS,
      http,
    );
    const params = new URLSearchParams(observedBody ?? "");
    expect(params.has("revenue")).toBe(false);
    expect(params.has("currency")).toBe(false);
  });

  it("200 -> ok + retriable:false", async () => {
    agent.get("https://s2s.adjust.com").intercept({ path: "/event", method: "POST" }).reply(200, "");
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("400 with error body -> !ok + retriable:false", async () => {
    agent
      .get("https://s2s.adjust.com")
      .intercept({ path: "/event", method: "POST" })
      .reply(400, '{"error":"missing event_token"}');
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("401 -> !ok + retriable:false", async () => {
    agent.get("https://s2s.adjust.com").intercept({ path: "/event", method: "POST" }).reply(401, "unauthorized");
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("403 -> !ok + retriable:false", async () => {
    agent.get("https://s2s.adjust.com").intercept({ path: "/event", method: "POST" }).reply(403, "forbidden");
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent.get("https://s2s.adjust.com").intercept({ path: "/event", method: "POST" }).reply(429, "too many requests");
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent.get("https://s2s.adjust.com").intercept({ path: "/event", method: "POST" }).reply(500, "server error");
    const http = createUndiciHttpClient();
    const result = await adjustProvider.deliver(makePayload(), CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("adjustProvider.credentialsSchema", () => {
  it("accepts app_token", () => {
    expect(adjustProvider.credentialsSchema.safeParse({ app_token: "tok" }).success).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(adjustProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty app_token", () => {
    expect(adjustProvider.credentialsSchema.safeParse({ app_token: "" }).success).toBe(false);
  });

  it("accepts extra unrelated string keys (catchall)", () => {
    expect(
      adjustProvider.credentialsSchema.safeParse({ app_token: "tok", extra: "x" }).success,
    ).toBe(true);
  });
});
