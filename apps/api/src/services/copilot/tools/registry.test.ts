import { describe, expect, it } from "vitest";
import { loadTools, listToolNames } from "./index";

describe("loadTools", () => {
  it("includes whitelisted domains and excludes billing/webhook-config/custom-domain", () => {
    const names = listToolNames();
    expect(names).toContain("query.subscribers.search");
    expect(names.some((n) => n.includes("billing"))).toBe(false);
    expect(names.some((n) => n.includes("webhook"))).toBe(false);
    expect(names.some((n) => n.includes("custom-domain"))).toBe(false);
  });

  it("returns AI SDK tool objects for a given context", () => {
    const tools = loadTools({
      projectId: "prj_1",
      userId: "u_1",
      role: "CUSTOMER_SUPPORT",
      threadId: "th_1",
    });
    expect(tools["query.subscribers.search"]).toBeDefined();
    expect(tools["query.subscribers.search"]).toHaveProperty("execute");
  });

  it("includes all v1 query tools", () => {
    const names = listToolNames();
    for (const n of [
      "query.subscribers.search",
      "query.subscribers.get",
      "query.subscriptions.list",
      "query.products.list",
      "query.productGroups.list",
      "query.metrics.mrr",
      "query.metrics.churn",
      "query.metrics.conversion",
      "query.audiences.list",
      "query.experiments.list",
      "query.featureFlags.list",
    ]) {
      expect(names).toContain(n);
    }
  });
});
