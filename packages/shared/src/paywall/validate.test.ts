import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  collectLocalizationKeys,
  collectLocalizationUsages,
  isBlockingIssue,
  isMissingLocaleValue,
  isPublishBlockingIssue,
  issueSeverity,
  resolveText,
  validateBuilderConfig,
  type BuilderIssue,
} from "./validate";
import { CAROUSEL_MIN_AUTO_ADVANCE_SECONDS } from "./schema";
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

  it("does NOT report OVERRIDE_BAD_PROP for a purchaseButton override carrying trialLabelKey", () => {
    // P6 final-review Task 4 (deferred from Task 9): trialLabelKey is in
    // OVERRIDABLE_PROP_KEYS.purchaseButton, so the validator's defensive
    // re-check must accept it same as the strict parse schema does.
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "purchaseButton",
            id: "purchase",
            labelKey: "cta_key",
            overrides: [{ when: { kind: "selected" }, props: { trialLabelKey: "cta_key" } }],
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.map((i) => i.code)).not.toContain("OVERRIDE_BAD_PROP");
  });

  it("reports OVERRIDE_BAD_PROP for a purchaseButton override with a bogus prop (control)", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "purchaseButton",
            id: "purchase",
            labelKey: "cta_key",
            overrides: [{ when: { kind: "selected" }, props: { bogusProp: "nope" } }],
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const bad = issues.find((i) => i.code === "OVERRIDE_BAD_PROP");
    expect(bad).toBeDefined();
    expect(bad?.nodeId).toBe("purchase");
    expect(bad?.key).toBe("bogusProp");
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

describe("blank localization values count as missing", () => {
  function configWith(localizations: Record<string, Record<string, string>>): BuilderConfig {
    return {
      formatVersion: 2,
      defaultLocale: "en",
      localizations,
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "text", id: "t1", key: "title", role: "title" }],
      },
    };
  }

  it("a blank default-locale value is a publish-blocking EMPTY_LOC_VALUE (present, not absent)", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "" } }), {
      offeringPackageIds: [],
    });
    const blank = issues.filter((i) => i.code === "EMPTY_LOC_VALUE");
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatchObject({ nodeId: "t1", key: "title" });
    expect(isBlockingIssue(blank[0]!)).toBe(false);
    expect(isPublishBlockingIssue(blank[0]!)).toBe(true);
  });

  it("a whitespace-only default-locale value is also a publish-blocking EMPTY_LOC_VALUE", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "   " } }), {
      offeringPackageIds: [],
    });
    expect(issues.some((i) => i.code === "EMPTY_LOC_VALUE")).toBe(true);
  });

  it("a filled default-locale value emits no UNKNOWN_LOC_KEY", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "Hello" } }), {
      offeringPackageIds: [],
    });
    expect(issues.some((i) => i.code === "UNKNOWN_LOC_KEY")).toBe(false);
  });

  it("a blank non-default value is a non-blocking LOCALE_KEY_GAP", () => {
    const issues = validateBuilderConfig(
      configWith({ en: { title: "Hello" }, de: { title: "" } }),
      { offeringPackageIds: [] },
    );
    const gaps = issues.filter((i) => i.code === "LOCALE_KEY_GAP");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ locale: "de", key: "title" });
    expect(isBlockingIssue(gaps[0]!)).toBe(false);
  });

  it("a filled non-default value emits no gap", () => {
    const issues = validateBuilderConfig(
      configWith({ en: { title: "Hello" }, de: { title: "Hallo" } }),
      { offeringPackageIds: [] },
    );
    expect(issues.some((i) => i.code === "LOCALE_KEY_GAP")).toBe(false);
  });
});

