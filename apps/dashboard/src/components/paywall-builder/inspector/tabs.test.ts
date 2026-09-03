import { describe, expect, it } from "vitest";
import { isPublishBlockingIssue, type BuilderIssue, type PaywallNode } from "@rovenue/shared/paywall";
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

  it("gives divider and icon the content, style, and visibility tabs", () => {
    for (const type of ["divider", "icon"] as const) {
      const ids = tabsForNode(type).map((t) => t.id);
      expect(ids, `${type} tabs`).toContain("content");
      expect(ids, `${type} tabs`).toContain("style");
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
    // Task 13: purchaseButton gained a Binding tab (trialLabelKey editing),
    // so it sat between Content and Visibility, in table order. The node
    // style pass then gave it background/labelColor/border/cornerRadius, so
    // it also gained a Style tab — first in table order, ahead of Content.
    expect(tabsForNode("purchaseButton").map((t) => t.id)).toEqual([
      "style",
      "content",
      "binding",
      "visibility",
    ]);
    expect(tabsForNode("packageList").map((t) => t.id)).toEqual(["layout", "binding", "visibility"]);
  });

  it("gives featureList, timeline and socialProof the style, content and visibility tabs", () => {
    for (const type of ["featureList", "timeline", "socialProof"] as const) {
      expect(tabsForNode(type).map((t) => t.id), `${type} tabs`).toEqual([
        "style",
        "content",
        "visibility",
      ]);
    }
  });

  // Wave D1 — the wave-B scar: `inspector/tabs.ts` was left off a task's file
  // list once, and a node type shipped with `tabsForNode` returning an empty
  // array (no inspector at all). This pins carousel getting a real,
  // non-empty tab set in the same style, content, visibility shape as the
  // other container-ish/row-carrying node types above.
  it("gives carousel a non-empty tab set (style, content, visibility)", () => {
    expect(tabsForNode("carousel")).not.toHaveLength(0);
    expect(tabsForNode("carousel").map((t) => t.id)).toEqual(["style", "content", "visibility"]);
  });

  // Wave D2 — video/lottie. Same scar as carousel above: `inspector/tabs.ts`
  // was left off a task's file list once and a node type shipped with no
  // reachable tabs at all. video/lottie have no layout/style/binding fields
  // (no size, no cell binding), so their tab set is Content + Visibility.
  it("gives video a non-empty tab set", () => {
    expect(tabsForNode("video")).not.toHaveLength(0);
  });
  it("gives lottie a non-empty tab set", () => {
    expect(tabsForNode("lottie")).not.toHaveLength(0);
  });

  it("gives video and lottie the content and visibility tabs, and nothing else", () => {
    for (const type of ["video", "lottie"] as const) {
      expect(tabsForNode(type).map((t) => t.id), `${type} tabs`).toEqual(["content", "visibility"]);
    }
  });

  // Task 7 — footerLinks is the 18th node type. Same wave-B scar as
  // carousel/video/lottie above: without a matching appliesTo entry in
  // BOTH the style and content tabs, the author gets an inspector with no
  // way to edit the links they just added.
  it("gives footerLinks the style, content, and visibility tabs, and nothing else", () => {
    expect(tabsForNode("footerLinks")).not.toHaveLength(0);
    expect(tabsForNode("footerLinks").map((t) => t.id)).toEqual(["style", "content", "visibility"]);
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

  // Severity is READ from the shared model, never restated here — so this
  // asserts the two agree code by code rather than pinning a list that goes
  // stale the next time a code is retiered. Both tiers are mapped today:
  // VISIBILITY_NEVER_MATCHES and the three wave-D2 media codes are warnings,
  // the rest are publish-blocking.
  it("reports each mapped code at the severity the shared model gives it", () => {
    const everyMappedCode = INSPECTOR_TABS.flatMap((t) => [...t.issueCodes]);
    for (const code of everyMappedCode) {
      const expected = isPublishBlockingIssue({ code }) ? "error" : "warning";
      const map = tabIssues([{ code, nodeId: "n1", message: "" }], "n1");
      expect(map.size, `${code} maps to a tab`).toBeGreaterThan(0);
      for (const [id, summary] of map) {
        expect(summary.severity, `${code} on ${id}`).toBe(expected);
      }
    }
  });

  it("shows an error dot on a tab carrying both a warning and an error", () => {
    // Content is the first tab to hold codes of both tiers (EMPTY_LOC_VALUE
    // blocks publish, VIDEO_NO_POSTER does not). The dot must not be demoted
    // by the warning, whatever order the issues arrive in.
    for (const order of [
      ["EMPTY_LOC_VALUE", "VIDEO_NO_POSTER"],
      ["VIDEO_NO_POSTER", "EMPTY_LOC_VALUE"],
    ] as const) {
      const map = tabIssues(order.map((code) => ({ code, nodeId: "n1", message: "" })), "n1");
      expect(map.get("content")).toEqual({ severity: "error", count: 2 });
    }
  });

  it("gives the three wave-D2 media codes a Content dot", () => {
    // Every one of them names a field edited on the Content tab
    // (Autoplay/Muted, Poster URL, Speed); unmapped they were raised and
    // never seen.
    for (const code of ["VIDEO_AUTOPLAY_UNMUTED", "VIDEO_NO_POSTER", "LOTTIE_SPEED_OUT_OF_RANGE"] as const) {
      const map = tabIssues([{ code, nodeId: "n1", message: "" }], "n1");
      expect(map.get("content"), code).toEqual({ severity: "warning", count: 1 });
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
