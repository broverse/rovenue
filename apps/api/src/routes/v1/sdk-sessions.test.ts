// =============================================================
// POST /v1/sdk/sessions — unit tests
// =============================================================
//
// Validates the SDK telemetry ingest endpoint:
//   - Bearer-auth gated (public API key).
//   - Zod 400 on malformed body.
//   - 202 + Kafka produce on the success path.
//   - 503 when the Kafka producer rejects (downstream Refund
//     Shield aggregation can tolerate a transient gap; the SDK is
//     expected to retry).
//
// The Kafka producer is mocked at the module boundary
// (apps/api/src/lib/kafka.ts) so tests don't need a live
// Redpanda. Auth is stubbed by mocking the api-key-auth
// middleware to set a synthetic `project` on the context.

import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("../../lib/kafka", () => ({
  getProducer: vi.fn(async () => ({ send: sendMock })),
}));

// Resolve the client-supplied id to a project-owned subscriber. The
// route uses `subscriber.id` (project-owned) as the Kafka key + payload
// id, never the raw foreign id from the body.
const upsertSubscriberMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: {
      upsertSubscriber: (...args: unknown[]) => upsertSubscriberMock(...args),
    },
  },
}));

// Stub the api-key-auth middleware. The real implementation hits
// the DB; we only need to assert: (a) absent bearer → 401, (b)
// public key path → project is set on context.
vi.mock("../../middleware/api-key-auth", async () => {
  const { HTTPException } = await import("hono/http-exception");
  const { API_KEY_KIND } = await import("@rovenue/shared");
  return {
    apiKeyAuth: () => async (c: any, next: any) => {
      const auth = c.req.header("Authorization");
      if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        throw new HTTPException(401, { message: "Bearer token required" });
      }
      const token = auth.slice(7).trim();
      if (!token.startsWith("rov_pub_")) {
        throw new HTTPException(401, { message: "Invalid API key format" });
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
  };
});

const PUBLIC_KEY = "rov_pub_test_key";

async function buildApp() {
  const { sdkSessionsRoute } = await import("./sdk-sessions");
  const { apiKeyAuth } = await import("../../middleware/api-key-auth");
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/sdk/sessions", sdkSessionsRoute);
}

describe("POST /v1/sdk/sessions", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
    upsertSubscriberMock.mockReset();
    // The repo resolves the client-supplied rovenueId to the canonical,
    // project-owned subscriber row. Echo a distinct id so tests can prove
    // the route uses the resolved id, not the raw body value.
    upsertSubscriberMock.mockImplementation(async (_db: unknown, input: any) => ({
      id: `resolved_${input.rovenueId}`,
      projectId: input.projectId,
      rovenueId: input.rovenueId,
    }));
  });

  it("produces events with the project-owned subscriber id and returns 202", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PUBLIC_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // A foreign / caller-supplied id — must be resolved within the
        // authenticated project, never trusted verbatim.
        subscriberId: "foreign_sub_xyz",
        events: [
          {
            type: "background",
            occurredAt: "2026-05-28T10:00:00.000Z",
            durationMs: 60000,
            appVersion: "1.0.0",
            sdkVersion: "0.6.0",
          },
        ],
      }),
    });
    expect(res.status).toBe(202);

    // Resolution happened within the authenticated project.
    expect(upsertSubscriberMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertSubscriberMock.mock.calls[0]?.[1];
    expect(upsertArgs).toMatchObject({
      projectId: "proj_test_1",
      rovenueId: "foreign_sub_xyz",
      createAttributes: {},
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0];
    expect(call.topic).toBe("rovenue.sdk-sessions");
    expect(call.messages).toHaveLength(1);
    const msg = call.messages[0];
    // Key + payload use the resolved id, NOT the raw foreign id.
    expect(msg.key).toBe("resolved_foreign_sub_xyz");
    const envelope = JSON.parse(msg.value);
    expect(envelope.eventType).toBe("sdk.session");
    expect(envelope.aggregateId).toBe("resolved_foreign_sub_xyz");
    expect(typeof envelope.eventId).toBe("string");
    expect(envelope.eventId.length).toBeGreaterThan(0);
    expect(typeof envelope.payload).toBe("string");
    const payload = JSON.parse(envelope.payload);
    expect(payload).toMatchObject({
      projectId: "proj_test_1",
      subscriberId: "resolved_foreign_sub_xyz",
      eventType: "background",
      occurredAt: "2026-05-28T10:00:00.000Z",
      durationMs: 60000,
      appVersion: "1.0.0",
      sdkVersion: "0.6.0",
    });
  });

  it("rejects without bearer", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects malformed body (Zod 400)", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PUBLIC_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subscriberId: "", events: [] }),
    });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 503 when Kafka produce fails", async () => {
    sendMock.mockRejectedValueOnce(new Error("kafka down"));
    const app = await buildApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PUBLIC_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriberId: "sub_test_1",
        events: [
          {
            type: "open",
            occurredAt: "2026-05-28T10:00:00.000Z",
            appVersion: "1",
            sdkVersion: "1",
          },
        ],
      }),
    });
    expect(res.status).toBe(503);
  });
});
