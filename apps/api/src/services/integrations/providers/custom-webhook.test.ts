import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { Webhook as SvixWebhook } from "svix";
import { ROVENUE_EVENT_KEYS, WEBHOOK_API_VERSION } from "@rovenue/shared";
import type { RovenueEventKey } from "@rovenue/shared";
import {
  activeWebhookSecretKeys,
  activeWebhookSecrets,
  customWebhookProvider,
  newestSecretEntry,
  parseWebhookCredentials,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
} from "./custom-webhook";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
  HttpClient,
} from "../types";

const ALL_EVENTS: RovenueEventKey[] = [...ROVENUE_EVENT_KEYS];

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
    subscriberId: "sub1",
    productId: "prod1",
    identityContext: { email: "u@x.com", externalId: "ext-1" },
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

const noopHttp: HttpClient = {
  async request() {
    throw new Error("noopHttp should never be called by CUSTOM_WEBHOOK");
  },
};

// ---------------------------------------------------------------------------
// parseWebhookCredentials
// ---------------------------------------------------------------------------

describe("parseWebhookCredentials", () => {
  it("parses url + JSON-encoded secrets array", () => {
    const secrets = [{ id: "s1", key: "whsec_abc", createdAt: "2024-01-01T00:00:00.000Z" }];
    const result = parseWebhookCredentials({
      url: "https://example.com/hook",
      secrets: JSON.stringify(secrets),
    });
    expect(result.url).toBe("https://example.com/hook");
    expect(result.secrets).toEqual(secrets);
  });

  it("degrades to an empty secrets array on malformed JSON", () => {
    const result = parseWebhookCredentials({
      url: "https://example.com/hook",
      secrets: "not-json",
    });
    expect(result.secrets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// activeWebhookSecrets / newestSecretEntry — rotation-relative expiry
// ---------------------------------------------------------------------------

describe("activeWebhookSecrets", () => {
  const NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");
  const unstamped = { id: "s_cur", key: "whsec_cur", createdAt: "2024-01-01T00:00:00.000Z" };
  const stampedFuture = {
    id: "s_grace",
    key: "whsec_grace",
    createdAt: "2023-01-01T00:00:00.000Z",
    expiresAt: "2026-08-25T12:00:00.000Z",
  };
  const stampedPast = {
    id: "s_gone",
    key: "whsec_gone",
    createdAt: "2023-01-01T00:00:00.000Z",
    expiresAt: "2026-08-23T12:00:00.000Z",
  };

  it("keeps unstamped entries however old they are", () => {
    expect(activeWebhookSecrets([unstamped], NOW_MS)).toEqual([unstamped]);
  });

  it("keeps a rotated-out entry until its stamped expiry passes", () => {
    expect(activeWebhookSecretKeys([unstamped, stampedFuture], NOW_MS)).toEqual([
      "whsec_cur",
      "whsec_grace",
    ]);
  });

  it("drops an entry whose stamped expiry has passed", () => {
    expect(activeWebhookSecretKeys([unstamped, stampedPast], NOW_MS)).toEqual(["whsec_cur"]);
  });

  it("fails closed on an unparseable expiresAt", () => {
    expect(
      activeWebhookSecrets([{ ...unstamped, expiresAt: "not-a-date" }], NOW_MS),
    ).toEqual([]);
  });

  it("newestSecretEntry ignores rotated-out entries even when they sort newer", () => {
    const rotatedOutButNewer = {
      id: "s_new_but_out",
      key: "whsec_out",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-08-25T12:00:00.000Z",
    };
    expect(newestSecretEntry([rotatedOutButNewer, unstamped])?.id).toBe("s_cur");
  });
});

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

describe("customWebhookProvider.mapEvent", () => {
  it("derives revenue.${kind} for revenue envelopes and strips identityContext PII", () => {
    const result = customWebhookProvider.mapEvent(makeEnvelope(), makeConfig(), {});
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe("revenue.RENEWAL");
    expect(payload.providerEvent).toBe("revenue.RENEWAL");

    const body = JSON.parse(payload.body as string);
    expect(body.id).toBe("ob1");
    expect(body.type).toBe("revenue.RENEWAL");
    expect(body.created).toBe("2024-01-15T10:00:00.000Z");
    expect(body.apiVersion).toBe(WEBHOOK_API_VERSION);
    expect(body.projectId).toBe("proj1");
    expect(body.data).toEqual({
      kind: "RENEWAL",
      amount: "9.99",
      currency: "USD",
      subscriberId: "sub1",
      productId: "prod1",
      externalId: "ext-1",
    });
    // No email/phone/ip/userAgent leaked into the webhook payload.
    expect(JSON.stringify(body)).not.toContain("u@x.com");
  });

  it("Fix 1 (final review): REACTIVATION reversal envelope carries `reason` in the delivered body", () => {
    // metadata.reason is how applyRefundReversed's accounting reversal is
    // told apart from a win-back — both produce revenue.REACTIVATION.
    const reversalEnvelope = makeEnvelope({
      revenueEventKind: "REACTIVATION",
      revenueEventReason: "refund_reversed",
    });
    const result = customWebhookProvider.mapEvent(reversalEnvelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const body = JSON.parse(payload.body as string);
    expect(body.data.reason).toBe("refund_reversed");
  });

  it("Fix 1 (final review): win-back REACTIVATION envelope (no metadata.reason) omits the `reason` key entirely", () => {
    const winBackEnvelope = makeEnvelope({
      revenueEventKind: "REACTIVATION",
      revenueEventReason: undefined,
    });
    const result = customWebhookProvider.mapEvent(winBackEnvelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const body = JSON.parse(payload.body as string);
    // Absence is the documented default — not `reason: null`.
    expect(body.data).not.toHaveProperty("reason");
  });

  it("regression (Task 2): buildWebhookData never surfaces enriched identityContext/subscriberAttributes", () => {
    // A worker that ran delivery-time enrichment (enrichEnvelope) before
    // calling mapEvent hands this provider an envelope carrying
    // identityContext.email (possibly backfilled from a $email attribute)
    // and a subscriberAttributes bag. CUSTOM_WEBHOOK must keep ignoring
    // both — buildWebhookData only reads externalId off identityContext
    // for revenue envelopes and never reads subscriberAttributes at all.
    const enrichedEnvelope = makeEnvelope({
      identityContext: { email: "enriched@example.com", externalId: "ext-1" },
      subscriberAttributes: {
        $email: "enriched@example.com",
        appUserId: "user_1",
        country: "US",
      },
    });
    const result = customWebhookProvider.mapEvent(enrichedEnvelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const body = JSON.parse(payload.body as string);

    expect(body.data).not.toHaveProperty("subscriberAttributes");
    expect(body.data).not.toHaveProperty("email");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("enriched@example.com");
    expect(serialized).not.toContain("subscriberAttributes");
  });

  it("uses envelope.eventKey directly for non-revenue envelopes, passthrough payload", () => {
    const envelope = makeEnvelope({
      eventType: "subscription.trial.started",
      revenueEventKind: undefined,
      eventKey: "subscription.trial.started",
      payload: { foo: "bar" },
    });
    const result = customWebhookProvider.mapEvent(envelope, makeConfig(), {});
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.eventKey).toBe("subscription.trial.started");
    const body = JSON.parse(payload.body as string);
    expect(body.type).toBe("subscription.trial.started");
    expect(body.data).toEqual({ foo: "bar" });
  });

  it("defaults data to {} when a non-revenue envelope carries no payload", () => {
    const envelope = makeEnvelope({
      eventType: "subscriber.identified",
      revenueEventKind: undefined,
      eventKey: "subscriber.identified",
      payload: undefined,
    });
    const result = customWebhookProvider.mapEvent(envelope, makeConfig(), {});
    const payload = result as ProviderPayload;
    const body = JSON.parse(payload.body as string);
    expect(body.data).toEqual({});
  });

  it("skips when eventKey is not in config.enabledEvents", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = customWebhookProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });
});

// ---------------------------------------------------------------------------
// validateCredentials — no network call
// ---------------------------------------------------------------------------

describe("customWebhookProvider.validateCredentials", () => {
  it("ok when url is public https and at least one secret exists", async () => {
    const creds = {
      url: "https://example.com/hook",
      secrets: JSON.stringify([{ id: "s1", key: "whsec_abc", createdAt: "2024-01-01T00:00:00.000Z" }]),
    };
    const result = await customWebhookProvider.validateCredentials(creds, noopHttp);
    expect(result).toEqual({ ok: true });
  });

  it("!ok with WebhookUrlError reason for a non-public url", async () => {
    const creds = {
      url: "ftp://example.com/hook",
      secrets: JSON.stringify([{ id: "s1", key: "whsec_abc", createdAt: "2024-01-01T00:00:00.000Z" }]),
    };
    const result = await customWebhookProvider.validateCredentials(creds, noopHttp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/scheme/);
  });

  it("!ok when there are no secrets", async () => {
    const creds = { url: "https://example.com/hook", secrets: "[]" };
    const result = await customWebhookProvider.validateCredentials(creds, noopHttp);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCredentialsHint
// ---------------------------------------------------------------------------

describe("customWebhookProvider.buildCredentialsHint", () => {
  it("formats host + last 4 chars of the newest secret", () => {
    const creds = {
      url: "https://example.com/hook",
      secrets: JSON.stringify([
        { id: "s1", key: "whsec_aaaa1111", createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "s2", key: "whsec_bbbb2222", createdAt: "2024-02-01T00:00:00.000Z" },
      ]),
    };
    const hint = customWebhookProvider.buildCredentialsHint!(creds);
    expect(hint).toBe("example.com · …2222");
  });
});

// ---------------------------------------------------------------------------
// deliver — real local HTTP server, no mocks (default test env is
// non-production, so http:// + 127.0.0.1 are allowed by the SSRF guard).
// ---------------------------------------------------------------------------

describe("customWebhookProvider.deliver", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function listen(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  ): Promise<{ port: number; bodies: string[] }> {
    const bodies: string[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push(raw);
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return { port, bodies };
  }

  function credsFor(port: number, secretKey = "whsec_ZGVhZGJlZWZkZWFkYmVlZg=="): Record<string, string> {
    return {
      url: `http://127.0.0.1:${port}/hook`,
      secrets: JSON.stringify([{ id: "s1", key: secretKey, createdAt: "2024-01-01T00:00:00.000Z" }]),
    };
  }

  const payload: ProviderPayload = {
    eventKey: "revenue.RENEWAL",
    providerEvent: "revenue.RENEWAL",
    body: JSON.stringify({
      id: "ob-deliver-1",
      type: "revenue.RENEWAL",
      created: "2024-01-15T10:00:00.000Z",
      apiVersion: WEBHOOK_API_VERSION,
      projectId: "proj1",
      data: { kind: "RENEWAL" },
    }),
  };

  it("200 → ok, retriable:false, and signs with Svix-format dual headers verifiable by the svix package", async () => {
    const secretKey = "whsec_ZGVhZGJlZWZkZWFkYmVlZg==";
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const { port, bodies } = await listen((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const result = await customWebhookProvider.deliver(payload, credsFor(port, secretKey), noopHttp);

    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(bodies[0]).toBe(payload.body);

    expect(receivedHeaders["webhook-id"]).toBe("ob-deliver-1");
    expect(receivedHeaders["svix-id"]).toBe("ob-deliver-1");
    expect(receivedHeaders["webhook-signature"]).toBe(receivedHeaders["svix-signature"]);

    const wh = new SvixWebhook(secretKey);
    expect(() =>
      wh.verify(bodies[0]!, {
        "svix-id": String(receivedHeaders["svix-id"]),
        "svix-timestamp": String(receivedHeaders["svix-timestamp"]),
        "svix-signature": String(receivedHeaders["svix-signature"]),
      }),
    ).not.toThrow();
  });

  it("3xx → ok:false, retriable:false, errorMessage mentions redirects are not followed", async () => {
    const { port } = await listen((req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      res.end();
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.errorMessage).toMatch(/redirects are not followed/);
  });

  it.each([408, 425, 429])("%i → ok:false, retriable:true", async (status) => {
    const { port } = await listen((req, res) => {
      res.writeHead(status);
      res.end();
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.httpStatus).toBe(status);
  });

  it("other 4xx (e.g. 404) → ok:false, retriable:false", async () => {
    const { port } = await listen((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("5xx → ok:false, retriable:true", async () => {
    const { port } = await listen((req, res) => {
      res.writeHead(503);
      res.end();
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("network error (connection refused) → ok:false, retriable:true", async () => {
    // Nothing listening on this port.
    const creds = credsFor(1);
    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("send-time WebhookUrlError (e.g. non-http(s) scheme) → ok:false, retriable:false, errorMessage = the guard's reason", async () => {
    const creds = {
      url: "ftp://example.com/hook",
      secrets: JSON.stringify([{ id: "s1", key: "whsec_abc", createdAt: "2024-01-01T00:00:00.000Z" }]),
    };
    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.errorMessage).toMatch(/scheme/);
  });

  it("truncates responseBody to exactly RESPONSE_BODY_MAX_BYTES on a large response, without hanging", async () => {
    // 2 MiB response — proves the read is capped at the transport level
    // (readCappedBody stops and destroys the stream), not just sliced after
    // fully buffering an attacker-chosen, arbitrarily large body.
    const { port } = await listen((req, res) => {
      res.writeHead(500);
      res.end("y".repeat(2 * 1024 * 1024));
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.responseBody.length).toBe(4096);
  });

  // Rotated-out keys carry a rotation-stamped `expiresAt`. They must stop
  // signing the moment it passes, even if no later rotation has pruned them
  // from the stored array yet.
  it("signs with the active key only, skipping a rotated-out key whose grace window closed", async () => {
    const activeKey = "whsec_ZGVhZGJlZWZkZWFkYmVlZg==";
    const expiredKey = "whsec_YmVlZmRlYWRiZWVmZGVhZA==";
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const { port } = await listen((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });

    const creds = {
      url: `http://127.0.0.1:${port}/hook`,
      secrets: JSON.stringify([
        { id: "s_new", key: activeKey, createdAt: "2024-02-01T00:00:00.000Z" },
        {
          id: "s_old",
          key: expiredKey,
          createdAt: "2024-01-01T00:00:00.000Z",
          expiresAt: "2024-02-02T00:00:00.000Z",
        },
      ]),
    };

    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);

    expect(result.ok).toBe(true);
    const signature = receivedHeaders["svix-signature"] as string;
    expect(signature.split(" ").filter((p) => p.startsWith("v1,"))).toHaveLength(1);
    expect(() =>
      new SvixWebhook(activeKey).verify(payload.body as string, {
        "svix-id": receivedHeaders["svix-id"] as string,
        "svix-timestamp": receivedHeaders["svix-timestamp"] as string,
        "svix-signature": signature,
      }),
    ).not.toThrow();
    expect(() =>
      new SvixWebhook(expiredKey).verify(payload.body as string, {
        "svix-id": receivedHeaders["svix-id"] as string,
        "svix-timestamp": receivedHeaders["svix-timestamp"] as string,
        "svix-signature": signature,
      }),
    ).toThrow();
  });

  it("all secrets expired → non-retriable failure, no request ever sent", async () => {
    const requestsSeen: string[] = [];
    server = createServer((req, res) => {
      requestsSeen.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const creds = {
      url: `http://127.0.0.1:${port}/hook`,
      secrets: JSON.stringify([
        {
          id: "s_old",
          key: "whsec_ZGVhZGJlZWZkZWFkYmVlZg==",
          createdAt: "2024-01-01T00:00:00.000Z",
          expiresAt: "2024-01-02T00:00:00.000Z",
        },
      ]),
    };
    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.errorMessage).toMatch(/secret/i);
    expect(requestsSeen).toHaveLength(0);
  });

  it("empty secrets array → non-retriable failure, no request ever sent", async () => {
    const requestsSeen: string[] = [];
    server = createServer((req, res) => {
      requestsSeen.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const creds = { url: `http://127.0.0.1:${port}/hook`, secrets: "[]" };
    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.errorMessage).toMatch(/secret/i);
    expect(requestsSeen).toHaveLength(0);
  });

  it("malformed secrets JSON (degrades to []) → non-retriable failure, no request ever sent", async () => {
    const requestsSeen: string[] = [];
    server = createServer((req, res) => {
      requestsSeen.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const creds = { url: `http://127.0.0.1:${port}/hook`, secrets: "not-json" };
    const result = await customWebhookProvider.deliver(payload, creds, noopHttp);

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(requestsSeen).toHaveLength(0);
  });

  it("payload.body with no id → non-retriable failure, no request ever sent, never sends webhook-id: \"\"", async () => {
    const requestsSeen: string[] = [];
    server = createServer((req, res) => {
      requestsSeen.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const noIdPayload: ProviderPayload = {
      eventKey: "revenue.RENEWAL",
      providerEvent: "revenue.RENEWAL",
      body: JSON.stringify({ type: "revenue.RENEWAL", data: {} }), // no "id"
    };
    const result = await customWebhookProvider.deliver(noIdPayload, credsFor(port), noopHttp);

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.errorMessage).toMatch(/id/i);
    expect(requestsSeen).toHaveLength(0);
  });

  it("unparseable payload.body → non-retriable failure, no request ever sent", async () => {
    const requestsSeen: string[] = [];
    server = createServer((req, res) => {
      requestsSeen.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const brokenPayload: ProviderPayload = {
      eventKey: "revenue.RENEWAL",
      providerEvent: "revenue.RENEWAL",
      body: "not json at all",
    };
    const result = await customWebhookProvider.deliver(brokenPayload, credsFor(port), noopHttp);

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(requestsSeen).toHaveLength(0);
  });

  it("does not leak sockets/agents across deliveries — repeated sequential deliveries all succeed", async () => {
    const { port } = await listen((req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    for (let i = 0; i < 10; i++) {
      const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
      expect(result.ok).toBe(true);
    }
  });
});

describe("WEBHOOK_DELIVERY_TIMEOUT_MS", () => {
  it("is a positive number", () => {
    expect(WEBHOOK_DELIVERY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
