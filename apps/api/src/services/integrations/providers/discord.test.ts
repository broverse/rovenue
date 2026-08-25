import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import {
  discordProvider,
  DISCORD_WEBHOOK_HOST,
  DISCORD_WEBHOOK_HOST_LEGACY,
  isAllowedDiscordWebhookUrl,
} from "./discord";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
} from "../types";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789012345678/AbCdEf-token_string";
const VALID_LEGACY_WEBHOOK_URL =
  "https://discordapp.com/api/webhooks/123456789012345678/AbCdEf-token_string";

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

type DiscordBody = { content: string };

// ---------------------------------------------------------------------------
// credentialsSchema — host + path allowlist (accept/reject)
// ---------------------------------------------------------------------------

describe("discordProvider.credentialsSchema", () => {
  it("accepts a valid https://discord.com/api/webhooks/... URL", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({ webhook_url: VALID_WEBHOOK_URL }).success,
    ).toBe(true);
  });

  it("accepts the legacy https://discordapp.com/api/webhooks/... host", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({ webhook_url: VALID_LEGACY_WEBHOOK_URL })
        .success,
    ).toBe(true);
  });

  it("rejects an empty object (missing webhook_url)", () => {
    expect(discordProvider.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty webhook_url", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({ webhook_url: "" }).success,
    ).toBe(false);
  });

  it("rejects http:// (non-https)", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({
        webhook_url: "http://discord.com/api/webhooks/123/abc",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong host", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({
        webhook_url: "https://evil.example.com/api/webhooks/123/abc",
      }).success,
    ).toBe(false);
  });

  it("rejects a host-suffix bypass (discord.com.evil.example)", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({
        webhook_url: "https://discord.com.evil.example/api/webhooks/123/abc",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong path prefix on an otherwise valid host", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({
        webhook_url: "https://discord.com/webhooks/123/abc",
      }).success,
    ).toBe(false);
    expect(
      discordProvider.credentialsSchema.safeParse({
        webhook_url: "https://discord.com/api/other/123",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL string", () => {
    expect(
      discordProvider.credentialsSchema.safeParse({ webhook_url: "not a url" }).success,
    ).toBe(false);
  });
});

