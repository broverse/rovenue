import { describe, expect, it } from "vitest";
import { assertSaveValid, GeneratedConfigError } from "./validate-config";
import {
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  type BuilderConfig,
  type PaywallNode,
  type StackNode,
} from "@rovenue/shared/paywall";

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

// =============================================================
// Size bounds (S1 review, finding S2)
//
// `prepareBuilderConfigPatch` in routes/dashboard/paywalls.ts runs an
// iterative `measureNodeTree` pre-scan before its recursive Zod parse for
// two reasons: bound the tree, and keep a deeply-nested tree from blowing
// the call stack inside `safeParse` (a RangeError `safeParse` does NOT
// contain, which would turn a 400 into a 500). Since the copilot's
// `action_paywall_editTree` handler persists directly, `assertSaveValid`
// is the ONLY gate on that path — there is no REST route downstream to
// re-run the bound. Without it an agent can persist a draft the builder's
// own autosave can never save again (every subsequent PATCH 400s), which
// is exactly the failure the save-gate phase existed to remove.
// =============================================================

/** A `stack` nesting `depth` levels deep — one child per level. */
function deepStack(depth: number): PaywallNode {
  let node: PaywallNode = { type: "stack", id: "leaf", axis: "v", children: [] };
  for (let i = depth - 1; i > 0; i -= 1) {
    node = { type: "stack", id: `s${i}`, axis: "v", children: [node] };
  }
  return node;
}

/** A flat `stack` holding `count - 1` spacer children (the stack itself
 *  counts as a node), so the whole tree measures exactly `count`. */
function wideStack(count: number): PaywallNode {
  return {
    type: "stack",
    id: "root",
    axis: "v",
    children: Array.from({ length: count - 1 }, (_, i) => ({
      type: "spacer" as const,
      id: `sp${i}`,
      size: 8,
    })),
  };
}

describe("assertSaveValid — tree size bounds", () => {
  it("rejects a tree deeper than MAX_BUILDER_DEPTH", () => {
    const root = deepStack(MAX_BUILDER_DEPTH + 2) as StackNode;
    const config = baseConfig({ root });
    try {
      assertSaveValid(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      expect((err as GeneratedConfigError).issues.join(" ")).toContain("CONFIG_TOO_LARGE");
    }
  });

  it("rejects a tree with more than MAX_BUILDER_NODES nodes", () => {
    const config = baseConfig({ root: wideStack(MAX_BUILDER_NODES + 2) as StackNode });
    try {
      assertSaveValid(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedConfigError);
      expect((err as GeneratedConfigError).issues.join(" ")).toContain("CONFIG_TOO_LARGE");
    }
  });

  it("accepts a tree exactly at the node cap", () => {
    // The bound is the same `>` comparison the REST route uses, so a tree
    // AT the cap must still save — otherwise the two writers disagree
    // about what is persistable, which is the whole point of sharing it.
    expect(() => assertSaveValid(baseConfig({ root: wideStack(MAX_BUILDER_NODES) as StackNode }))).not.toThrow();
  });
});
