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
