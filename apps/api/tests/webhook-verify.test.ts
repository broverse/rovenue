import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks — the middleware imports these
// =============================================================

const mocks = vi.hoisted(() => {
  const appleVerifier = {
    verifyNotification: vi.fn(),
    verifyTransaction: vi.fn(),
    verifyRenewalInfo: vi.fn(),
  };

  const createAppleVerifier = vi.fn(() => appleVerifier);

  const verifyPubSubPushToken = vi.fn(async () => undefined);

  const loadAppleCredentials = vi.fn(async () => ({
    bundleId: "com.example.app",
  }));

  const env = {
    NODE_ENV: "test",
    PUBSUB_PUSH_AUDIENCE: "https://hooks.example.com/webhooks/google" as
      | string
      | undefined,
    PUBSUB_PUSH_SERVICE_ACCOUNT: undefined as string | undefined,
  };

  return {
    appleVerifier,
    createAppleVerifier,
    verifyPubSubPushToken,
    loadAppleCredentials,
    env,
  };
});

vi.mock("../src/services/apple/apple-verify", () => ({
  createAppleVerifier: mocks.createAppleVerifier,
  JoseAppleNotificationVerifier: class {
    verifyNotification = mocks.appleVerifier.verifyNotification;
  },
  decodeUnverifiedJws: () => ({ data: { environment: "Sandbox" } }),
}));

vi.mock("../src/services/google/google-auth", () => ({
  verifyPubSubPushToken: mocks.verifyPubSubPushToken,
}));

vi.mock("../src/lib/project-credentials", () => ({
  loadAppleCredentials: mocks.loadAppleCredentials,
}));

vi.mock("../src/lib/env", () => ({ env: mocks.env }));

// =============================================================
// Import middleware (after mocks)
// =============================================================

import {
  verifyAppleWebhook,
  verifyGoogleWebhook,
} from "../src/middleware/webhook-verify";

function makeApp(
  middleware: Parameters<typeof Hono.prototype.use>[1],
): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: String(err) }, 500);
  });
  app.post("/:projectId", middleware, (c) => {
    const verified = c.get("verifiedWebhook");
    return c.json({
      ok: true,
      source: verified?.source,
      eventId: c.get("webhookEventId"),
      eventTimestamp: c.get("webhookEventTimestamp"),
    });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.NODE_ENV = "test";
  mocks.env.PUBSUB_PUSH_AUDIENCE = "https://hooks.example.com/webhooks/google";
  mocks.env.PUBSUB_PUSH_SERVICE_ACCOUNT = undefined;
  mocks.loadAppleCredentials.mockResolvedValue({ bundleId: "com.example.app" });
});

// =============================================================
// Apple
// =============================================================

describe("verifyAppleWebhook", () => {
  test("verifies JWS and stashes the decoded notification", async () => {
    mocks.appleVerifier.verifyNotification.mockResolvedValue({
      notificationType: "SUBSCRIBED",
      notificationUUID: "uuid-1",
    });

    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "fake.jws.token" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.appleVerifier.verifyNotification).toHaveBeenCalledWith(
      "fake.jws.token",
    );
    expect(mocks.createAppleVerifier).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_a",
        bundleId: "com.example.app",
      }),
    );
  });

  test("401 when JWS signature verification fails", async () => {
    mocks.appleVerifier.verifyNotification.mockRejectedValue(
      new Error("bad signature"),
    );

    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "tampered.jws.token" }),
    });

    expect(res.status).toBe(401);
  });

  test("400 when the body has no signedPayload", async () => {
    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("401 in production when the project has no Apple credentials", async () => {
    mocks.env.NODE_ENV = "production";
    mocks.loadAppleCredentials.mockResolvedValue(null);

    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "fake.jws.token" }),
    });

    expect(res.status).toBe(401);
    expect(mocks.createAppleVerifier).not.toHaveBeenCalled();
  });

  test("stashes notificationUUID + signedDate on ctx", async () => {
    mocks.appleVerifier.verifyNotification.mockResolvedValue({
      notificationType: "SUBSCRIBED",
      notificationUUID: "uuid-stashed",
      signedDate: 1_700_000_000_000, // ms since epoch, as Apple sends
    });
    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "fake.jws" }),
    });
    const body = (await res.json()) as { eventId: string; eventTimestamp: number };
    expect(body.eventId).toBe("uuid-stashed");
    expect(body.eventTimestamp).toBe(1_700_000_000);
  });

  test("503 when createAppleVerifier throws (fingerprint mismatch)", async () => {
    mocks.createAppleVerifier.mockImplementationOnce(() => {
      throw new Error("Apple root CA fingerprint not in pinned allowlist: ff...");
    });

    const app = makeApp(verifyAppleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "fake.jws" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("temporarily unavailable");
  });
});

