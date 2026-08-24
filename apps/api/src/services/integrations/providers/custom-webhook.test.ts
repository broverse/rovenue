import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { Webhook as SvixWebhook } from "svix";
import { ROVENUE_EVENT_KEYS, WEBHOOK_API_VERSION } from "@rovenue/shared";
import type { RovenueEventKey } from "@rovenue/shared";
import {
  customWebhookProvider,
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

  it("truncates responseBody to RESPONSE_BODY_MAX_BYTES", async () => {
    const { port } = await listen((req, res) => {
      res.writeHead(500);
      res.end("x".repeat(5000));
    });
    const result = await customWebhookProvider.deliver(payload, credsFor(port), noopHttp);
    expect(result.responseBody.length).toBeLessThanOrEqual(4096);
  });
});

describe("WEBHOOK_DELIVERY_TIMEOUT_MS", () => {
  it("is a positive number", () => {
    expect(WEBHOOK_DELIVERY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
