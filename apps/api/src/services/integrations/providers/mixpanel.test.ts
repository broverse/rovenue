import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { mixpanelProvider } from "./mixpanel";
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
    subscriberAttributes: { $mixpanelDistinctId: "mp_user_1" },
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

type MixpanelEventBody = {
  event: string;
  properties: {
    time: number;
    distinct_id: string;
    $insert_id: string;
    amount?: number;
    currency?: string;
    product_id?: string;
    rovenue_event: string;
  };
};

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("mixpanelProvider.mapEvent", () => {
  it("maps RENEWAL -> renewal with $insert_id from outboxEventId", () => {
    const result = mixpanelProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-renewal-1" }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as MixpanelEventBody;
    expect(body.event).toBe("renewal");
    expect(body.properties.$insert_id).toBe("ob-renewal-1");
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    expect(payload.providerEvent).toBe("renewal");
  });

  it.each([
    ["revenue.INITIAL", "purchase_initial"],
    ["revenue.TRIAL_CONVERSION", "trial_conversion"],
    ["revenue.CREDIT_PURCHASE", "credit_purchase"],
    ["revenue.REFUND", "refund"],
    ["revenue.CANCELLATION", "cancellation"],
  ] as const)("maps %s -> %s", (kind, expected) => {
    const revenueKind = kind.split(".")[1] as RovenueEventEnvelope["revenueEventKind"];
    const result = mixpanelProvider.mapEvent(
      makeEnvelope({ revenueEventKind: revenueKind }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as MixpanelEventBody;
    expect(body.event).toBe(expected);
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
    const result = mixpanelProvider.mapEvent(
      makeEnvelope({ eventType, revenueEventKind: undefined, amount: undefined }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as MixpanelEventBody;
    expect(body.event).toBe(expected);
  });

  it("skips unmapped event types with no_mapping", () => {
    const result = mixpanelProvider.mapEvent(
      makeEnvelope({ eventType: "paywall_view", revenueEventKind: undefined }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips when not in enabledEvents (filtered_by_event_scope)", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = mixpanelProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips with no_user_data when no identity is resolvable", () => {
    const envelope = makeEnvelope({
      subscriberAttributes: {},
      subscriberId: undefined,
    });
    const result = mixpanelProvider.mapEvent(envelope, makeConfig(), {});
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("throws when outboxEventId is empty", () => {
    expect(() =>
      mixpanelProvider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        {},
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  // -------------------------------------------------------------------------
  // Identity fallback chain: $mixpanelDistinctId ?? appUserId ?? subscriberId
  // -------------------------------------------------------------------------

  describe("identity fallback chain", () => {
    it("prefers $mixpanelDistinctId when present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {
          $mixpanelDistinctId: "mp_id",
          appUserId: "app_id",
        },
        subscriberId: "sub_id",
      });
      const result = mixpanelProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.distinct_id).toBe("mp_id");
    });

    it("falls back to appUserId when $mixpanelDistinctId is absent", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: { appUserId: "app_id" },
        subscriberId: "sub_id",
      });
      const result = mixpanelProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.distinct_id).toBe("app_id");
    });

    it("falls back to subscriberId when neither attribute is present", () => {
      const envelope = makeEnvelope({
        subscriberAttributes: {},
        subscriberId: "sub_id",
      });
      const result = mixpanelProvider.mapEvent(envelope, makeConfig(), {});
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.distinct_id).toBe("sub_id");
    });
  });

  // -------------------------------------------------------------------------
  // Revenue fields
  // -------------------------------------------------------------------------

  describe("revenue fields", () => {
    it("sets amount/currency on a revenue.* event", () => {
      const result = mixpanelProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "RENEWAL", amount: "19.99", currency: "EUR" }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.amount).toBe(19.99);
      expect(body.properties.currency).toBe("EUR");
    });

    it("stores REFUND amount as NEGATIVE, mirroring the Amplitude convention", () => {
      const result = mixpanelProvider.mapEvent(
        makeEnvelope({ revenueEventKind: "REFUND", amount: "5.00" }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.amount).toBe(-5);
    });

    it("does NOT set amount/currency on a subscription lifecycle event", () => {
      const result = mixpanelProvider.mapEvent(
        makeEnvelope({
          eventType: "subscription.trial.started",
          revenueEventKind: undefined,
          amount: undefined,
        }),
        makeConfig(),
        {},
      );
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.amount).toBeUndefined();
      expect(body.properties.currency).toBeUndefined();
    });

    it("properties always carries rovenue_event and product_id", () => {
      const result = mixpanelProvider.mapEvent(makeEnvelope(), makeConfig(), {});
      const body = (result as ProviderPayload).body as MixpanelEventBody;
      expect(body.properties.rovenue_event).toBe("revenue.RENEWAL");
      expect(body.properties.product_id).toBe("prod_gold");
    });
  });
});

// ---------------------------------------------------------------------------
// validateCredentials + deliver
// ---------------------------------------------------------------------------

const GOOD_CREDS = {
  service_account_username: "svc.acct",
  service_account_secret: "s3cr3t",
  project_id: "proj_1",
};

