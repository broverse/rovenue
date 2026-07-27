import { describe, expect, it } from "vitest";
import type { BuilderIssue, PaywallNode } from "@rovenue/shared/paywall";
import { NODE_TYPE_LABEL } from "../node-meta";
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
// @ts-expect-error — "segments" is not an id in INSPECTOR_TABS
const NOT_A_TAB: InspectorTabId = "segments";
void NOT_A_TAB;

describe("tabsForNode", () => {
  it("gives every node type at least one tab", () => {
    // NODE_TYPE_LABEL is a Record<PaywallNode["type"], string> — TS requires
    // every union member as a key, so this iterates the type union itself
    // rather than a hand-written list. A node type added to the schema
    // without a matching appliesTo entry anywhere fails this loudly instead
    // of silently leaving that node with no inspector at all (the bug this
    // test exists to catch: divider/icon shipped with an empty appliesTo
    // everywhere and had zero reachable tabs).
    for (const type of Object.keys(NODE_TYPE_LABEL) as PaywallNode["type"][]) {
      expect(tabsForNode(type).length, `no tabs for ${type}`).toBeGreaterThan(0);
    }
  });

  it("gives divider and icon both the content and visibility tabs", () => {
    for (const type of ["divider", "icon"] as const) {
      const ids = tabsForNode(type).map((t) => t.id);
      expect(ids, `${type} tabs`).toContain("content");
      expect(ids, `${type} tabs`).toContain("visibility");
    }
  });

  it("returns tabs in table order, not selection order", () => {
    const ids = tabsForNode("button").map((t) => t.id);
    const tableOrder = INSPECTOR_TABS.filter((t) => ids.includes(t.id)).map((t) => t.id);
    expect(ids).toEqual(tableOrder);
  });

  it("filters out tabs a node type has nothing on", () => {
    expect(tabsForNode("spacer").map((t) => t.id)).toEqual(["layout", "visibility"]);
    expect(tabsForNode("purchaseButton").map((t) => t.id)).toEqual(["content", "visibility"]);
    expect(tabsForNode("packageList").map((t) => t.id)).toEqual(["layout", "binding", "visibility"]);
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
    expect(map.get("content")?.severity).toBe("error");
    expect(map.get("binding")?.severity).toBe("error");
  });

  it("ignores issues belonging to other nodes", () => {
    expect(tabIssues(issues, "nobody").size).toBe(0);
  });

  it("gives no dot to a code that maps to no tab", () => {
    const map = tabIssues([{ code: "DUPLICATE_NODE_ID", nodeId: "n1", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  it("gives no dot for CELL_TEMPLATE_BAD_NODE, whose nodeId names where a node SITS", () => {
    // The validator attaches this to the offending node inside the
    // cellTemplate — a packageList or purchaseButton — not to the
    // packageList that owns the template. There is no field on the named
    // node to point at, and a purchaseButton has no Layout tab, so mapping
    // it there computed a dot that the strip then silently dropped.
    const map = tabIssues([{ code: "CELL_TEMPLATE_BAD_NODE", nodeId: "pb", message: "" }], "pb");
    expect(map.size).toBe(0);
  });

  it("gives no dot for a per-locale code, which is not a node's field", () => {
    const map = tabIssues([{ code: "LOCALE_KEY_GAP", nodeId: "n1", locale: "de", key: "k", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  // VISIBILITY_NEVER_MATCHES is the first warning-tier code mapped to a
  // tab (added with the Visibility tab): bounds that cross make a node
  // render nowhere, which is dead content rather than a broken config, so
  // it must not block publish. Every other mapped code is still
  // publish-blocking, so the dot split is exactly one tab wide today.
  it("reports VISIBILITY_NEVER_MATCHES as a warning and every other mapped code as an error", () => {
    const everyMappedCode = INSPECTOR_TABS.flatMap((t) => [...t.issueCodes]);
    const map = tabIssues(
      everyMappedCode.map((code) => ({ code, nodeId: "n1", message: "" })),
      "n1",
    );
    expect(map.get("visibility")?.severity).toBe("warning");
    for (const [id, summary] of map) {
      if (id === "visibility") continue;
      expect(summary.severity).toBe("error");
    }
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

  it("opens on Content when the node has it, rather than the first tab in table order", () => {
    // Table order is the mock's (Layout first), but a fresh text node is
    // blank until its string is written, so Style-first would hide the very
    // field the author came for.
    expect(resolveActiveTab(null, "text")).toBe("content");
    expect(resolveActiveTab(null, "button")).toBe("content");
  });

  it("falls back to the first applicable tab for a node with no Content", () => {
    expect(resolveActiveTab(null, "spacer")).toBe("layout");
    expect(resolveActiveTab(null, "stack")).toBe("layout");
  });
});
