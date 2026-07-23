import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  collectLocalizationKeys,
  collectLocalizationUsages,
  isMissingLocaleValue,
  resolveText,
  validateBuilderConfig,
  type BuilderIssue,
} from "./validate";
import type { BuilderConfig, PaywallNode, StackNode, TextNode } from "./schema";

function baseConfig(overrides: Partial<BuilderConfig> = {}): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: { title_key: "Go Pro", cta_key: "Continue" },
      tr: { title_key: "Pro Ol", cta_key: "Devam" },
    },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "title", key: "title_key", role: "title" },
        {
          type: "packageList",
          id: "packages",
          packageIds: ["pkg_monthly", "pkg_annual"],
          cellLayout: "row",
        },
        { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
      ],
    },
    ...overrides,
  };
}

const offeringPackageIds = ["pkg_monthly", "pkg_annual"];

function codesOf(issues: BuilderIssue[]): string[] {
  return issues.map((i) => i.code);
}

describe("validateBuilderConfig", () => {
  it("returns an empty array for a fully clean config", () => {
    const issues = validateBuilderConfig(baseConfig(), { offeringPackageIds });
    expect(issues).toEqual([]);
  });

  it("reports DUPLICATE_NODE_ID when two nodes anywhere in the tree share an id", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "spacer", id: "dup", size: 4 },
          { type: "spacer", id: "dup", size: 8 },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).toContain("DUPLICATE_NODE_ID");
  });

  it("reports DUPLICATE_NODE_ID when one id lives inside a fallback subtree", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "spacer", id: "dup", size: 4 },
          {
            type: "image",
            id: "hero",
            url: { light: "https://x/hero.png" },
            fallback: { type: "spacer", id: "dup", size: 8 },
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).toContain("DUPLICATE_NODE_ID");
  });

  it("reports UNKNOWN_LOC_KEY when a text/button/purchaseButton key is missing from defaultLocale", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "text", id: "title", key: "does_not_exist", role: "title" }],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).toContain("UNKNOWN_LOC_KEY");
  });

  it("reports FOREIGN_PACKAGE_ID when packageIds/defaultSelected reference an id outside the offering", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "packages",
            packageIds: ["pkg_monthly", "pkg_ghost"],
            cellLayout: "row",
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).toContain("FOREIGN_PACKAGE_ID");
  });

  it("treats an empty packageIds array as 'all' — not a FOREIGN_PACKAGE_ID", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "packageList", id: "packages", packageIds: [], cellLayout: "row" },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).not.toContain("FOREIGN_PACKAGE_ID");
  });

  it("reports MISSING_PURCHASE_BUTTON when a packageList exists but no purchaseButton does", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "packages",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(codesOf(issues)).toContain("MISSING_PURCHASE_BUTTON");
  });

  it("reports LOCALE_KEY_GAP for a non-default locale missing a key present in defaultLocale", () => {
    const config = baseConfig({
      localizations: {
        en: { title_key: "Go Pro", cta_key: "Continue" },
        tr: { title_key: "Pro Ol" },
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const gap = issues.find((i) => i.code === "LOCALE_KEY_GAP");
    expect(gap).toBeDefined();
    expect(gap?.locale).toBe("tr");
    expect(gap?.key).toBe("cta_key");
  });
});

describe("collectLocalizationKeys", () => {
  it("collects keys from text and button/purchaseButton nodes across the tree, including fallbacks", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "title", key: "title_key", role: "title" },
        {
          type: "button",
          id: "b1",
          labelKey: "btn_key",
          style: "primary",
          action: { kind: "restore" },
          fallback: { type: "text", id: "b1_fb", key: "fallback_key", role: "body" },
        },
      ],
    };
    const keys = collectLocalizationKeys(root);
    expect(keys.sort()).toEqual(["btn_key", "fallback_key", "title_key"]);
  });
});

describe("resolveText", () => {
  const config = baseConfig();

  it("resolves from the requested locale when present", () => {
    expect(resolveText(config, "tr", "title_key")).toBe("Pro Ol");
  });

  it("falls back to defaultLocale when the requested locale lacks the key", () => {
    const partial = baseConfig({
      localizations: {
        en: { title_key: "Go Pro" },
        tr: {},
      },
    });
    expect(resolveText(partial, "tr", "title_key")).toBe("Go Pro");
  });

  it("returns null when neither the locale nor defaultLocale has the key", () => {
    expect(resolveText(config, "tr", "nope")).toBeNull();
  });
});