describe("absent vs blank default-locale values", () => {
  function configWith(localizations: Record<string, Record<string, string>>) {
    return {
      formatVersion: 2 as const,
      defaultLocale: "en",
      localizations,
      root: {
        type: "stack" as const,
        id: "root",
        axis: "v" as const,
        children: [{ type: "text" as const, id: "t1", key: "title", role: "title" as const }],
      },
    };
  }

  it("reports an ABSENT key as UNKNOWN_LOC_KEY, which blocks publish but NOT the save", () => {
    // Retiered: an absent default-locale key is reachable from the builder UI
    // in one click (switch the default locale to a newly added empty one),
    // so it must persist like any other in-progress authoring state — see
    // ISSUE_SEVERITY.
    const issues = validateBuilderConfig(configWith({ en: {} }), { offeringPackageIds: [] });
    const issue = issues.find((i) => i.key === "title");
    expect(issue?.code).toBe("UNKNOWN_LOC_KEY");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("reports a BLANK key as EMPTY_LOC_VALUE, which blocks publish but NOT the save", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "" } }), {
      offeringPackageIds: [],
    });
    const issue = issues.find((i) => i.key === "title");
    expect(issue?.code).toBe("EMPTY_LOC_VALUE");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("treats a whitespace-only value as blank, not as written copy", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "   " } }), {
      offeringPackageIds: [],
    });
    expect(issues.find((i) => i.key === "title")?.code).toBe("EMPTY_LOC_VALUE");
  });

  it("reports nothing once the default-locale value is written", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "Unlock everything" } }), {
      offeringPackageIds: [],
    });
    expect(issues.filter((i) => i.key === "title")).toEqual([]);
  });

  it("does not mistake a prototype-chain property for a present key", () => {
    // `"constructor" in {}` is true — a key named after an Object.prototype
    // member must still be reported as absent, not blank. Built with the key
    // in place rather than mutated afterwards: `root.children[0]` is typed as
    // the PaywallNode union, which has no `.key`.
    const issues = validateBuilderConfig(
      {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: {} },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "text", id: "t1", key: "constructor", role: "title" }],
        },
      },
      { offeringPackageIds: [] },
    );
    expect(issues.find((i) => i.key === "constructor")?.code).toBe("UNKNOWN_LOC_KEY");
  });
});

describe("LOCALE_KEY_GAP scoping", () => {
  const tree = {
    type: "stack" as const,
    id: "root",
    axis: "v" as const,
    children: [{ type: "text" as const, id: "t1", key: "title", role: "title" as const }],
  };

  it("still reports a key that IS written in the default locale and missing elsewhere", () => {
    const issues = validateBuilderConfig(
      { formatVersion: 2, defaultLocale: "en", localizations: { en: { title: "Hi" }, de: {} }, root: tree },
      { offeringPackageIds: [] },
    );
    const gap = issues.find((i) => i.code === "LOCALE_KEY_GAP");
    expect(gap?.locale).toBe("de");
    expect(gap?.key).toBe("title");
  });

  it("says nothing about an ORPHANED key no node references", () => {
    const issues = validateBuilderConfig(
      {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: { title: "Hi", ghost: "Leftover" }, de: { title: "Hallo" } },
        root: tree,
      },
      { offeringPackageIds: [] },
    );
    expect(issues.filter((i) => i.key === "ghost")).toEqual([]);
  });

  it("does not claim a key is 'set in the default locale' when it is blank there", () => {
    const issues = validateBuilderConfig(
      { formatVersion: 2, defaultLocale: "en", localizations: { en: { title: "" }, de: {} }, root: tree },
      { offeringPackageIds: [] },
    );
    expect(issues.filter((i) => i.code === "LOCALE_KEY_GAP")).toEqual([]);
    expect(issues.map((i) => i.code)).toContain("EMPTY_LOC_VALUE");
  });
});

