import { describe, expect, it } from "vitest";
import { collectMediaUrls } from "./collect-urls";
import type { BuilderConfig, PaywallNode } from "./schema";

function baseConfig(root: PaywallNode & { type: "stack" }): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: {} },
    root,
  };
}

describe("collectMediaUrls", () => {
  it("collects image light and dark URLs", () => {
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "image",
          id: "hero",
          url: { light: "https://cdn.example/hero-light.webp", dark: "https://cdn.example/hero-dark.webp" },
        },
      ],
    });

    expect(collectMediaUrls(config)).toEqual(
      expect.arrayContaining([
        "https://cdn.example/hero-light.webp",
        "https://cdn.example/hero-dark.webp",
      ]),
    );
    expect(collectMediaUrls(config)).toHaveLength(2);
  });

  it("collects video url and posterUrl", () => {
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "video",
          id: "promo",
          url: { light: "https://cdn.example/promo-light.mp4", dark: "https://cdn.example/promo-dark.mp4" },
          posterUrl: {
            light: "https://cdn.example/poster-light.webp",
            dark: "https://cdn.example/poster-dark.webp",
          },
        },
      ],
    });

    expect(collectMediaUrls(config).sort()).toEqual(
      [
        "https://cdn.example/poster-dark.webp",
        "https://cdn.example/poster-light.webp",
        "https://cdn.example/promo-dark.mp4",
        "https://cdn.example/promo-light.mp4",
      ].sort(),
    );
  });

  it("collects lottie url", () => {
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "lottie",
          id: "confetti",
          url: { light: "https://cdn.example/confetti.json" },
        },
      ],
    });

    expect(collectMediaUrls(config)).toEqual(["https://cdn.example/confetti.json"]);
  });

  it("collects URLs from nested containers", () => {
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "carousel",
          id: "carousel",
          children: [
            {
              type: "stickyFooter",
              id: "footer",
              children: [
                {
                  type: "stack",
                  id: "inner",
                  axis: "h",
                  children: [
                    { type: "image", id: "deep", url: { light: "https://cdn.example/deep.webp" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(collectMediaUrls(config)).toEqual(["https://cdn.example/deep.webp"]);
  });

  it("collects URLs from conditional overrides, not just base props", () => {
    // OVERRIDABLE_PROP_KEYS.video includes "url" and "posterUrl" — an
    // override can introduce a URL the base props never mention. An
    // override-only asset that the index misses would be deleted
    // without a warning.
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "video",
          id: "promo",
          url: { light: "https://cdn.example/base.mp4" },
          overrides: [
            {
              when: { kind: "introEligible" },
              props: {
                url: { light: "https://cdn.example/override-only.mp4" },
                posterUrl: { light: "https://cdn.example/override-poster.webp" },
              },
            },
          ],
        },
        {
          type: "lottie",
          id: "confetti",
          url: { light: "https://cdn.example/confetti-base.json" },
          overrides: [
            {
              when: { kind: "selected" },
              props: { url: { light: "https://cdn.example/confetti-override.json" } },
            },
          ],
        },
      ],
    });

    const urls = collectMediaUrls(config);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.example/base.mp4",
        "https://cdn.example/override-only.mp4",
        "https://cdn.example/override-poster.webp",
        "https://cdn.example/confetti-base.json",
        "https://cdn.example/confetti-override.json",
      ]),
    );
    expect(urls).toHaveLength(5);
  });

  it("collects URLs from cellTemplate subtrees", () => {
    const config = baseConfig({
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
            id: "cell",
            axis: "h",
            children: [
              { type: "icon", id: "check-icon", name: "check" },
              {
                type: "image",
                id: "badge",
                url: { light: "https://cdn.example/badge.webp" },
              },
            ],
          },
        },
      ],
    });

    expect(collectMediaUrls(config)).toEqual(["https://cdn.example/badge.webp"]);
  });

  it("returns no duplicates", () => {
    const shared = { light: "https://cdn.example/shared.webp" };
    const config = baseConfig({
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "image", id: "a", url: shared },
        { type: "image", id: "b", url: shared },
      ],
    });

    expect(collectMediaUrls(config)).toEqual(["https://cdn.example/shared.webp"]);
  });

  it("returns an empty list when config has no root (null builderConfig)", () => {
    expect(collectMediaUrls(null)).toEqual([]);
    expect(collectMediaUrls(undefined)).toEqual([]);
  });
});