describe("validateBuilderConfig — cellTemplate / overrides (Phase D2)", () => {
  it("reports CELL_TEMPLATE_BAD_NODE when a packageList sits inside a cellTemplate subtree", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "outer",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
            cellTemplate: {
              type: "packageList",
              id: "inner",
              packageIds: ["pkg_annual"],
              cellLayout: "row",
            },
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const bad = issues.find((i) => i.code === "CELL_TEMPLATE_BAD_NODE");
    expect(bad).toBeDefined();
    expect(bad?.nodeId).toBe("inner");
  });

  it("reports CELL_TEMPLATE_BAD_NODE when a purchaseButton is nested (2 levels deep) inside a cellTemplate subtree", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "outer",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
            cellTemplate: {
              type: "stack",
              id: "cell_root",
              axis: "v",
              children: [{ type: "purchaseButton", id: "cell_purchase", labelKey: "cta_key" }],
            },
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const bad = issues.find((i) => i.code === "CELL_TEMPLATE_BAD_NODE");
    expect(bad).toBeDefined();
    expect(bad?.nodeId).toBe("cell_purchase");
  });

  it("does NOT report CELL_TEMPLATE_BAD_NODE for a packageList/purchaseButton outside any cellTemplate", () => {
    const issues = validateBuilderConfig(baseConfig(), { offeringPackageIds });
    expect(issues.map((i) => i.code)).not.toContain("CELL_TEMPLATE_BAD_NODE");
  });

  it("reports DUPLICATE_NODE_ID when one id lives inside a cellTemplate subtree and clashes outside it", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "spacer", id: "dup", size: 4 },
          {
            type: "packageList",
            id: "packages",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
            cellTemplate: { type: "spacer", id: "dup", size: 8 },
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.map((i) => i.code)).toContain("DUPLICATE_NODE_ID");
  });

  it("reports OVERRIDE_SELECTED_OUTSIDE_CELL for a 'selected' override on a node not inside any cellTemplate", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "text",
            id: "title",
            key: "title_key",
            role: "title",
            overrides: [{ when: { kind: "selected" }, props: { key: "title_key" } }],
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const warning = issues.find((i) => i.code === "OVERRIDE_SELECTED_OUTSIDE_CELL");
    expect(warning).toBeDefined();
    expect(warning?.nodeId).toBe("title");
  });

  it("does NOT report OVERRIDE_SELECTED_OUTSIDE_CELL for a 'selected' override on a node inside a cellTemplate", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "packages",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
            cellTemplate: {
              type: "text",
              id: "cell_text",
              key: "title_key",
              role: "body",
              overrides: [{ when: { kind: "selected" }, props: { key: "cta_key" } }],
            },
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.map((i) => i.code)).not.toContain("OVERRIDE_SELECTED_OUTSIDE_CELL");
  });

  it("does NOT report OVERRIDE_SELECTED_OUTSIDE_CELL for an 'introEligible' override outside any cellTemplate", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "text",
            id: "title",
            key: "title_key",
            role: "title",
            overrides: [{ when: { kind: "introEligible" }, props: { key: "title_key" } }],
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.map((i) => i.code)).not.toContain("OVERRIDE_SELECTED_OUTSIDE_CELL");
  });

  it("reports OVERRIDE_BAD_PROP defensively when a parsed config (bypassing the schema) carries a structural prop key", () => {
    // Simulates a config built outside the strict authoring schema — e.g.
    // programmatically, or decoded leniently — where a structural field
    // slipped into an override's props. validateBuilderConfig re-checks
    // this even though the strict schema would normally reject it at parse.
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "text",
            id: "title",
            key: "title_key",
            role: "title",
            overrides: [{ when: { kind: "introEligible" }, props: { type: "spacer" } }],
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const bad = issues.find((i) => i.code === "OVERRIDE_BAD_PROP");
    expect(bad).toBeDefined();
    expect(bad?.nodeId).toBe("title");
    expect(bad?.key).toBe("type");
  });

  it("reports UNKNOWN_LOC_KEY for a key introduced only via an override", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "text",
            id: "title",
            key: "title_key",
            role: "title",
            overrides: [{ when: { kind: "introEligible" }, props: { key: "override_ghost_key" } }],
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const gap = issues.find((i) => i.code === "UNKNOWN_LOC_KEY" && i.key === "override_ghost_key");
    expect(gap).toBeDefined();
    expect(gap?.nodeId).toBe("title");
  });
});

describe("collectLocalizationKeys — overrides + cellTemplate", () => {
  it("includes key/labelKey values introduced by overrides, and keys from inside a cellTemplate subtree", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "text",
          id: "title",
          key: "title_key",
          role: "title",
          overrides: [{ when: { kind: "introEligible" }, props: { key: "intro_title_key" } }],
        },
        {
          type: "packageList",
          id: "packages",
          packageIds: [],
          cellLayout: "row",
          cellTemplate: { type: "text", id: "cell_text", key: "cell_key", role: "caption" },
        },
      ],
    };
    const keys = collectLocalizationKeys(root);
    expect(keys.sort()).toEqual(["cell_key", "intro_title_key", "title_key"]);
  });
});