describe("issue severity", () => {
  it("classifies every currently-emitted code", () => {
    // Retiered: UNKNOWN_LOC_KEY / FOREIGN_PACKAGE_ID / MISSING_PURCHASE_BUTTON /
    // CELL_TEMPLATE_BAD_NODE / OVERRIDE_BAD_PROP moved save -> publish (see
    // "save gate scope" below and ISSUE_SEVERITY's comments). DUPLICATE_NODE_ID
    // and SCHEMA_INVALID are untouched — the builder can't reach either from
    // the UI, so blocking the save on them costs an author nothing.
    expect(issueSeverity({ code: "DUPLICATE_NODE_ID" })).toBe("save");
    expect(issueSeverity({ code: "UNKNOWN_LOC_KEY" })).toBe("publish");
    expect(issueSeverity({ code: "FOREIGN_PACKAGE_ID" })).toBe("publish");
    expect(issueSeverity({ code: "MISSING_PURCHASE_BUTTON" })).toBe("publish");
    expect(issueSeverity({ code: "SCHEMA_INVALID" })).toBe("save");
    expect(issueSeverity({ code: "CELL_TEMPLATE_BAD_NODE" })).toBe("publish");
    expect(issueSeverity({ code: "OVERRIDE_BAD_PROP" })).toBe("publish");
    expect(issueSeverity({ code: "LOCALE_KEY_GAP" })).toBe("warning");
    expect(issueSeverity({ code: "OVERRIDE_SELECTED_OUTSIDE_CELL" })).toBe("warning");
    expect(issueSeverity({ code: "INTRO_VARIABLE_UNGUARDED" })).toBe("warning");
    expect(issueSeverity({ code: "UNKNOWN_ICON_NAME" })).toBe("warning");
  });

  it("defaults an unclassified code to the strictest tier", () => {
    expect(issueSeverity({ code: "SOME_CODE_ADDED_LATER" })).toBe("save");
    expect(isBlockingIssue({ code: "SOME_CODE_ADDED_LATER" })).toBe(true);
  });

  it("keeps the tiers ordered: everything that blocks a save blocks a publish", () => {
    for (const code of [
      "DUPLICATE_NODE_ID",
      "UNKNOWN_LOC_KEY",
      "FOREIGN_PACKAGE_ID",
      "MISSING_PURCHASE_BUTTON",
      "SCHEMA_INVALID",
      "CELL_TEMPLATE_BAD_NODE",
      "OVERRIDE_BAD_PROP",
      "LOCALE_KEY_GAP",
      "OVERRIDE_SELECTED_OUTSIDE_CELL",
      "INTRO_VARIABLE_UNGUARDED",
      "UNKNOWN_ICON_NAME",
      "SOME_CODE_ADDED_LATER",
    ]) {
      // Unconditional: a guarded `if (isBlockingIssue) expect(...)` would run
      // zero assertions — and still pass — the day every code in this list is
      // reclassified as a warning.
      expect(!isBlockingIssue({ code }) || isPublishBlockingIssue({ code })).toBe(true);
    }
  });

  it("warnings block neither gate", () => {
    expect(isBlockingIssue({ code: "LOCALE_KEY_GAP" })).toBe(false);
    expect(isPublishBlockingIssue({ code: "LOCALE_KEY_GAP" })).toBe(false);
  });

  it("never resolves a code to an inherited Object.prototype property", () => {
    // A plain `ISSUE_SEVERITY[issue.code]` lookup resolves "constructor" to
    // the Object constructor function — truthy, so the `?? "save"` fallback
    // never kicks in — which would fail OPEN on the save gate instead of
    // defaulting to the strictest tier.
    expect(issueSeverity({ code: "constructor" })).toBe("save");
    expect(isBlockingIssue({ code: "constructor" })).toBe(true);
  });
});