describe("mixpanelProvider.validateCredentials", () => {
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
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(200, '{"code":200,"num_records_imported":1,"status":"OK"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.validateCredentials(GOOD_CREDS, http);
    expect(result).toEqual({ ok: true });
  });

  it("401 invalid credentials -> !ok", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(401, '{"code":401,"error":"Invalid credentials","status":"Unauthorized"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.validateCredentials(
      { ...GOOD_CREDS, service_account_secret: "bad" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("400 strict-validation failure -> !ok", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(400, '{"code":400,"status":"Bad Request"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.validateCredentials(GOOD_CREDS, http);
    expect(result.ok).toBe(false);
  });

  it("uses the EU endpoint when region=eu", async () => {
    agent
      .get("https://api-eu.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(200, '{"code":200}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.validateCredentials(
      { ...GOOD_CREDS, region: "eu" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("sends strict=1 and project_id as query params", async () => {
    let observedPath: string | undefined;
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply((opts) => {
        observedPath = opts.path;
        return { statusCode: 200, data: '{"code":200}' };
      });
    const http = createUndiciHttpClient();
    await mixpanelProvider.validateCredentials(GOOD_CREDS, http);

    expect(observedPath).toContain("strict=1");
    expect(observedPath).toContain("project_id=proj_1");
  });

  it("authenticates with Basic base64(username:secret)", async () => {
    let observedAuth: string | undefined;
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply((opts) => {
        // undici may pass headers as a flat string[] array or as a Record
        const h = opts.headers;
        if (Array.isArray(h)) {
          for (let i = 0; i < h.length; i += 2) {
            if (String(h[i]).toLowerCase() === "authorization") {
              observedAuth = String(h[i + 1]);
            }
          }
        } else if (h && typeof h === "object") {
          observedAuth =
            (h as Record<string, string>)["authorization"] ??
            (h as Record<string, string>)["Authorization"];
        }
        return { statusCode: 200, data: '{"code":200}' };
      });
    const http = createUndiciHttpClient();
    await mixpanelProvider.validateCredentials(GOOD_CREDS, http);

    const expected = `Basic ${Buffer.from("svc.acct:s3cr3t").toString("base64")}`;
    expect(observedAuth).toBe(expected);
  });

  it("probe carries a STABLE $insert_id so repeat Validate clicks dedupe in Mixpanel", async () => {
    const observedBodies: string[] = [];
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply((opts) => {
        observedBodies.push(opts.body as string);
        return { statusCode: 200, data: '{"code":200}' };
      })
      .times(2);
    const http = createUndiciHttpClient();

    await mixpanelProvider.validateCredentials(GOOD_CREDS, http);
    await mixpanelProvider.validateCredentials(GOOD_CREDS, http);

    expect(observedBodies).toHaveLength(2);
    const insertIds = observedBodies.map(
      (raw) => (JSON.parse(raw) as MixpanelEventBody[])[0]!.properties.$insert_id,
    );
    expect(insertIds[0]).toBeTruthy();
    expect(insertIds[0]).toBe(insertIds[1]);
  });
});

describe("mixpanelProvider.deliver", () => {
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
      event: "renewal",
      properties: { time: 1, distinct_id: "u1", $insert_id: "ob1", rovenue_event: "revenue.RENEWAL" },
    },
  };

  it("200 -> ok + retriable:false", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(200, '{"code":200,"num_records_imported":1,"status":"OK"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("400 strict-validation failure -> !ok + retriable:false", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(400, '{"code":400,"status":"Bad Request"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("401 -> !ok + retriable:false", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(401, '{"code":401,"error":"Invalid credentials"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(429, '{"code":429,"error":"Too many requests"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(500, '{"error":"server_error"}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("outgoing body wraps the event in a single-element array with $insert_id preserved", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://api.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: '{"code":200}' };
      });
    const http = createUndiciHttpClient();
    await mixpanelProvider.deliver(dummyPayload, GOOD_CREDS, http);

    const sent = JSON.parse(observedBody ?? "[]") as MixpanelEventBody[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.properties.$insert_id).toBe("ob1");
  });

  it("uses the EU endpoint when region=eu", async () => {
    agent
      .get("https://api-eu.mixpanel.com")
      .intercept({ path: /^\/import\?/, method: "POST" })
      .reply(200, '{"code":200}');
    const http = createUndiciHttpClient();
    const result = await mixpanelProvider.deliver(
      dummyPayload,
      { ...GOOD_CREDS, region: "eu" },
      http,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credentialsSchema
// ---------------------------------------------------------------------------

describe("mixpanelProvider.credentialsSchema", () => {
  it("accepts all four required fields", () => {
    expect(
      mixpanelProvider.credentialsSchema.safeParse(GOOD_CREDS).success,
    ).toBe(true);
  });

  it("accepts region us/eu", () => {
    expect(
      mixpanelProvider.credentialsSchema.safeParse({ ...GOOD_CREDS, region: "us" })
        .success,
    ).toBe(true);
    expect(
      mixpanelProvider.credentialsSchema.safeParse({ ...GOOD_CREDS, region: "eu" })
        .success,
    ).toBe(true);
  });

  it("rejects an empty object", () => {
    expect(mixpanelProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects missing service_account_username", () => {
    const { service_account_username: _drop, ...rest } = GOOD_CREDS;
    expect(mixpanelProvider.credentialsSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing service_account_secret", () => {
    const { service_account_secret: _drop, ...rest } = GOOD_CREDS;
    expect(mixpanelProvider.credentialsSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing project_id", () => {
    const { project_id: _drop, ...rest } = GOOD_CREDS;
    expect(mixpanelProvider.credentialsSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty string fields", () => {
    expect(
      mixpanelProvider.credentialsSchema.safeParse({
        ...GOOD_CREDS,
        service_account_username: "",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid region", () => {
    expect(
      mixpanelProvider.credentialsSchema.safeParse({ ...GOOD_CREDS, region: "asia" })
        .success,
    ).toBe(false);
  });
});