describe("applyOverrides", () => {
  const baseText: TextNode = {
    type: "text",
    id: "t1",
    key: "title_key",
    role: "title",
    color: { light: "#000" },
    align: "start",
  };

  it("returns the SAME object reference when the node has no overrides", () => {
    const result = applyOverrides(baseText, { introEligible: false, selected: false });
    expect(result).toBe(baseText);
  });

  it("returns the SAME object reference when overrides exist but none are active", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [{ when: { kind: "introEligible" }, props: { align: "center" } }],
    };
    const result = applyOverrides(node, { introEligible: false, selected: false });
    expect(result).toBe(node);
  });

  it("merges a matching introEligible override's props over the base (shallow, later wins n/a with one override)", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [
        { when: { kind: "introEligible" }, props: { key: "intro_key", align: "center" } },
      ],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    expect(result).not.toBe(node);
    expect(result).toEqual({ ...baseText, key: "intro_key", align: "center", overrides: node.overrides });
  });

  it("merges a matching selected override's props", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [{ when: { kind: "selected" }, props: { align: "end" } }],
    };
    const result = applyOverrides(node, { introEligible: false, selected: true });
    expect(result.align).toBe("end");
  });

  it("applies overrides in array order with later entries winning on shared keys", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [
        { when: { kind: "introEligible" }, props: { align: "center" } },
        { when: { kind: "introEligible" }, props: { align: "end" } },
      ],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    expect(result.align).toBe("end");
  });

  it("does not deep-merge — a later override's prop value wholly replaces the earlier one", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [
        { when: { kind: "introEligible" }, props: { color: { light: "#111" } } },
        { when: { kind: "introEligible" }, props: { color: { light: "#222" } } },
      ],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    expect(result.color).toEqual({ light: "#222" });
  });

  it("leaves untouched base props intact when only some props are overridden", () => {
    const node: TextNode = {
      ...baseText,
      overrides: [{ when: { kind: "introEligible" }, props: { align: "end" } }],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    expect(result.key).toBe(baseText.key);
    expect(result.color).toEqual(baseText.color);
  });

  it("skips an override with an unknown when.kind (lenient-decoded data) without throwing", () => {
    const node = {
      ...baseText,
      overrides: [
        { when: { kind: "sizeClass" }, props: { align: "end" } },
      ] as unknown as TextNode["overrides"],
    } as TextNode;
    const result = applyOverrides(node, { introEligible: true, selected: true });
    expect(result).toBe(node);
  });

  it("is generic over any PaywallNode subtype — works on a packageList node too", () => {
    const node: PaywallNode = {
      type: "packageList",
      id: "p1",
      packageIds: [],
      cellLayout: "row",
    };
    const result = applyOverrides(node, { introEligible: false, selected: false });
    expect(result).toBe(node);
  });
});

describe("collectLocalizationUsages", () => {
  function tree(): StackNode {
    return {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        {
          type: "text",
          id: "t2",
          key: "sub",
          role: "body",
          overrides: [{ when: { kind: "introEligible" }, props: { key: "sub_intro" } }],
        },
        {
          type: "packageList",
          id: "pl",
          packageIds: ["monthly"],
          cellLayout: "row",
          cellTemplate: { type: "text", id: "cell", key: "cell_name", role: "caption" },
        },
        {
          type: "purchaseButton",
          id: "pb",
          labelKey: "cta",
          fallback: { type: "button", id: "fb", labelKey: "cta_fallback", style: "plain", action: { kind: "close" } },
        },
      ],
    };
  }

  it("reports every key with its owning node, in document order", () => {
    expect(collectLocalizationUsages(tree())).toEqual([
      { key: "title", nodeId: "t1", nodeType: "text", viaOverride: false },
      { key: "sub", nodeId: "t2", nodeType: "text", viaOverride: false },
      { key: "sub_intro", nodeId: "t2", nodeType: "text", viaOverride: true },
      { key: "cell_name", nodeId: "cell", nodeType: "text", viaOverride: false },
      { key: "cta", nodeId: "pb", nodeType: "purchaseButton", viaOverride: false },
      { key: "cta_fallback", nodeId: "fb", nodeType: "button", viaOverride: false },
    ]);
  });

  it("collectLocalizationKeys stays a deduped projection in first-seen order", () => {
    const shared: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "a", key: "same", role: "title" },
        { type: "text", id: "b", key: "same", role: "body" },
        { type: "text", id: "c", key: "other", role: "body" },
      ],
    };
    expect(collectLocalizationUsages(shared).map((u) => u.nodeId)).toEqual(["a", "b", "c"]);
    expect(collectLocalizationKeys(shared)).toEqual(["same", "other"]);
  });
});

describe("isMissingLocaleValue", () => {
  it("treats absent, empty and whitespace-only as missing", () => {
    expect(isMissingLocaleValue(undefined)).toBe(true);
    expect(isMissingLocaleValue("")).toBe(true);
    expect(isMissingLocaleValue("   ")).toBe(true);
  });

  it("treats any real text as present", () => {
    expect(isMissingLocaleValue("x")).toBe(false);
    expect(isMissingLocaleValue(" x ")).toBe(false);
  });
});