describe("save gate scope", () => {
  const MOVED = [
    "UNKNOWN_LOC_KEY",
    "EMPTY_LOC_VALUE",
    "FOREIGN_PACKAGE_ID",
    "MISSING_PURCHASE_BUTTON",
    "CELL_TEMPLATE_BAD_NODE",
    "OVERRIDE_BAD_PROP",
  ];

  it("lets an incomplete draft save while still blocking its publish", () => {
    for (const code of MOVED) {
      expect(issueSeverity({ code })).toBe("publish");
      expect(isBlockingIssue({ code })).toBe(false);
      expect(isPublishBlockingIssue({ code })).toBe(true);
    }
  });

  it("still blocks the save on a config the builder could not address", () => {
    expect(issueSeverity({ code: "DUPLICATE_NODE_ID" })).toBe("save");
    expect(isBlockingIssue({ code: "DUPLICATE_NODE_ID" })).toBe(true);
  });

  it("leaves an unclassified code at the strictest tier", () => {
    expect(isBlockingIssue({ code: "SOME_CODE_ADDED_LATER" })).toBe(true);
  });

  it("does not change what a publish rejects", () => {
    // The invariant this whole phase must not break: retiering moves codes
    // between save and publish, never in or out of the warning tier.
    const WARNINGS = [
      "LOCALE_KEY_GAP",
      "OVERRIDE_SELECTED_OUTSIDE_CELL",
      "INTRO_VARIABLE_UNGUARDED",
      "UNKNOWN_ICON_NAME",
    ];
    for (const code of WARNINGS) expect(isPublishBlockingIssue({ code })).toBe(false);
    for (const code of [...MOVED, "DUPLICATE_NODE_ID", "SCHEMA_INVALID", "SOME_CODE_ADDED_LATER"]) {
      expect(isPublishBlockingIssue({ code })).toBe(true);
    }
  });
});

describe("VISIBILITY_NEVER_MATCHES", () => {
  function withVisibility(visibility: Record<string, unknown>) {
    const config = baseConfig();
    (config.root.children[0] as { visibility?: unknown }).visibility = visibility;
    return config;
  }

  it("warns when the version bounds cross, so the node can never render", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "3.0.0", maxAppVersion: "2.0.0" }),
      { offeringPackageIds },
    );
    const issue = issues.find((i) => i.code === "VISIBILITY_NEVER_MATCHES");
    expect(issue).toBeDefined();
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("does not warn about an empty platform list, which means 'all'", () => {
    const issues = validateBuilderConfig(withVisibility({ platform: [] }), { offeringPackageIds });
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });

  it("does not warn on bounds that can be satisfied", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "1.0.0", maxAppVersion: "3.0.0" }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });

  it("does not warn when the bounds cannot be compared", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "1.0.0-beta", maxAppVersion: "2.0.0" }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });
});

describe("VISIBILITY_BOUND_UNPARSEABLE", () => {
  function withVisibility(visibility: Record<string, unknown>) {
    const config = baseConfig();
    (config.root.children[0] as { visibility?: unknown }).visibility = visibility;
    return config;
  }

  it("warns about a bound the comparator cannot read, rather than ignoring it silently", () => {
    const issues = validateBuilderConfig(withVisibility({ minAppVersion: "v1.2.0" }), {
      offeringPackageIds,
    });
    const issue = issues.find((i) => i.code === "VISIBILITY_BOUND_UNPARSEABLE");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("minAppVersion");
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("names each unreadable bound separately", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "v1", maxAppVersion: "2.0.0-rc" }),
      { offeringPackageIds },
    );
    expect(issues.filter((i) => i.code === "VISIBILITY_BOUND_UNPARSEABLE")).toHaveLength(2);
  });

  it("says nothing about bounds it can read", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "1.0", maxAppVersion: "2.0.0" }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "VISIBILITY_BOUND_UNPARSEABLE")).toBe(false);
  });
});