describe("isAllowedDiscordWebhookUrl", () => {
  it("DISCORD_WEBHOOK_HOST is exactly discord.com; legacy host is discordapp.com", () => {
    expect(DISCORD_WEBHOOK_HOST).toBe("discord.com");
    expect(DISCORD_WEBHOOK_HOST_LEGACY).toBe("discordapp.com");
  });

  it("accepts both valid host+path+https combinations", () => {
    expect(isAllowedDiscordWebhookUrl(VALID_WEBHOOK_URL)).toBe(true);
    expect(isAllowedDiscordWebhookUrl(VALID_LEGACY_WEBHOOK_URL)).toBe(true);
  });

  it("rejects wrong protocol, wrong host, wrong path, host-suffix bypass, and unparseable input", () => {
    expect(isAllowedDiscordWebhookUrl("http://discord.com/api/webhooks/123/abc")).toBe(false);
    expect(isAllowedDiscordWebhookUrl("https://not-discord.example.com/api/webhooks/123/abc")).toBe(
      false,
    );
    expect(isAllowedDiscordWebhookUrl("https://discord.com/webhooks/123/abc")).toBe(false);
    expect(
      isAllowedDiscordWebhookUrl("https://discord.com.evil.example/api/webhooks/123/abc"),
    ).toBe(false);
    expect(isAllowedDiscordWebhookUrl("::::not a url::::")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("discordProvider.mapEvent", () => {
  it("maps a revenue.* envelope via revenueEventKind and does not require outboxEventId", () => {
    const result = discordProvider.mapEvent(
      makeEnvelope({ outboxEventId: "", revenueEventKind: "RENEWAL" }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    const body = JSON.parse(payload.body as string) as DiscordBody;
    expect(body.content).toContain("revenue.RENEWAL");
  });

  it("maps a subscription-topic envelope (eventKey already set by fanout)", () => {
    const result = discordProvider.mapEvent(
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
    const result = discordProvider.mapEvent(
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
    const result = discordProvider.mapEvent(
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
    const result = discordProvider.mapEvent(
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
    const result = discordProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("body is { content } JSON", () => {
    const result = discordProvider.mapEvent(makeEnvelope(), makeConfig(), {});
    const payload = result as ProviderPayload;
    const parsed = JSON.parse(payload.body as string) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["content"]);
    expect(typeof parsed.content).toBe("string");
  });

  // -----------------------------------------------------------------------
  // PII absence — the load-bearing safety property of this provider,
  // inherited entirely from the shared chat-message builder (adversarial
  // test byte-identical in spirit to slack.test.ts's).
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
        raw: "should never be read by buildChatMessageText",
        secretField: "leak-me-not",
      },
    });

    const result = discordProvider.mapEvent(enrichedEnvelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const content = (JSON.parse(payload.body as string) as DiscordBody).content;

    expect(content).not.toContain("user@example.com");
    expect(content).not.toContain("attrs-user@example.com");
    expect(content).not.toContain("+15551234567");
    expect(content).not.toContain("+15559876543");
    expect(content).not.toContain("203.0.113.5");
    expect(content).not.toContain("MyApp/1.0");
    expect(content).not.toContain("app_user_1");
    expect(content).not.toContain("amp_1");
    expect(content).not.toContain("customTag");
    expect(content).not.toContain("super-secret-plan-name");
    expect(content).not.toContain("leak-me-not");
    // The subscriber id itself is masked, never printed in full.
    expect(content).not.toContain(enrichedEnvelope.subscriberId as string);
  });
});

// ---------------------------------------------------------------------------
// deliver — classification matrix
// ---------------------------------------------------------------------------

describe("discordProvider.deliver", () => {
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
    body: JSON.stringify({ content: "💰 revenue.RENEWAL" }),
  };
  const creds = { webhook_url: VALID_WEBHOOK_URL };

  it("204 No Content -> ok + retriable:false", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(204, "");
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("200 -> ok + retriable:false", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(200, JSON.stringify({ id: "1" }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("404 -> !ok + retriable:false (unknown webhook)", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(404, JSON.stringify({ message: "Unknown Webhook", code: 10015 }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("401 -> !ok + retriable:false", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(401, JSON.stringify({ message: "401: Unauthorized" }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("403 -> !ok + retriable:false", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(403, JSON.stringify({ message: "403: Forbidden" }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("400 -> !ok + retriable:false", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(400, JSON.stringify({ message: "Invalid Form Body" }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("429 -> !ok + retriable:true", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(429, JSON.stringify({ message: "You are being rate limited.", retry_after: 1.5 }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("500 -> !ok + retriable:true", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(500, "server_error");
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("503 -> !ok + retriable:true", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(503, "server_error");
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(dummyPayload, creds, http);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("never reaches the network when webhook_url fails the host/path allowlist at deliver time", async () => {
    const http = createUndiciHttpClient();
    const result = await discordProvider.deliver(
      dummyPayload,
      { webhook_url: "https://evil.example.com/x" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.httpStatus).toBe(0);
  });

  it("sends the exact { content } body from mapEvent", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 204, data: "" };
      });
    const http = createUndiciHttpClient();
    await discordProvider.deliver(dummyPayload, creds, http);
    expect(observedBody).toBe(dummyPayload.body);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — real "Rovenue connected ✅" message
// ---------------------------------------------------------------------------

describe("discordProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("posts a real 'Rovenue connected' message and returns ok on 204", async () => {
    let observedBody: string | undefined;
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 204, data: "" };
      });
    const http = createUndiciHttpClient();
    const result = await discordProvider.validateCredentials(
      { webhook_url: VALID_WEBHOOK_URL },
      http,
    );
    expect(result).toEqual({ ok: true });
    const sent = JSON.parse(observedBody ?? "{}") as DiscordBody;
    expect(sent.content).toBe("Rovenue connected ✅");
  });

  it("fails without a network call when webhook_url fails the host/path allowlist", async () => {
    const http = createUndiciHttpClient();
    const result = await discordProvider.validateCredentials(
      { webhook_url: "https://not-discord.example.com/api/webhooks/123/abc" },
      http,
    );
    expect(result.ok).toBe(false);
  });

  it("returns !ok when Discord rejects the probe", async () => {
    agent
      .get("https://discord.com")
      .intercept({ path: /\/api\/webhooks\/.*/, method: "POST" })
      .reply(404, JSON.stringify({ message: "Unknown Webhook" }));
    const http = createUndiciHttpClient();
    const result = await discordProvider.validateCredentials(
      { webhook_url: VALID_WEBHOOK_URL },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eventCatalog / topics / defaultEventMapping
// ---------------------------------------------------------------------------

describe("discordProvider static config", () => {
  it("eventCatalog is exactly the 17 public event keys", () => {
    expect([...discordProvider.eventCatalog].sort()).toEqual([...ROVENUE_EVENT_KEYS].sort());
  });

  it("topics include all four fanout topics", () => {
    expect([...discordProvider.topics].sort()).toEqual(
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
      expect(discordProvider.defaultEventMapping[key]).toBe(key);
    }
  });

  it("allows only a single connection per project, like every other first-class provider", () => {
    expect(discordProvider.allowMultipleConnections).toBe(false);
  });
});
