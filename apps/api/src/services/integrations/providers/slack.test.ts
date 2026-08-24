import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import {
  slackProvider,
  SLACK_WEBHOOK_HOST,
  isAllowedSlackWebhookUrl,
} from "./slack";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
} from "../types";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx";

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
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    connectionId: "conn1",
    projectId: "proj1",
    enabledEvents: [...ROVENUE_EVENT_KEYS],
    eventMapping: {},
    actionSource: "app",
    ...overrides,
  };
}

type SlackBody = { text: string };

// ---------------------------------------------------------------------------
// credentialsSchema — host allowlist (accept/reject)
// ---------------------------------------------------------------------------

describe("slackProvider.credentialsSchema", () => {
  it("accepts a valid https://hooks.slack.com/... URL", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({ webhook_url: VALID_WEBHOOK_URL }).success,
    ).toBe(true);
  });

  it("rejects an empty object (missing webhook_url)", () => {
    expect(slackProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty webhook_url", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({ webhook_url: "" }).success,
    ).toBe(false);
  });

  it("rejects http:// (non-https)", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({
        webhook_url: "http://hooks.slack.com/services/T000/B000/xxxx",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong host", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({
        webhook_url: "https://evil.example.com/services/T000/B000/xxxx",
      }).success,
    ).toBe(false);
  });

  it("rejects a host that merely contains hooks.slack.com as a substring/subdomain", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({
        webhook_url: "https://hooks.slack.com.evil.example.com/services/x",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL string", () => {
    expect(
      slackProvider.credentialsSchema.safeParse({ webhook_url: "not a url" }).success,
    ).toBe(false);
  });
});