describe("MISSING_PURCHASE_BUTTON is per-platform once visibility is in play", () => {
  function tree(children: unknown[]) {
    return baseConfig({
      root: { type: "stack", id: "root", axis: "v", children: children as never },
    });
  }
  const pkg = { type: "packageList", id: "pl", packageIds: ["pkg_monthly"], cellLayout: "row" };

  it("fires for the platform where the only purchase button is hidden", () => {
    const config = tree([
      pkg,
      { type: "purchaseButton", id: "pb", labelKey: "cta_key", visibility: { platform: ["ios"] } },
    ]);
    const issue = validateBuilderConfig(config, { offeringPackageIds }).find(
      (i) => i.code === "MISSING_PURCHASE_BUTTON",
    );
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("android");
    expect(issue!.message).toContain("web");
    expect(issue!.message).not.toContain("ios");
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("does not fire when the package list is hidden on the same platform as the button", () => {
    const config = tree([
      { ...pkg, visibility: { platform: ["ios"] } },
      { type: "purchaseButton", id: "pb", labelKey: "cta_key", visibility: { platform: ["ios"] } },
    ]);
    expect(
      validateBuilderConfig(config, { offeringPackageIds }).some(
        (i) => i.code === "MISSING_PURCHASE_BUTTON",
      ),
    ).toBe(false);
  });

  it("follows ancestor visibility — a button inside an iOS-only stack is iOS-only", () => {
    const config = tree([
      pkg,
      {
        type: "stack",
        id: "ios_stack",
        axis: "v",
        visibility: { platform: ["ios"] },
        children: [{ type: "purchaseButton", id: "pb", labelKey: "cta_key" }],
      },
    ]);
    const issue = validateBuilderConfig(config, { offeringPackageIds }).find(
      (i) => i.code === "MISSING_PURCHASE_BUTTON",
    );
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("android");
  });

  it("is silent when a button reaches every platform the list does", () => {
    const config = tree([pkg, { type: "purchaseButton", id: "pb", labelKey: "cta_key" }]);
    expect(
      validateBuilderConfig(config, { offeringPackageIds }).some(
        (i) => i.code === "MISSING_PURCHASE_BUTTON",
      ),
    ).toBe(false);
  });
});

describe("UNKNOWN_ICON_NAME", () => {
  function withIcon(name: string) {
    return baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "icon", id: "ic", name }],
      },
    });
  }

  it("warns about an icon name not in the registry, without blocking save or publish", () => {
    const issues = validateBuilderConfig(withIcon("not-a-real-icon"), { offeringPackageIds });
    const issue = issues.find((i) => i.code === "UNKNOWN_ICON_NAME");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("ic");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("says nothing for a name that is in the registry", () => {
    const issues = validateBuilderConfig(withIcon("check"), { offeringPackageIds });
    expect(issues.some((i) => i.code === "UNKNOWN_ICON_NAME")).toBe(false);
  });

  it("still catches an unknown icon name nested inside a packageList.cellTemplate subtree", () => {
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
              children: [{ type: "icon", id: "cell_icon", name: "not-a-real-icon" }],
            },
          },
          { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "UNKNOWN_ICON_NAME");
    expect(issue).toBeDefined();
    expect(issue?.nodeId).toBe("cell_icon");
  });

  it("warns about an unknown icon name on a featureList row, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "featureList",
            id: "fl",
            rows: [{ labelKey: "f_a", icon: "not-a-real-icon" }],
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "UNKNOWN_ICON_NAME");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("fl");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("warns about an unknown icon name on a timeline row, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "timeline",
            id: "tl",
            rows: [{ labelKey: "t_a", icon: "not-a-real-icon" }],
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "UNKNOWN_ICON_NAME");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("tl");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("says nothing for a featureList/timeline row icon that is in the registry", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "featureList", id: "fl", rows: [{ labelKey: "f_a", icon: "check" }] },
          { type: "timeline", id: "tl", rows: [{ labelKey: "t_a", icon: "clock" }] },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.some((i) => i.code === "UNKNOWN_ICON_NAME")).toBe(false);
  });
});

