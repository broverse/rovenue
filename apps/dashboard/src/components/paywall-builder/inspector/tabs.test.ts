import { describe, expect, it } from "vitest";
import type { BuilderIssue } from "@rovenue/shared/paywall";
import {
  INSPECTOR_TABS,
  resolveActiveTab,
  tabIssues,
  tabsForNode,
  type InspectorTabId,
} from "./tabs";

// Compile-time tripwire, not a runtime test. `InspectorTabId` must derive from
// the TABLE; re-adding a `: readonly InspectorTab[]` annotation to
// INSPECTOR_TABS silently restores the circular derivation — tsc stays green,
// every runtime test still passes, and a bogus id compiles again. If that
// happens this expect-error becomes UNUSED and tsc fails, which is the whole
// point: the regression is otherwise invisible to both tsc and vitest.
// @ts-expect-error — "visibility" is not an id in INSPECTOR_TABS
const NOT_A_TAB: InspectorTabId = "visibility";
void NOT_A_TAB;

describe("tabsForNode", () => {
  it("gives every node type at least one tab", () => {
    for (const type of ["stack", "text", "image", "button", "packageList", "purchaseButton", "spacer"] as const) {
      expect(tabsForNode(type).length).toBeGreaterThan(0);
    }
  });

  it("returns tabs in table order, not selection order", () => {
    const ids = tabsForNode("button").map((t) => t.id);
    const tableOrder = INSPECTOR_TABS.filter((t) => ids.includes(t.id)).map((t) => t.id);
    expect(ids).toEqual(tableOrder);
  });

  it("filters out tabs a node type has nothing on", () => {
    expect(tabsForNode("spacer").map((t) => t.id)).toEqual(["layout"]);
    expect(tabsForNode("purchaseButton").map((t) => t.id)).toEqual(["content"]);
    expect(tabsForNode("packageList").map((t) => t.id)).toEqual(["layout", "binding"]);
  });
});

describe("tabIssues", () => {
  const issues: BuilderIssue[] = [
    { code: "EMPTY_LOC_VALUE", nodeId: "n1", key: "k", message: "" },
    { code: "FOREIGN_PACKAGE_ID", nodeId: "n1", message: "" },
    { code: "DUPLICATE_NODE_ID", nodeId: "n1", message: "" },
    { code: "EMPTY_LOC_VALUE", nodeId: "other", key: "k", message: "" },
  ];

  it("groups a node's issues onto the tab holding the offending field", () => {
    const map = tabIssues(issues, "n1");
    expect(map.get("content")).toBe("error");
    expect(map.get("binding")).toBe("error");
  });

  it("ignores issues belonging to other nodes", () => {
    expect(tabIssues(issues, "nobody").size).toBe(0);
  });

  it("gives no dot to a code that maps to no tab", () => {
    const map = tabIssues([{ code: "DUPLICATE_NODE_ID", nodeId: "n1", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  it("gives no dot for a per-locale code, which is not a node's field", () => {
    const map = tabIssues([{ code: "LOCALE_KEY_GAP", nodeId: "n1", locale: "de", key: "k", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  // Every code currently mapped to a tab is publish-blocking, so the
  // "warning" severity is unreachable today. Assert that rather than
  // writing a test that pretends to exercise it: this documents the fact
  // and will start failing the day a warning-tier code is mapped, which is
  // exactly when someone should look at the branch again.
  it("only ever reports errors today, because no warning-tier code maps to a tab", () => {
    const everyMappedCode = INSPECTOR_TABS.flatMap((t) => [...t.issueCodes]);
    const map = tabIssues(
      everyMappedCode.map((code) => ({ code, nodeId: "n1", message: "" })),
      "n1",
    );
    expect([...map.values()].every((s) => s === "error")).toBe(true);
  });
});

describe("resolveActiveTab", () => {
  it("keeps the current tab when the new node also has it", () => {
    expect(resolveActiveTab("style", "text")).toBe("style");
  });

  it("falls back to the node's first applicable tab, not a fixed default", () => {
    expect(resolveActiveTab("style", "spacer")).toBe("layout");
    expect(resolveActiveTab("layout", "purchaseButton")).toBe("content");
  });

  it("picks the first applicable tab when there is no current one", () => {
    expect(resolveActiveTab(null, "text")).toBe("style");
  });
});
