// =============================================================
// SES events route — unit tests for W4.1 + W4.2 hardening
//
// No real Postgres, Redis, or AWS dependency.
// - W4.1a: rate-limit middleware is mounted on /ses-events
// - W4.1b: replayed MessageId (dedup) is a no-op
// - W4.2:  SubscribeURL allowlist blocks non-SNS hosts
// =============================================================

// Must come before any imports that read env.
process.env.AWS_SES_EVENTS_VERIFY_SIGNATURE = "false";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "redis://localhost:6379";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the compiled output, so they
// run before any variable declarations. All mock implementations must be
// defined inline in the factory. Access the mocked modules at test time via
// the regular import below.
// ---------------------------------------------------------------------------

vi.mock("../../lib/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      invitationRepo: {
        setDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationDeliveryRepo: {
        findDeliveryByProviderMessageId: vi.fn().mockResolvedValue(null),
        markDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationSuppressionRepo: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      notificationPreferencesRepo: {
        updateUserChannels: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

// Track when the rate-limit middleware is invoked.
const rateLimitSpy = vi.fn<[], void>();
vi.mock("../../middleware/rate-limit", () => ({
  endpointRateLimit: (_opts: unknown) =>
    async (_c: unknown, next: () => Promise<void>) => {
      // rateLimitSpy is declared with vi.fn() before the hoisted block runs
      // because vi.fn() itself doesn't reference any module-scope variable.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      rateLimitSpy();
      await next();
    },
}));

// ---------------------------------------------------------------------------
// Import mocked modules — these are the vi.mock'd versions, not real ones.
// ---------------------------------------------------------------------------
import { redis } from "../../lib/redis";
import { drizzle } from "@rovenue/db";
import { sesEventsRoute } from "./ses-events";
import { webhooksRoute } from "./index";

// Typed helpers to access the vi.fn() spies on the mocked modules.
const redisMock = redis as unknown as { set: ReturnType<typeof vi.fn> };
const drizzleMock = drizzle as unknown as {
  invitationRepo: { setDeliveryStatus: ReturnType<typeof vi.fn> };
  notificationDeliveryRepo: {
    findDeliveryByProviderMessageId: ReturnType<typeof vi.fn>;
    markDeliveryStatus: ReturnType<typeof vi.fn>;
  };
  notificationSuppressionRepo: { add: ReturnType<typeof vi.fn> };
  notificationPreferencesRepo: { updateUserChannels: ReturnType<typeof vi.fn> };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSesApp() {
  return new Hono().route("/webhooks/ses-events", sesEventsRoute);
}

function snsNotification(messageId: string, sesEvent: unknown) {
  return {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
    Message: JSON.stringify(sesEvent),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "FAKE",
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
  };
}

function sesBouncePayload(sesMsgId: string) {
  return {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "bounce@example.com" }],
      timestamp: new Date().toISOString(),
      feedbackId: "fb-1",
    },
    mail: {
      messageId: sesMsgId,
      tags: { "ses:configuration-set": ["rovenue-events"] },
    },
  };
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// W4.1a: rate-limit middleware is mounted on /ses-events in webhooksRoute
// ---------------------------------------------------------------------------

describe("W4.1a: SES rate-limit middleware is mounted", () => {
  beforeEach(() => {
    redisMock.set.mockResolvedValue("OK");
    rateLimitSpy.mockClear();
  });

  it("invokes the rate-limit middleware for /ses-events requests", async () => {
    const app = new Hono().route("/webhooks", webhooksRoute);
    const body = snsNotification("mid-rate", sesBouncePayload("ses-msg-rate"));
    await post(app, "/webhooks/ses-events", body);
    expect(rateLimitSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W4.1b: MessageId dedup — replayed Notification is a no-op
// ---------------------------------------------------------------------------

describe("W4.1b: SES Notification MessageId dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes a Notification on first delivery (SET NX returns OK)", async () => {
    redisMock.set.mockResolvedValue("OK");
    const app = buildSesApp();
    const body = snsNotification("mid-first", sesBouncePayload("ses-msg-1"));

    const res = await post(app, "/webhooks/ses-events", body);
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      "ses:seen:mid-first",
      "1",
      "EX",
      3600,
      "NX",
    );
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalled();
  });

  it("skips processing on replay (SET NX returns null — already seen)", async () => {
    redisMock.set.mockResolvedValue(null);
    const app = buildSesApp();
    const body = snsNotification("mid-replay", sesBouncePayload("ses-msg-r"));

    const res = await post(app, "/webhooks/ses-events", body);
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // Deduplicated before DB — no writes
    expect(
      drizzleMock.invitationRepo.setDeliveryStatus,
    ).not.toHaveBeenCalled();
  });

  it("fails open when Redis throws — processes despite cache error", async () => {
    redisMock.set.mockRejectedValue(new Error("redis connection refused"));
    const app = buildSesApp();
    const body = snsNotification("mid-rediserr", sesBouncePayload("ses-msg-e"));

    const res = await post(app, "/webhooks/ses-events", body);
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // Processing continued despite Redis error (fail open)
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W4.2: SubscribeURL host allowlist
// ---------------------------------------------------------------------------

describe("W4.2: SubscribeURL host allowlist", () => {
  // Using a loose type here because vi.spyOn on globalThis.fetch produces a
  // complex MockInstance generic that is hard to annotate portably in strict TS.
  // The `unknown` fallback avoids the incompatible-parameter error while still
  // letting us call .mockResolvedValue / .mockRejectedValue / not.toHaveBeenCalled.
  let fetchSpy: { mockResolvedValue: (v: unknown) => void; mockRejectedValue: (v: unknown) => void; mockRestore: () => void };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as typeof fetchSpy;
    redisMock.set.mockResolvedValue("OK");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns 400 and does NOT fetch for metadata endpoint (SSRF attack)", async () => {
    const app = buildSesApp();
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));

    const res = await post(app, "/webhooks/ses-events", {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-ssrf",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
      Message: "subscribe",
      Token: "tok",
      SubscribeURL: "http://169.254.169.254/latest/meta-data/",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "FAKE",
      SigningCertURL:
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 and does NOT fetch for arbitrary internal host", async () => {
    const app = buildSesApp();
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));

    const res = await post(app, "/webhooks/ses-events", {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-internal",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
      Message: "subscribe",
      Token: "tok",
      SubscribeURL: "http://internal.corp.example/evil",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "FAKE",
      SigningCertURL:
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a valid SNS SubscribeURL and attempts the fetch", async () => {
    const app = buildSesApp();
    // Fetch will fail in test env — handler catches and returns { ok: true }.
    fetchSpy.mockRejectedValue(new Error("network unreachable"));

    const subscribeURL =
      "https://sns.us-east-1.amazonaws.com/confirm-fake?Token=tok";
    const res = await post(app, "/webhooks/ses-events", {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-valid",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
      Message: "subscribe",
      Token: "tok",
      SubscribeURL: subscribeURL,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "FAKE",
      SigningCertURL:
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    });

    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(subscribeURL);
  });

  it("returns 400 for an invalid (non-parseable) SubscribeURL", async () => {
    const app = buildSesApp();
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));

    const res = await post(app, "/webhooks/ses-events", {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-bad-url",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
      Message: "subscribe",
      Token: "tok",
      SubscribeURL: "not-a-url",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "FAKE",
      SigningCertURL:
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
