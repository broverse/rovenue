import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderConfig } from "@rovenue/shared/paywall";

// =============================================================
// query_paywall_tree tool (P8 AI-FAB, §6.15)
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {},
    paywallRepo: { findPaywallById: vi.fn() },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, drizzle: { ...actual.drizzle, ...drizzleMock } };
});

import { queryPaywallTools } from "./query-paywall";

const CTX = {
  projectId: "prj_1",
  userId: "u_1",
  role: "ADMIN",
  threadId: "th_1",
  messageId: "msg_1",
};
const CALL_OPTIONS = { toolCallId: "call_1", messages: [] };

const CONFIG: BuilderConfig = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title_key: "Go Pro", cta_key: "Continue" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "title", key: "title_key", role: "title" },
      {
        type: "packageList",
        id: "packages",
        packageIds: ["pkg_monthly"],
        cellLayout: "row",
      },
      { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
    ],
  },
};

describe("query_paywall_tree", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes the lookup to ctx.projectId and returns null for a miss (cross-project or unknown id)", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(null);
    const tools = queryPaywallTools(CTX);

    const result = await tools["query_paywall_tree"].execute!({ paywallId: "pw_other" }, CALL_OPTIONS);

    expect(drizzleMock.paywallRepo.findPaywallById).toHaveBeenCalledWith(
      drizzleMock.db,
      "prj_1",
      "pw_other",
    );
    expect(result).toBeNull();
  });

  it("returns a compact id/type/parent + default-locale-string summary, never the raw config", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue({
      id: "pw_1",
      projectId: "prj_1",
      builderConfig: CONFIG,
      remoteConfig: { defaultLocale: "en" },
    });
    const tools = queryPaywallTools(CTX);

    const result = (await tools["query_paywall_tree"].execute!(
      { paywallId: "pw_1" },
      CALL_OPTIONS,
    )) as { paywallId: string; defaultLocale: string; nodes: unknown[] };

    expect(result.paywallId).toBe("pw_1");
    expect(result.defaultLocale).toBe("en");
    expect(result.nodes).toEqual([
      { id: "root", type: "stack", parentId: null, strings: [] },
      { id: "title", type: "text", parentId: "root", strings: ["Go Pro"] },
      { id: "packages", type: "packageList", parentId: "root", strings: [] },
      { id: "purchase", type: "purchaseButton", parentId: "root", strings: ["Continue"] },
    ]);
    expect(JSON.stringify(result)).not.toContain("formatVersion");
    expect(JSON.stringify(result)).not.toContain("localizations");
  });

  it("falls back to an empty config (remoteConfig.defaultLocale) when builderConfig is null", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue({
      id: "pw_1",
      projectId: "prj_1",
      builderConfig: null,
      remoteConfig: { defaultLocale: "tr" },
    });
    const tools = queryPaywallTools(CTX);

    const result = (await tools["query_paywall_tree"].execute!(
      { paywallId: "pw_1" },
      CALL_OPTIONS,
    )) as { defaultLocale: string; nodes: unknown[] };

    expect(result.defaultLocale).toBe("tr");
    expect(result.nodes).toEqual([{ id: "root", type: "stack", parentId: null, strings: [] }]);
  });

  it("resolves row-array copy (e.g. timeline rows' labelKey) one level deep without descending into subtrees twice", async () => {
    const config: BuilderConfig = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: { step1: "Sign up", step2: "Confirm" } },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "timeline",
            id: "tl_1",
            rows: [{ labelKey: "step1" }, { labelKey: "step2" }],
          },
        ],
      },
    };
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue({
      id: "pw_1",
      projectId: "prj_1",
      builderConfig: config,
      remoteConfig: { defaultLocale: "en" },
    });
    const tools = queryPaywallTools(CTX);

    const result = (await tools["query_paywall_tree"].execute!(
      { paywallId: "pw_1" },
      CALL_OPTIONS,
    )) as { nodes: { id: string; strings: string[] }[] };

    const timelineNode = result.nodes.find((n) => n.id === "tl_1");
    expect(timelineNode?.strings).toEqual(["Sign up", "Confirm"]);
    // Exactly 2 nodes total — the timeline rows are NOT walked as separate
    // PaywallNode entries (they aren't subtrees, just plain row objects).
    expect(result.nodes).toHaveLength(2);
  });
});