describe("FEATURE_LIST_TOO_LONG and EMPTY_ROWS", () => {
  function withFeatureList(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({ labelKey: `f_${i}` }));
    return baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "featureList", id: "fl", rows }],
      },
    });
  }

  it("warns when a featureList has more than FEATURE_LIST_SOFT_MAX rows, without blocking save or publish", () => {
    const issues = validateBuilderConfig(withFeatureList(7), { offeringPackageIds });
    const issue = issues.find((i) => i.code === "FEATURE_LIST_TOO_LONG");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("fl");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("does not warn at exactly FEATURE_LIST_SOFT_MAX rows", () => {
    const issues = validateBuilderConfig(withFeatureList(6), { offeringPackageIds });
    expect(issues.some((i) => i.code === "FEATURE_LIST_TOO_LONG")).toBe(false);
  });

  it("warns when a featureList has no rows, without blocking save or publish", () => {
    const issues = validateBuilderConfig(withFeatureList(0), { offeringPackageIds });
    const issue = issues.find((i) => i.code === "EMPTY_ROWS");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("fl");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("warns when a timeline has no rows, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "timeline", id: "tl", rows: [] }],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "EMPTY_ROWS");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("tl");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("says nothing for a non-empty featureList within the soft max", () => {
    const issues = validateBuilderConfig(withFeatureList(3), { offeringPackageIds });
    expect(issues.some((i) => i.code === "EMPTY_ROWS" || i.code === "FEATURE_LIST_TOO_LONG")).toBe(false);
  });
});

describe("LOCALIZED_KEYS for wave B row-carrying node types", () => {
  it("collects every featureList row's labelKey", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "featureList",
            id: "fl",
            rows: [{ labelKey: "f_a" }, { labelKey: "f_b" }],
          },
        ],
      },
    });
    const usages = collectLocalizationUsages(config.root);
    expect(usages.map((u) => u.key)).toEqual(expect.arrayContaining(["f_a", "f_b"]));
  });

  it("collects a timeline row's labelKey and, when present, its captionKey", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "timeline",
            id: "tl",
            rows: [
              { labelKey: "t_a", captionKey: "t_a_cap" },
              { labelKey: "t_b" },
            ],
          },
        ],
      },
    });
    const usages = collectLocalizationUsages(config.root);
    expect(usages.map((u) => u.key)).toEqual(
      expect.arrayContaining(["t_a", "t_a_cap", "t_b"]),
    );
  });

  it("collects a socialProof's labelKey", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "socialProof", id: "sp", labelKey: "sp_key" }],
      },
    });
    const usages = collectLocalizationUsages(config.root);
    expect(usages.map((u) => u.key)).toEqual(expect.arrayContaining(["sp_key"]));
  });
});

describe("LOCALIZED_KEYS for purchaseButton.trialLabelKey", () => {
  it("reports UNKNOWN_LOC_KEY for a trialLabelKey missing from defaultLocale", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "purchaseButton",
            id: "purchase",
            labelKey: "cta_key",
            trialLabelKey: "cta.trial",
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const gap = issues.find((i) => i.code === "UNKNOWN_LOC_KEY" && i.key === "cta.trial");
    expect(gap).toMatchObject({ code: "UNKNOWN_LOC_KEY", nodeId: "purchase", key: "cta.trial" });
  });

  it("reports EMPTY_LOC_VALUE for a trialLabelKey present but blank in defaultLocale", () => {
    const config = baseConfig({
      localizations: {
        en: { title_key: "Go Pro", cta_key: "Continue", "cta.trial": "" },
        tr: { title_key: "Pro Ol", cta_key: "Devam" },
      },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "purchaseButton",
            id: "purchase",
            labelKey: "cta_key",
            trialLabelKey: "cta.trial",
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const gap = issues.find((i) => i.code === "EMPTY_LOC_VALUE" && i.key === "cta.trial");
    expect(gap).toMatchObject({ code: "EMPTY_LOC_VALUE", nodeId: "purchase", key: "cta.trial" });
  });

  it("emits neither UNKNOWN_LOC_KEY nor EMPTY_LOC_VALUE for cta.trial when trialLabelKey is absent", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "purchaseButton", id: "purchase", labelKey: "cta_key" }],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.some((i) => i.key === "cta.trial")).toBe(false);
    expect(issues).toEqual([]);
  });
});

