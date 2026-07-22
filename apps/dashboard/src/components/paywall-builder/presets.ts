import type { BuilderConfig, StackNode } from "@rovenue/shared/paywall";

// =============================================================
// Starting-point templates offered by the builder's "new paywall"
// flow. Each preset's `build(defaultLocale)` must produce a
// BuilderConfig that passes `validateBuilderConfig` with zero
// non-LOCALE_KEY_GAP issues against ANY offering — so presets never
// reference specific package ids (`packageIds: []` means "every
// package in the offering", same convention the renderer + API use)
// and never set `defaultSelected`.
// =============================================================

function root(children: StackNode["children"]): StackNode {
  return { type: "stack", id: "root", axis: "v", spacing: 16, padding: { t: 24, r: 20, b: 24, l: 20 }, children };
}

function buildHeroPreset(defaultLocale: string): BuilderConfig {
  const root_: StackNode = root([
    { type: "image", id: "hero_image", url: { light: "" }, height: 220, cornerRadius: 16 },
    { type: "text", id: "hero_title", key: "hero_title", role: "title", align: "center" },
    { type: "text", id: "hero_subtitle", key: "hero_subtitle", role: "subtitle", align: "center" },
    { type: "spacer", id: "hero_spacer", size: 8 },
    {
      type: "packageList",
      id: "hero_packages",
      packageIds: [],
      cellLayout: "row",
    },
    {
      type: "purchaseButton",
      id: "hero_purchase",
      labelKey: "hero_purchase",
    },
    {
      type: "button",
      id: "hero_restore",
      labelKey: "hero_restore",
      style: "plain",
      action: { kind: "restore" },
    },
  ]);

  return {
    formatVersion: 2,
    defaultLocale,
    localizations: {
      [defaultLocale]: {
        hero_title: "Unlock everything",
        hero_subtitle: "Get full access to every feature, no limits.",
        hero_purchase: "Continue",
        hero_restore: "Restore Purchases",
      },
    },
    root: root_,
  };
}

function buildComparisonPreset(defaultLocale: string): BuilderConfig {
  const root_: StackNode = root([
    { type: "text", id: "cmp_title", key: "cmp_title", role: "title", align: "center" },
    { type: "text", id: "cmp_subtitle", key: "cmp_subtitle", role: "body", align: "center" },
    {
      type: "packageList",
      id: "cmp_packages",
      packageIds: [],
      cellLayout: "column",
    },
    { type: "text", id: "cmp_caption", key: "cmp_caption", role: "caption", align: "center" },
    {
      type: "purchaseButton",
      id: "cmp_purchase",
      labelKey: "cmp_purchase",
    },
    {
      type: "button",
      id: "cmp_restore",
      labelKey: "cmp_restore",
      style: "plain",
      action: { kind: "restore" },
    },
  ]);

  return {
    formatVersion: 2,
    defaultLocale,
    localizations: {
      [defaultLocale]: {
        cmp_title: "Choose your plan",
        cmp_subtitle: "All plans include full access — pick what fits.",
        cmp_caption: "Cancel anytime.",
        cmp_purchase: "Continue",
        cmp_restore: "Restore Purchases",
      },
    },
    root: root_,
  };
}

export const PRESETS: Array<{
  id: "hero" | "comparison";
  name: string;
  build: (defaultLocale: string) => BuilderConfig;
}> = [
  { id: "hero", name: "Hero", build: buildHeroPreset },
  { id: "comparison", name: "Comparison", build: buildComparisonPreset },
];
