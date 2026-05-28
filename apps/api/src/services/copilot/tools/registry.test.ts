import { describe, expect, it } from "vitest";
import { loadTools, listToolNames } from "./index";

describe("loadTools", () => {
  it("includes whitelisted domains and excludes billing/webhook-config/custom-domain", () => {
    const names = listToolNames();
    expect(names).toContain("query_subscribers_search");
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
      messageId: "msg_1",
    });
    expect(tools["query_subscribers_search"]).toBeDefined();
    expect(tools["query_subscribers_search"]).toHaveProperty("execute");
  });

  it("includes all v1 query tools", () => {
    const names = listToolNames();
    for (const n of [
      "query_subscribers_search",
      "query_subscribers_get",
      "query_subscriptions_list",
      "query_products_list",
      "query_productGroups_list",
      "query_metrics_mrr",
      "query_metrics_churn",
      "query_metrics_conversion",
      "query_audiences_list",
      "query_experiments_list",
      "query_featureFlags_list",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("includes all v1 action tools", () => {
    const names = listToolNames();
    for (const n of [
      "action_subscriptions_cancel",
      "action_subscriptions_refund",
      "action_subscribers_grantAccess",
      "action_subscribers_transfer",
      "action_products_updatePrice",
      "action_audiences_create",
      "action_audiences_update",
      "action_featureFlags_toggle",
      "action_featureFlags_updateRules",
      "action_experiments_start",
      "action_experiments_stop",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("never includes excluded domains", () => {
    const names = listToolNames();
    for (const banned of [
      "billing",
      "payment",
      "invoice",
      "webhook",
      "custom-domain",
      "customDomain",
      "apiKey",
      "member",
    ]) {
      for (const n of names) expect(n).not.toContain(banned);
    }
  });
});