describe("wave C: STICKY_FOOTER_NOT_AT_ROOT and MULTIPLE_STICKY_FOOTERS", () => {
  it("says nothing for a single stickyFooter at the root", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "stickyFooter", id: "sf", children: [{ type: "spacer", id: "s1", size: 8 }] },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.some((i) => i.code === "STICKY_FOOTER_NOT_AT_ROOT")).toBe(false);
    expect(issues.some((i) => i.code === "MULTIPLE_STICKY_FOOTERS")).toBe(false);
  });

  it("warns when a stickyFooter is nested rather than a direct child of root, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "stack",
            id: "wrapper",
            axis: "v",
            children: [{ type: "stickyFooter", id: "sf", children: [] }],
          },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "STICKY_FOOTER_NOT_AT_ROOT");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("sf");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("warns when more than one stickyFooter exists, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "stickyFooter", id: "sf1", children: [] },
          { type: "stickyFooter", id: "sf2", children: [] },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "MULTIPLE_STICKY_FOOTERS");
    expect(issue).toBeDefined();
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
    // The message must describe what actually happens, not only what is
    // "expected" — the author needs to know WHICH footer they will see.
    expect(issue!.message).toContain("last");
  });

  // The pinning rule is "a direct child of root, last among several wins",
  // NOT "the last child of root". A single footer placed above a sibling is
  // still pinned by all three renderers, so the validator deliberately says
  // nothing about it — see the rule comment in validate.ts.
  it("says nothing for a single root-level stickyFooter that is not the last child", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "stickyFooter", id: "sf", children: [{ type: "spacer", id: "s1", size: 8 }] },
          { type: "spacer", id: "s2", size: 8 },
        ],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.some((i) => i.code === "STICKY_FOOTER_NOT_AT_ROOT")).toBe(false);
    expect(issues.some((i) => i.code === "MULTIPLE_STICKY_FOOTERS")).toBe(false);
  });
});

describe("wave C: COUNTDOWN_NO_DEADLINE and COUNTDOWN_DEADLINE_PAST", () => {
  it("blocks publish but not save when a countdown has neither endsAt nor durationSeconds", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd" }],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    const issue = issues.find((i) => i.code === "COUNTDOWN_NO_DEADLINE");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("cd");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("says nothing for a countdown carrying durationSeconds only", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd", durationSeconds: 900 }],
      },
    });
    const issues = validateBuilderConfig(config, { offeringPackageIds });
    expect(issues.some((i) => i.code === "COUNTDOWN_NO_DEADLINE")).toBe(false);
  });

  it("warns when endsAt is already in the past, using the injected clock, without blocking save or publish", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd", endsAt: "2020-01-01T00:00:00.000Z" }],
      },
    });
    const fixedNow = () => new Date("2026-01-01T00:00:00.000Z").getTime();
    const issues = validateBuilderConfig(config, { offeringPackageIds, now: fixedNow });
    const issue = issues.find((i) => i.code === "COUNTDOWN_DEADLINE_PAST");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("cd");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("says nothing when endsAt is in the future relative to the injected clock", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd", endsAt: "2030-01-01T00:00:00.000Z" }],
      },
    });
    const fixedNow = () => new Date("2026-01-01T00:00:00.000Z").getTime();
    const issues = validateBuilderConfig(config, { offeringPackageIds, now: fixedNow });
    expect(issues.some((i) => i.code === "COUNTDOWN_DEADLINE_PAST")).toBe(false);
  });
});

describe("LOCALIZED_KEYS for wave C node types", () => {
  it("contributes nothing of its own for stickyFooter — its children are walked separately", () => {
    const config = baseConfig({
      localizations: { en: { child_key: "Continue" } },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "stickyFooter",
            id: "sf",
            children: [{ type: "text", id: "t1", key: "child_key", role: "body" }],
          },
        ],
      },
    });
    const usages = collectLocalizationUsages(config.root);
    expect(usages.some((u) => u.nodeId === "sf")).toBe(false);
    expect(usages.map((u) => u.key)).toEqual(expect.arrayContaining(["child_key"]));
  });

  it("collects a countdown's labelKey when present, and nothing when absent", () => {
    const withLabel = baseConfig({
      localizations: { en: { cd_key: "Ends soon" } },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd", labelKey: "cd_key" }],
      },
    });
    expect(collectLocalizationUsages(withLabel.root).map((u) => u.key)).toEqual(
      expect.arrayContaining(["cd_key"]),
    );

    const withoutLabel = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "countdown", id: "cd" }],
      },
    });
    expect(collectLocalizationUsages(withoutLabel.root).some((u) => u.nodeId === "cd")).toBe(false);
  });
});

