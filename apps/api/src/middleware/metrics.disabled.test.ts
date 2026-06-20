import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the env module BEFORE importing anything that reads it so that
// METRICS_ENABLED is false for the entire module scope of this file.
vi.mock("../lib/env", () => ({ env: { METRICS_ENABLED: false } }));

describe("metricsMiddleware — disabled path", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is a pure pass-through when METRICS_ENABLED is false", async () => {
    // Dynamic imports after vi.resetModules so we get fresh module instances
    // with the mocked env in place.
    const { Hono } = await import("hono");
    const { metricsMiddleware } = await import("./metrics");
    const { httpRequestsTotal, registry } = await import("../lib/metrics");

    registry.resetMetrics();

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/items/:id", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/items/99");
    expect(res.status).toBe(200);

    const metric = await httpRequestsTotal.get();
    expect(metric.values.length).toBe(0);
  });
});
