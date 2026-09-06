// =============================================================
// POST /v1/sdk/sessions on a dead-ended subscriber — unit tests
// =============================================================
//
// Closes the missing-coverage gap from the Task 1 review: the guard
// added around line 129-135 of sdk-sessions.ts (resolveOrCreateSubscriber's
// `deadEnded` flag) had no test. Reverting it left the suite green.
//
// A GDPR-erased subject's session telemetry must publish NOTHING to
// Kafka -- accumulating new engagement rows for an erased subject would
// feed Refund Shield's aggregation with data for someone who asked to
// be forgotten. The batch still 202s (matching sdk-sessions.ts's own
// reasoning: an error would make the SDK's at-least-once dispatcher
// retry the same batch forever).
//
// `resolveSubscriberByRovenueId` returning null + `findSubscriberByRovenueId`
// returning the row is exactly the "soft-deleted, no live mergedInto
// survivor" shape resolveSubscriberForWrite treats as dead-ended (see
// resolve-or-create-subscriber.ts).

import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { errorHandler } from "../../middleware/error";

const sendMock = vi.fn();
const assertTopicMock = vi.fn(async (_topic: string) => undefined);

vi.mock("../../lib/kafka", () => ({
  getProducer: vi.fn(async () => ({ send: sendMock })),
  assertTopic: (topic: string) => assertTopicMock(topic),
}));

const resolveSubscriberByRovenueIdMock = vi.fn();
const findSubscriberByRovenueIdMock = vi.fn();
const upsertSubscriberMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: {
      resolveSubscriberByRovenueId: (...args: unknown[]) =>
        resolveSubscriberByRovenueIdMock(...args),
      findSubscriberByRovenueId: (...args: unknown[]) =>
        findSubscriberByRovenueIdMock(...args),
      upsertSubscriber: (...args: unknown[]) => upsertSubscriberMock(...args),
    },
  },
}));

vi.mock("../../middleware/api-key-auth", async () => {
  const { HTTPException } = await import("hono/http-exception");
  const { API_KEY_KIND } = await import("@rovenue/shared");
  return {
    apiKeyAuth: () => async (c: any, next: any) => {
      const auth = c.req.header("Authorization");
      if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        throw new HTTPException(401, { message: "Bearer token required" });
      }
      c.set("project", {
        id: "proj_test_1",
        name: "test",
        keyKind: API_KEY_KIND.PUBLIC,
        apiKeyId: "ak_test_1",
      });
      await next();
    },
    requireSecretKey: async (_c: any, next: any) => {
      await next();
    },
    // Mirrors the real guard rather than passing through. `sdk-sessions.ts`
    // registers this, so a mock that omitted it made every test in this file
    // throw "No requirePublicApiKey export is defined on the mock" — which is
    // exactly what happened when the guard became a shared export. Kept in
    // sync with the identical stub in sdk-sessions.test.ts.
    requirePublicApiKey: async (c: any, next: any) => {
      if (c.get("project")?.keyKind !== API_KEY_KIND.PUBLIC) {
        throw new HTTPException(403, { message: "Public API key required" });
      }
      await next();
    },
  };
});

const PUBLIC_KEY = "rov_pub_test_key";

async function buildApp() {
  const { sdkSessionsRoute } = await import("./sdk-sessions");
  const { apiKeyAuth } = await import("../../middleware/api-key-auth");
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/sdk/sessions", sdkSessionsRoute);
  app.onError(errorHandler);
  return app;
}

function postSession(subscriberId: string) {
  return buildApp().then((app) =>
    app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PUBLIC_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriberId,
        events: [
          {
            type: "open",
            occurredAt: "2026-05-28T10:00:00.000Z",
            durationMs: 0,
            appVersion: "1.0.0",
            sdkVersion: "0.6.0",
          },
        ],
      }),
    }),
  );
}

describe("POST /v1/sdk/sessions — dead-ended subscriber", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
    assertTopicMock.mockClear();
    resolveSubscriberByRovenueIdMock.mockReset();
    findSubscriberByRovenueIdMock.mockReset();
    upsertSubscriberMock.mockReset();
  });

  it("publishes NOTHING to Kafka for an erased subscriber, but still 202s", async () => {
    // resolveSubscriberByRovenueId → null (no LIVE row for this rovenueId);
    // findSubscriberByRovenueId → the soft-deleted row itself. That pair is
    // resolveSubscriberForWrite's "dead-ended" shape.
    resolveSubscriberByRovenueIdMock.mockResolvedValue(null);
    findSubscriberByRovenueIdMock.mockResolvedValue({
      id: "sub_erased_db_id",
      projectId: "proj_test_1",
      rovenueId: "erased_device_1",
      deletedAt: new Date(),
    });

    const res = await postSession("erased_device_1");
    expect(res.status).toBe(202);

    expect(sendMock).not.toHaveBeenCalled();
    // No new row created either -- the dead-ended row is returned as-is.
    expect(upsertSubscriberMock).not.toHaveBeenCalled();
  });

  it("publishes normally for a live subscriber", async () => {
    // The mirror. Without it the test above passes against a route that
    // has stopped publishing for everyone.
    resolveSubscriberByRovenueIdMock.mockResolvedValue({
      id: "sub_live_db_id",
      projectId: "proj_test_1",
      rovenueId: "live_device_1",
      deletedAt: null,
    });

    const res = await postSession("live_device_1");
    expect(res.status).toBe(202);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0];
    expect(call.messages[0].key).toBe("sub_live_db_id");
  });
});