describe("wave D1: CAROUSEL_EMPTY, CAROUSEL_SINGLE_PAGE, CAROUSEL_AUTO_ADVANCE_TOO_FAST", () => {
  const pageA: PaywallNode = { type: "spacer", id: "pageA", size: 8 };
  const pageB: PaywallNode = { type: "spacer", id: "pageB", size: 8 };

  function configWith(node: PaywallNode): BuilderConfig {
    return baseConfig({
      root: { type: "stack", id: "root", axis: "v", children: [node] },
    });
  }

  it("raises CAROUSEL_EMPTY, blocking publish but not save, for a childless carousel", () => {
    const issues = validateBuilderConfig(
      configWith({ type: "carousel", id: "c1", children: [] }),
      { offeringPackageIds },
    );
    const issue = issues.find((i) => i.code === "CAROUSEL_EMPTY");
    expect(issue).toBeDefined();
    expect(issue!.nodeId).toBe("c1");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("raises CAROUSEL_AUTO_ADVANCE_TOO_FAST below the floor, without blocking save or publish", () => {
    const node: PaywallNode = { type: "carousel", id: "c1", children: [pageA, pageB], autoAdvanceSeconds: 1 };
    const issues = validateBuilderConfig(configWith(node), { offeringPackageIds });
    const issue = issues.find((i) => i.code === "CAROUSEL_AUTO_ADVANCE_TOO_FAST");
    expect(issue).toBeDefined();
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("does NOT raise CAROUSEL_AUTO_ADVANCE_TOO_FAST exactly at the floor", () => {
    const node: PaywallNode = {
      type: "carousel",
      id: "c1",
      children: [pageA, pageB],
      autoAdvanceSeconds: CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
    };
    const issues = validateBuilderConfig(configWith(node), { offeringPackageIds });
    expect(issues.some((i) => i.code === "CAROUSEL_AUTO_ADVANCE_TOO_FAST")).toBe(false);
  });

  it("raises CAROUSEL_SINGLE_PAGE for exactly one child, without blocking save or publish", () => {
    const issues = validateBuilderConfig(
      configWith({ type: "carousel", id: "c1", children: [pageA] }),
      { offeringPackageIds },
    );
    const issue = issues.find((i) => i.code === "CAROUSEL_SINGLE_PAGE");
    expect(issue).toBeDefined();
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("says nothing about page count for two or more children", () => {
    const issues = validateBuilderConfig(
      configWith({ type: "carousel", id: "c1", children: [pageA, pageB] }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "CAROUSEL_EMPTY")).toBe(false);
    expect(issues.some((i) => i.code === "CAROUSEL_SINGLE_PAGE")).toBe(false);
  });

  it("walks INTO carousel children so a nested node's issues surface", () => {
    const nested: PaywallNode = {
      type: "carousel",
      id: "c1",
      children: [{ type: "icon", id: "i1", name: "not-a-real-icon" }],
    };
    const issues = validateBuilderConfig(configWith(nested), { offeringPackageIds });
    expect(issues.some((i) => i.code === "UNKNOWN_ICON_NAME")).toBe(true);
  });
});

describe("LOCALIZED_KEYS for carousel", () => {
  it("contributes nothing of its own — its children are walked separately", () => {
    const config = baseConfig({
      localizations: { en: { child_key: "Continue" } },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "carousel",
            id: "c1",
            children: [{ type: "text", id: "t1", key: "child_key", role: "body" }],
          },
        ],
      },
    });
    const usages = collectLocalizationUsages(config.root);
    expect(usages.some((u) => u.nodeId === "c1")).toBe(false);
    expect(usages.map((u) => u.key)).toEqual(expect.arrayContaining(["child_key"]));
  });
});
