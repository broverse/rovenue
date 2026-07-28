import { describe, expect, it } from "vitest";
import { assertSaveValid, GeneratedConfigError } from "./validate-config";
import type { BuilderConfig } from "@rovenue/shared/paywall";

function baseConfig(overrides: Partial<BuilderConfig> = {}): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: { title_key: "Go Pro", cta_key: "Continue" },
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
          packageIds: ["pkg_monthly"],
          cellLayout: "row",
        },
        { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
      ],
    },
    ...overrides,
  };
}

describe("assertSaveValid", () => {
  it("passes a save-valid-but-publish-incomplete config (no purchaseButton)", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "text", id: "title", key: "title_key", role: "title" },
          {
            type: "packageList",
            id: "packages",
            packageIds: ["pkg_monthly"],
            cellLayout: "row",
          },
          // no purchaseButton — a legitimate mid-authoring state that must
          // still be allowed to SAVE (only blocks a later publish).
        ],
      },
    });
    const result = assertSaveValid(config);
    expect(result.root.id).toBe("root");
  });

  it("does not block on FOREIGN_PACKAGE_ID: offeringPackageIds=[] cannot fail an empty offering set", () => {
    // The AI-FAB generates configs before an offering may even be selected —
    // FOREIGN_PACKAGE_ID is publish-tier, so a save-valid draft referencing
    // any package id must still pass here, regardless of an (empty) offering.
    const config = baseConfig();
    expect(() => assertSaveValid(config)).not.toThrow();
  });

  it("throws GeneratedConfigError listing DUPLICATE_NODE_ID for a duplicate-node-id config", () => {
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
    try {
      assertSaveValid(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      expect((err as GeneratedConfigError).issues).toContain("DUPLICATE_NODE_ID");
    }
  });

  it("throws GeneratedConfigError with schema issues for garbage input", () => {
    try {
      assertSaveValid({ nonsense: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      const generatedErr = err as GeneratedConfigError;
      expect(generatedErr.issues.length).toBeGreaterThan(0);
    }
  });

  it("throws GeneratedConfigError with INVALID_URL_SCHEME for a javascript: image url.light", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "image", id: "img", url: { light: "javascript:alert(1)" } },
        ],
      },
    });
    try {
      assertSaveValid(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      expect((err as GeneratedConfigError).issues).toContain("INVALID_URL_SCHEME");
    }
  });

  it("passes an image node with valid http(s) url.light/url.dark", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "image",
            id: "img",
            url: { light: "https://example.com/a.png", dark: "http://example.com/b.png" },
          },
        ],
      },
    });
    expect(() => assertSaveValid(config)).not.toThrow();
  });

  it("throws GeneratedConfigError with INVALID_URL_SCHEME for a javascript: button action.url", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "button",
            id: "btn",
            labelKey: "cta_key",
            style: "primary",
            action: { kind: "url", url: "javascript:alert(1)" },
          },
        ],
      },
    });
    try {
      assertSaveValid(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      expect((err as GeneratedConfigError).issues).toContain("INVALID_URL_SCHEME");
    }
  });

  it("does not check button actions of kind close/restore for a URL scheme", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "button", id: "btn1", labelKey: "cta_key", style: "primary", action: { kind: "close" } },
          { type: "button", id: "btn2", labelKey: "cta_key", style: "secondary", action: { kind: "restore" } },
        ],
      },
    });
    expect(() => assertSaveValid(config)).not.toThrow();
  });

  it("throws GeneratedConfigError for a subtree with an unknown node type", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        // @ts-expect-error deliberately invalid node type for the test
        children: [{ type: "bogusNodeType", id: "x" }],
      },
    });
    expect(() => assertSaveValid(config)).toThrow(GeneratedConfigError);
  });
});
