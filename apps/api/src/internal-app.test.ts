import { describe, it, expect } from "vitest";
import { internalApp } from "./internal-app";

describe("internalApp GET /metrics", () => {
  it("serves Prometheus text", async () => {
    const res = await internalApp.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("process_cpu_user_seconds_total");
  });
});
