import { describe, expect, it } from "vitest";
import {
  collectLocalizationKeys,
  resolveText,
  validateBuilderConfig,
  type BuilderIssue,
} from "./validate";
import type { BuilderConfig, StackNode } from "./schema";

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
