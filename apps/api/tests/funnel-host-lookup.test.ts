import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /public/host/lookup
// =============================================================
//
// The dashboard reaches the API at an absolute VITE_API_URL, so on any
// cross-origin request the `Host` header is the API's own hostname, never
// the custom domain the SDK is actually loaded from. The query parameter
// lets the caller name the host explicitly; the `Host` header remains the
// same-origin fallback.
//
// resolveHost itself (verified + cert-issued gating, Redis cache) is
// covered by host-resolver.integration.test.ts — here it's a bare vi.fn()
// so these tests pin only what the route passes to it.

const resolveHostMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/custom-domains/host-resolver", () => ({
  resolveHost: resolveHostMock,
}));

// The public funnels route is mounted on the full app; Redis is not
// running in this test environment, so it's stubbed with a plain
// in-memory Map — same approach as funnel-public-prices.test.ts.
const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  },
}));

async function buildApp() {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  return createApp();
}

describe("GET /public/host/lookup", () => {
  beforeEach(() => {
    redisStore.clear();
    resolveHostMock.mockReset();
  });

  it("resolves the host named in the query parameter", async () => {
    resolveHostMock.mockResolvedValue({ funnelId: "fnl_1", slug: "quiz" });
    const app = await buildApp();
    const res = await app.request("/public/host/lookup?host=quiz.acme.com", {
      headers: { host: "api.rovenue.io" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { funnelId: string; slug: string };
    };
    expect(body.data).toEqual({ funnelId: "fnl_1", slug: "quiz" });
    // The query parameter must win — this is the whole point of the change.
    expect(resolveHostMock).toHaveBeenCalledWith("quiz.acme.com");
  });

  it("falls back to the Host header when no query parameter is given", async () => {
    resolveHostMock.mockResolvedValue({ funnelId: "fnl_1", slug: "quiz" });
    const app = await buildApp();
    const res = await app.request("/public/host/lookup", {
      headers: { host: "quiz.acme.com" },
    });
    expect(res.status).toBe(200);
    expect(resolveHostMock).toHaveBeenCalledWith("quiz.acme.com");
  });

  it("404s when the host does not resolve", async () => {
    resolveHostMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.request(
      "/public/host/lookup?host=not-ours.example.com",
      { headers: { host: "api.rovenue.io" } },
    );
    expect(res.status).toBe(404);
  });

  it("404s when the query parameter is present but empty", async () => {
    // An empty ?host= must not silently fall back to the Host header —
    // that would resolve the API's own hostname and return whatever
    // funnel happened to be bound to it. A Host header is deliberately
    // present here (and set to a *different* value than "") so a status-
    // only assertion couldn't pass by accident when both branches happen
    // to resolve to "" — the toHaveBeenCalledWith below is the assertion
    // that actually pins the argument.
    resolveHostMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.request("/public/host/lookup?host=", {
      headers: { host: "other-tenant.example.com" },
    });
    expect(res.status).toBe(404);
    expect(resolveHostMock).toHaveBeenCalledWith("");
  });
});
