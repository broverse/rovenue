import { describe, expect, it } from "vitest";
import { builderConfigSchema, emptyBuilderConfig, type BuilderConfig } from "./schema";

describe("builderConfigSchema", () => {
  it("round-trips a two-level tree exercising every node type", () => {
    const config: BuilderConfig = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: {
        en: { title_key: "Go Pro", cta_key: "Continue", close_key: "Close" },
      },
      background: { light: "#ffffff", dark: "#000000" },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        spacing: 12,
        align: "center",
        padding: { t: 16, r: 16, b: 16, l: 16 },
        size: { width: "fill", height: "fit" },
        background: { light: "#ffffff" },
        cornerRadius: 8,
        children: [
          {
            type: "image",
            id: "hero",
            url: { light: "https://x/hero-light.png", dark: "https://x/hero-dark.png" },
            height: 200,
            cornerRadius: 12,
            alt: "hero",
          },
          {
            type: "text",
            id: "title",
            key: "title_key",
            role: "title",
            color: { light: "#111111" },
            align: "center",
          },
          {
            type: "stack",
            id: "nested",
            axis: "h",
            children: [
              {
                type: "packageList",
                id: "packages",
                packageIds: ["pkg_monthly", "pkg_annual"],
                defaultSelected: "pkg_annual",
                cellLayout: "row",
              },
              {
                type: "spacer",
                id: "spacer_1",
                size: 8,
              },
            ],
          },
          {
            type: "purchaseButton",
            id: "purchase",
            labelKey: "cta_key",
          },
          {
            type: "button",
            id: "close",
            labelKey: "close_key",
            style: "plain",
            action: { kind: "close" },
          },
        ],
      },
    };

    const result = builderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(config);
    }
  });

  it("accepts nodes carrying a fallback that is itself a full PaywallNode", () => {
    const config: BuilderConfig = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "image",
            id: "hero",
            url: { light: "https://x/hero.png" },
            fallback: {
              type: "text",
              id: "hero_fallback",
              key: "hero_alt_key",
              role: "body",
              fallback: {
                type: "spacer",
                id: "deepest_fallback",
                size: 4,
              },
            },
          },
        ],
      },
    };

    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects a stack node with a bad axis", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: { type: "stack", id: "root", axis: "diagonal", children: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a node missing id", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "spacer", size: 4 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects formatVersion !== 2", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 1,
      defaultLocale: "en",
      localizations: { en: {} },
      root: { type: "stack", id: "root", axis: "v", children: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object localization table entry", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: "not an object" },
      root: { type: "stack", id: "root", axis: "v", children: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown node type", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "carousel", id: "c1" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed node nested inside a fallback", () => {
    const result = builderConfigSchema.safeParse({
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "image",
            id: "hero",
            url: { light: "https://x/hero.png" },
            fallback: {
              type: "stack",
              id: "hero_fallback",
              axis: "diagonal",
              children: [],
            },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("overrides", () => {
  function withRootChild(child: unknown) {
    return {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: { type: "stack", id: "root", axis: "v", children: [child] },
    };
  }

  it("accepts a text node override with allowed props (key, color, align) under introEligible", () => {
    const config = withRootChild({
      type: "text",
      id: "t1",
      key: "title_key",
      role: "title",
      overrides: [
        {
          when: { kind: "introEligible" },
          props: { key: "intro_title_key", color: { light: "#f00" }, align: "center" },
        },
      ],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts a button node override with allowed props (labelKey, style) under selected", () => {
    const config = withRootChild({
      type: "button",
      id: "b1",
      labelKey: "cta_key",
      style: "primary",
      action: { kind: "close" },
      overrides: [
        { when: { kind: "selected" }, props: { labelKey: "cta_selected_key", style: "secondary" } },
      ],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts a stack node override with allowed props (spacing, align, background, cornerRadius)", () => {
    const config = withRootChild({
      type: "stack",
      id: "s1",
      axis: "h",
      children: [],
      overrides: [
        {
          when: { kind: "selected" },
          props: { spacing: 4, align: "start", background: { light: "#eee" }, cornerRadius: 2 },
        },
      ],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects an override with an unknown when.kind", () => {
    const config = withRootChild({
      type: "text",
      id: "t1",
      key: "title_key",
      role: "title",
      overrides: [{ when: { kind: "sizeClass" }, props: {} }],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a structural key in override props (e.g. 'type')", () => {
    const config = withRootChild({
      type: "text",
      id: "t1",
      key: "title_key",
      role: "title",
      overrides: [{ when: { kind: "introEligible" }, props: { type: "spacer" } }],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a stack override using 'padding' or 'size' — visual-adjacent but not in the whitelist", () => {
    const padding = withRootChild({
      type: "stack",
      id: "s1",
      axis: "v",
      children: [],
      overrides: [{ when: { kind: "selected" }, props: { padding: { t: 4 } } }],
    });
    expect(builderConfigSchema.safeParse(padding).success).toBe(false);

    const size = withRootChild({
      type: "stack",
      id: "s1",
      axis: "v",
      children: [],
      overrides: [{ when: { kind: "selected" }, props: { size: { width: "fill" } } }],
    });
    expect(builderConfigSchema.safeParse(size).success).toBe(false);
  });

  it("rejects a packageList override with any prop key — packageList has no overridable visual fields", () => {
    const config = withRootChild({
      type: "packageList",
      id: "p1",
      packageIds: [],
      cellLayout: "row",
      overrides: [{ when: { kind: "selected" }, props: { cornerRadius: 4 } }],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts a packageList override with an empty props object", () => {
    const config = withRootChild({
      type: "packageList",
      id: "p1",
      packageIds: [],
      cellLayout: "row",
      overrides: [{ when: { kind: "selected" }, props: {} }],
    });
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("overrides survive on a fallback subtree", () => {
    const config = withRootChild({
      type: "image",
      id: "hero",
      url: { light: "https://x/hero.png" },
      fallback: {
        type: "text",
        id: "hero_fb",
        key: "hero_alt",
        role: "body",
        overrides: [{ when: { kind: "introEligible" }, props: { key: "hero_alt_intro" } }],
      },
    });
    const result = builderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const root = result.data.root;
      const hero = root.children[0]!;
      expect(hero.type).toBe("image");
      expect(hero.fallback?.overrides).toEqual([
        { when: { kind: "introEligible" }, props: { key: "hero_alt_intro" } },
      ]);
    }
  });
});

describe("cellTemplate", () => {
  it("accepts a packageList with a nested visual-tree cellTemplate", () => {
    const config = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: { badge_key: "Best value" } },
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
              type: "stack",
              id: "cell_root",
              axis: "v",
              children: [
                { type: "text", id: "cell_badge", key: "badge_key", role: "caption" },
                { type: "spacer", id: "cell_spacer", size: 4 },
              ],
            },
          },
          { type: "purchaseButton", id: "purchase", labelKey: "badge_key" },
        ],
      },
    };
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("schema (not validator) accepts a packageList nested inside a cellTemplate — structurally valid PaywallNode", () => {
    const config = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "outer",
            packageIds: [],
            cellLayout: "row",
            cellTemplate: {
              type: "packageList",
              id: "inner",
              packageIds: [],
              cellLayout: "row",
            },
          },
        ],
      },
    };
    // The strict schema only enforces node SHAPE, not the "no packageList
    // inside cellTemplate" business rule — that's CELL_TEMPLATE_BAD_NODE,
    // owned by validateBuilderConfig (see validate.test.ts).
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects a malformed node nested inside a cellTemplate", () => {
    const config = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "packageList",
            id: "p1",
            packageIds: [],
            cellLayout: "row",
            cellTemplate: { type: "stack", id: "cell_root", axis: "diagonal", children: [] },
          },
        ],
      },
    };
    expect(builderConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("emptyBuilderConfig", () => {
  it("produces a schema-valid config defaulting to the given locale", () => {
    const config = emptyBuilderConfig("tr");
    expect(config.defaultLocale).toBe("tr");
    expect(config.formatVersion).toBe(2);
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("defaults to 'en' when no locale is given", () => {
    const config = emptyBuilderConfig();
    expect(config.defaultLocale).toBe("en");
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });
});
