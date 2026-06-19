import { beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================
// SSE /v1/config/stream integration test
// =============================================================
//
// Covers audit CS1: the stream now requires a subscriberId and emits the
// same evaluated `{ flags, experiments }` config as /v1/config, then listens
// on the invalidation channel that the flag/experiment cache paths publish to.

const { mockSubscriber } = vi.hoisted(() => ({
  mockSubscriber: {
    subscribe: vi.fn(async () => undefined),
    on: vi.fn(),
    unsubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockSubscriber),
}));

vi.mock("../src/services/subscriber-config", () => ({
  evaluateSubscriberConfig: vi.fn(async () => ({
    flags: { feature_x: true },
    experiments: [],
  })),
}));

vi.mock("../src/middleware/api-key-auth", () => ({
  apiKeyAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("project", {
        id: "proj_test",
        name: "Test",
        slug: "test",
        keyKind: "public",
        apiKeyId: "key_1",
      });
      await next();
    },
}));

import { Hono } from "hono";
import { configStreamRoute } from "../src/routes/v1/config-stream";

let app: Hono;
beforeAll(() => {
  app = new Hono().route("/", configStreamRoute);
});

describe("GET /v1/config/stream", () => {
  it("requires a subscriberId", async () => {
    const res = await app.request("/v1/config/stream", { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("sends an initial evaluated config frame", async () => {
    const controller = new AbortController();
    const res = await app.request("/v1/config/stream?subscriberId=user1", {
      method: "GET",
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: initial");
    expect(text).toContain('"projectId":"proj_test"');
    expect(text).toContain('"flags"');

    controller.abort();
    await reader.cancel();
  });

  it("subscribes to the invalidation channel", async () => {
    await app
      .request("/v1/config/stream?subscriberId=user1", { method: "GET" })
      .catch(() => undefined);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      "rovenue:experiments:invalidate",
    );
  });
});