describe("isAllowedSlackWebhookUrl", () => {
  it("SLACK_WEBHOOK_HOST is exactly hooks.slack.com", () => {
    expect(SLACK_WEBHOOK_HOST).toBe("hooks.slack.com");
  });

  it("accepts the valid host+https combination", () => {
    expect(isAllowedSlackWebhookUrl(VALID_WEBHOOK_URL)).toBe(true);
  });

  it("rejects wrong protocol, wrong host, and unparseable input", () => {
    expect(isAllowedSlackWebhookUrl("http://hooks.slack.com/services/x")).toBe(false);
    expect(isAllowedSlackWebhookUrl("https://not-slack.example.com/x")).toBe(false);
    expect(isAllowedSlackWebhookUrl("::::not a url::::")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message builder — moved to chat-message.test.ts (Task 3: hoisted to
// ../chat-message.ts, shared with DISCORD). See that file for the
// per-family / masking assertions, byte-identical to what lived here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("slackProvider.mapEvent", () => {
  it("maps a revenue.* envelope via revenueEventKind and does not require outboxEventId", () => {
    const result = slackProvider.mapEvent(
      makeEnvelope({ outboxEventId: "", revenueEventKind: "RENEWAL" }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    const body = JSON.parse(payload.body as string) as SlackBody;
    expect(body.text).toContain("revenue.RENEWAL");
  });

  it("maps a subscription-topic envelope (eventKey already set by fanout)", () => {
    const result = slackProvider.mapEvent(
      makeEnvelope({
        eventType: "subscription.expired",
        eventKey: "subscription.expired",
        revenueEventKind: undefined,
        amount: undefined,
        payload: { subscriberId: "sub_123" },
      }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe("subscription.expired");
  });

  it("maps a paywall_events-topic envelope (paywall.view)", () => {
    const result = slackProvider.mapEvent(
      makeEnvelope({
        eventType: "paywall_view",
        eventKey: "paywall.view",
        revenueEventKind: undefined,
        amount: undefined,
        payload: {},
      }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    expect((result as ProviderPayload).eventKey).toBe("paywall.view");
  });

  it("maps a credit-topic envelope (credit.ledger.appended)", () => {
    const result = slackProvider.mapEvent(
      makeEnvelope({
        eventType: "credit.ledger.appended",
        eventKey: "credit.ledger.appended",
        revenueEventKind: undefined,
        amount: undefined,
        payload: {},
      }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    expect((result as ProviderPayload).eventKey).toBe("credit.ledger.appended");
  });

  it("skips with no_mapping when no eventKey can be derived", () => {
    const result = slackProvider.mapEvent(
      makeEnvelope({
        eventType: "subscriber.identified",
        eventKey: undefined,
        revenueEventKind: undefined,
        amount: undefined,
      }),
      makeConfig(),
      {},
    );
    expect(result).toEqual({ skip: true, reason: "no_mapping" });
  });

  it("skips with filtered_by_event_scope when the key is not enabled", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = slackProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("body is { text } JSON", () => {
    const result = slackProvider.mapEvent(makeEnvelope(), makeConfig(), {});
    const payload = result as ProviderPayload;
    const parsed = JSON.parse(payload.body as string) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["text"]);
    expect(typeof parsed.text).toBe("string");
  });

  // -----------------------------------------------------------------------
  // PII absence — the load-bearing safety property of this provider.
  // -----------------------------------------------------------------------

  it("NEVER includes email/phone/attributes in the message, even from a fully-enriched envelope", () => {
    const enrichedEnvelope: RovenueEventEnvelope = makeEnvelope({
      identityContext: {
        email: "user@example.com",
        phone: "+15551234567",
        externalId: "ext_1",
        ip: "203.0.113.5",
        userAgent: "MyApp/1.0",
        fbp: "fb.1.abc",
        fbc: "fb.2.def",
      },
      subscriberAttributes: {
        appUserId: "app_user_1",
        email: "attrs-user@example.com",
        phone: "+15559876543",
        $amplitudeUserId: "amp_1",
        customTag: "super-secret-plan-name",
      },
      payload: {
        raw: "should never be read by buildSlackMessageText",
        secretField: "leak-me-not",
      },
    });

    const result = slackProvider.mapEvent(enrichedEnvelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const text = (JSON.parse(payload.body as string) as SlackBody).text;

    expect(text).not.toContain("user@example.com");
    expect(text).not.toContain("attrs-user@example.com");
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain("+15559876543");
    expect(text).not.toContain("203.0.113.5");
    expect(text).not.toContain("MyApp/1.0");
    expect(text).not.toContain("app_user_1");
    expect(text).not.toContain("amp_1");
    expect(text).not.toContain("customTag");
    expect(text).not.toContain("super-secret-plan-name");
    expect(text).not.toContain("leak-me-not");
    // The subscriber id itself is masked, never printed in full.
    expect(text).not.toContain(enrichedEnvelope.subscriberId as string);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix
// ---------------------------------------------------------------------------

describe("slackProvider.deliver", () => {
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
    body: JSON.stringify({ text: ":moneybag: revenue.RENEWAL" }),
  };
  const creds = { webhook_url: VALID_WEBHOOK_URL };

  it("200 with body 'ok' -> ok + retriable:false", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(200, "ok");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("404 -> !ok + retriable:false (no_service)", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(404, "no_service");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("410 -> !ok + retriable:false (no_service)", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(410, "no_service");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("400 -> !ok + retriable:false (invalid_payload)", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(400, "invalid_payload");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(429, "rate_limited");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(500, "server_error");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("503 -> !ok + retriable:true", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(503, "server_error");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("200 with an unexpected body (not exactly 'ok') -> !ok + retriable:false", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(200, "unexpected");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("403 -> !ok + retriable:false", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(403, "action_prohibited");
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("never reaches the network when webhook_url fails the host allowlist at deliver time", async () => {
    const http = createUndiciHttpClient();
    const result = await slackProvider.deliver(
      dummyPayload,
      { webhook_url: "https://evil.example.com/x" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.httpStatus).toBe(0);
  });

  it("sends the exact { text } body from mapEvent", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "ok" };
      });
    const http = createUndiciHttpClient();
    await slackProvider.deliver(dummyPayload, creds, http);
    expect(observedBody).toBe(dummyPayload.body);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — real "Rovenue connected" message
// ---------------------------------------------------------------------------

describe("slackProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("posts a real 'Rovenue connected' message and returns ok on 200 'ok'", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: "ok" };
      });
    const http = createUndiciHttpClient();
    const result = await slackProvider.validateCredentials(
      { webhook_url: VALID_WEBHOOK_URL },
      http,
    );
    expect(result).toEqual({ ok: true });
    const sent = JSON.parse(observedBody ?? "{}") as SlackBody;
    expect(sent.text).toBe("Rovenue connected :white_check_mark:");
  });

  it("fails without a network call when webhook_url fails the host allowlist", async () => {
    const http = createUndiciHttpClient();
    const result = await slackProvider.validateCredentials(
      { webhook_url: "https://not-slack.example.com/services/x" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("returns !ok when Slack rejects the probe", async () => {
    agent
      .get("https://hooks.slack.com")
      .intercept({ path: /\/services\/.*/, method: "POST" })
      .reply(404, "no_service");
    const http = createUndiciHttpClient();
    const result = await slackProvider.validateCredentials(
      { webhook_url: VALID_WEBHOOK_URL },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eventCatalog / topics / defaultEventMapping
// ---------------------------------------------------------------------------

describe("slackProvider static config", () => {
  it("eventCatalog is exactly the 17 public event keys", () => {
    expect([...slackProvider.eventCatalog].sort()).toEqual([...ROVENUE_EVENT_KEYS].sort());
  });

  it("topics include all four fanout topics", () => {
    expect([...slackProvider.topics].sort()).toEqual(
      [
        "rovenue.credit",
        "rovenue.paywall_events",
        "rovenue.revenue",
        "rovenue.subscription",
      ].sort(),
    );
  });

  it("defaultEventMapping maps every catalog key to itself", () => {
    for (const key of ROVENUE_EVENT_KEYS) {
      expect(slackProvider.defaultEventMapping[key]).toBe(key);
    }
  });

  it("allows only a single connection per project, like the other Wave-1 providers", () => {
    expect(slackProvider.allowMultipleConnections).toBe(false);
  });
});