// =============================================================
// Google
// =============================================================

describe("verifyGoogleWebhook", () => {
  test("accepts a valid Pub/Sub OIDC Bearer token", async () => {
    mocks.verifyPubSubPushToken.mockResolvedValue(undefined);

    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer valid-id-token",
      },
      body: JSON.stringify({
        message: { data: "eyJ4Ijoxfg==", messageId: "m1", publishTime: "t" },
        subscription: "projects/p/subscriptions/s",
      }),
    });

    expect(res.status).toBe(200);
    expect(mocks.verifyPubSubPushToken).toHaveBeenCalledWith(
      "valid-id-token",
      expect.objectContaining({
        audience: "https://hooks.example.com/webhooks/google",
      }),
    );
  });

  test("401 when Bearer token is missing", async () => {
    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { data: "x", messageId: "m1", publishTime: "t" },
        subscription: "projects/p/subscriptions/s",
      }),
    });

    expect(res.status).toBe(401);
    expect(mocks.verifyPubSubPushToken).not.toHaveBeenCalled();
  });

  test("401 when OIDC token verification throws", async () => {
    mocks.verifyPubSubPushToken.mockRejectedValue(new Error("bad audience"));

    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer forged-token",
      },
      body: JSON.stringify({
        message: { data: "x", messageId: "m1", publishTime: "t" },
        subscription: "projects/p/subscriptions/s",
      }),
    });

    expect(res.status).toBe(401);
  });

  test("passthrough when PUBSUB_PUSH_AUDIENCE is not configured (dev mode)", async () => {
    mocks.env.PUBSUB_PUSH_AUDIENCE = "";

    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { data: "x", messageId: "m1", publishTime: "t" },
        subscription: "projects/p/subscriptions/s",
      }),
    });

    expect(res.status).toBe(200);
    expect(mocks.verifyPubSubPushToken).not.toHaveBeenCalled();
  });

  test("stashes message.messageId + publishTime on ctx", async () => {
    mocks.verifyPubSubPushToken.mockResolvedValue(undefined);
    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer valid-id-token",
      },
      body: JSON.stringify({
        message: {
          data: "eyJ4Ijoxfg==",
          messageId: "msg-xyz",
          publishTime: "2026-04-21T10:00:00Z",
        },
        subscription: "projects/p/subscriptions/s",
      }),
    });
    const body = (await res.json()) as { eventId: string; eventTimestamp: number };
    expect(body.eventId).toBe("msg-xyz");
    expect(body.eventTimestamp).toBe(
      Math.floor(new Date("2026-04-21T10:00:00Z").getTime() / 1000),
    );
  });

  test("400 when Google push body is not valid JSON", async () => {
    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer valid-id-token",
      },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not valid JSON");
  });

  test("dev-mode passthrough still stashes event id + timestamp", async () => {
    mocks.env.PUBSUB_PUSH_AUDIENCE = undefined;
    const app = makeApp(verifyGoogleWebhook);
    const res = await app.request("/proj_a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          data: "eyJ4Ijoxfg==",
          messageId: "dev-msg-1",
          publishTime: "2026-04-21T10:00:00Z",
        },
        subscription: "projects/p/subscriptions/s",
      }),
    });
    const body = (await res.json()) as {
      source: string;
      eventId: string;
      eventTimestamp: number;
    };
    expect(res.status).toBe(200);
    expect(body.source).toBe("GOOGLE");
    expect(body.eventId).toBe("dev-msg-1");
    expect(body.eventTimestamp).toBe(
      Math.floor(new Date("2026-04-21T10:00:00Z").getTime() / 1000),
    );
  });
});
