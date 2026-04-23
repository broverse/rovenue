import { beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================
// SSE /v1/config/stream integration test
// =============================================================
//
// Source: superseded plan Task 7.2 (2026-04-23-clickhouse-
// foundation-and-experiments.md). Adapted for this repo:
// `apiKeyAuth` is a factory middleware, so its mock returns a
// function. Project context goes under `c.get("project")`.

const mockSubscriber = {
  subscribe: vi.fn(async () => undefined),
  on: vi.fn(),
  unsubscribe: vi.fn(async () => undefined),
  quit: vi.fn(async () => undefined),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockSubscriber),
}));

vi.mock("../src/services/experiment-engine", () => ({
  loadBundleFromCache: vi.fn(async (projectId: string) => ({
    schemaVersion: 1,
    projectId,
    experiments: [],
    audiences: {},
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
  it("sends an initial bundle frame", async () => {
    const controller = new AbortController();
    const promise = app.request("/v1/config/stream", {
      method: "GET",
      signal: controller.signal,
    });
    const res = await promise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: initial");
    expect(text).toContain('"projectId":"proj_test"');

    controller.abort();
    await reader.cancel();
  });

  it("subscribes to the invalidation channel", async () => {
    await app
      .request("/v1/config/stream", { method: "GET" })
      .catch(() => undefined);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      "rovenue:experiments:invalidate",
    );
  });
});
