import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { metricsMiddleware } from "./metrics";
import { httpRequestsTotal, registry } from "../lib/metrics";

describe("metricsMiddleware", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  function buildApp() {
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/items/:id", (c) => c.json({ ok: true }));
    return app;
  }

  it("records http_requests_total with the matched route pattern", async () => {
    const res = await buildApp().request("/v1/items/42");
    expect(res.status).toBe(200);

    const metric = await httpRequestsTotal.get();
    const sample = metric.values.find(
      (v) => v.labels.route === "/v1/items/:id",
    );
    expect(sample?.value).toBe(1);
    expect(sample?.labels).toMatchObject({
      method: "GET",
      route: "/v1/items/:id",
      status: "200",
    });
  });

  it("renders Prometheus text from the registry", async () => {
    await buildApp().request("/v1/items/7");
    const text = await registry.metrics();
    expect(text).toContain("http_requests_total");
    expect(text).toContain('route="/v1/items/:id"');
  });
});
