// =============================================================
// webhook-verify middleware — unit tests (W3.1 fail-closed cases)
// =============================================================
//
// Tests that verifyGoogleWebhook and verifyAppleWebhook fail closed
// (401) when verification is not configured and ALLOW_UNVERIFIED_WEBHOOKS
// is false (the default).
//
// env is parsed at module import time (frozen object), so we vi.mock
// the env module before any subject import and use dynamic imports
// inside each test to get a fresh module instance with the mocked
// env in place — matching the pattern in metrics.disabled.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Google — 401 when PUBSUB_PUSH_AUDIENCE unset + flag false
// ---------------------------------------------------------------------------

describe("verifyGoogleWebhook — fail-closed (W3.1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 401 when PUBSUB_PUSH_AUDIENCE is unset and ALLOW_UNVERIFIED_WEBHOOKS is false", async () => {
    // Re-mock env for this describe block with ALLOW_UNVERIFIED_WEBHOOKS=false
    vi.doMock("../lib/env", () => ({
      env: {
        PUBSUB_PUSH_AUDIENCE: undefined,
        ALLOW_UNVERIFIED_WEBHOOKS: false,
        NODE_ENV: "test",
        WEBHOOK_REPLAY_TOLERANCE_SECONDS: 300,
      },
    }));

    const { Hono } = await import("hono");
    const { verifyGoogleWebhook } = await import("./webhook-verify");

    const app = new Hono();
    app.post("/webhook/google", verifyGoogleWebhook, (c) =>
      c.json({ data: { ok: true } }),
    );

    const res = await app.request("/webhook/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { messageId: "msg-1", publishTime: new Date().toISOString() },
      }),
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("Pub/Sub verification not configured");
  });

  it("passes through when PUBSUB_PUSH_AUDIENCE is unset but ALLOW_UNVERIFIED_WEBHOOKS is true", async () => {
    vi.doMock("../lib/env", () => ({
      env: {
        PUBSUB_PUSH_AUDIENCE: undefined,
        ALLOW_UNVERIFIED_WEBHOOKS: true,
        NODE_ENV: "test",
        WEBHOOK_REPLAY_TOLERANCE_SECONDS: 300,
      },
    }));

    const { Hono } = await import("hono");
    const { verifyGoogleWebhook } = await import("./webhook-verify");

    const app = new Hono();
    app.post("/webhook/google", verifyGoogleWebhook, (c) =>
      c.json({ data: { ok: true } }),
    );

    const now = new Date().toISOString();
    const res = await app.request("/webhook/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { messageId: "msg-bypass", publishTime: now },
      }),
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Apple — 401 when no project credentials + flag false
// ---------------------------------------------------------------------------

describe("verifyAppleWebhook — fail-closed (W3.1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 401 when no Apple credentials and ALLOW_UNVERIFIED_WEBHOOKS is false", async () => {
    vi.doMock("../lib/env", () => ({
      env: {
        PUBSUB_PUSH_AUDIENCE: undefined,
        ALLOW_UNVERIFIED_WEBHOOKS: false,
        NODE_ENV: "test",
        WEBHOOK_REPLAY_TOLERANCE_SECONDS: 300,
      },
    }));

    // Mock project-credentials so loadAppleCredentials returns null (no creds)
    vi.doMock("../lib/project-credentials", () => ({
      loadAppleCredentials: vi.fn().mockResolvedValue(null),
      loadStripeCredentials: vi.fn().mockResolvedValue(null),
    }));

    const { Hono } = await import("hono");
    const { verifyAppleWebhook } = await import("./webhook-verify");

    const app = new Hono();
    app.post("/webhook/apple/:projectId", verifyAppleWebhook, (c) =>
      c.json({ data: { ok: true } }),
    );

    // A plausible (but not real) JWS-format signed payload — three base64url
    // segments separated by dots. The verifier won't reach verification since
    // we expect a 401 before that.
    const fakeSignedPayload =
      "eyJhbGciOiJFUzI1NiIsIng1YyI6W119.eyJub3RpZmljYXRpb25UeXBlIjoiVEVTVCJ9.AAAA";

    const res = await app.request("/webhook/apple/proj_test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: fakeSignedPayload }),
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("Apple webhook verification unavailable");
  });

  it("falls back to jose verifier when no Apple credentials but ALLOW_UNVERIFIED_WEBHOOKS is true", async () => {
    vi.doMock("../lib/env", () => ({
      env: {
        PUBSUB_PUSH_AUDIENCE: undefined,
        ALLOW_UNVERIFIED_WEBHOOKS: true,
        NODE_ENV: "test",
        WEBHOOK_REPLAY_TOLERANCE_SECONDS: 300,
      },
    }));

    vi.doMock("../lib/project-credentials", () => ({
      loadAppleCredentials: vi.fn().mockResolvedValue(null),
      loadStripeCredentials: vi.fn().mockResolvedValue(null),
    }));

    // Mock JoseAppleNotificationVerifier to succeed (avoids needing a real JWS)
    vi.doMock("../services/apple/apple-verify", () => ({
      decodeUnverifiedJws: vi.fn().mockReturnValue({ data: { environment: "Sandbox" } }),
      createAppleVerifier: vi.fn(),
      JoseAppleNotificationVerifier: class {
        async verifyNotification() {
          return {
            notificationUUID: "test-uuid",
            signedDate: new Date().toISOString(),
            notificationType: "TEST",
            data: {},
          };
        }
      },
    }));

    const { Hono } = await import("hono");
    const { verifyAppleWebhook } = await import("./webhook-verify");

    const app = new Hono();
    app.post("/webhook/apple/:projectId", verifyAppleWebhook, (c) =>
      c.json({ data: { ok: true } }),
    );

    const fakeSignedPayload =
      "eyJhbGciOiJFUzI1NiIsIng1YyI6W119.eyJub3RpZmljYXRpb25UeXBlIjoiVEVTVCJ9.AAAA";

    const res = await app.request("/webhook/apple/proj_test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: fakeSignedPayload }),
    });

    // Should reach the handler (not 401) — jose fallback succeeded
    expect(res.status).toBe(200);
  });
});
