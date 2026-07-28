import { describe, expect, it } from "vitest";
import { applyTreeOp, paywallTreeOpSchema, TreeOpError, type PaywallTreeOp } from "./tree-op";
import type { BuilderConfig, PaywallNode } from "./schema";

function baseConfig(): BuilderConfig {
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
      ],
    },
  };
}

/** Deep clone via JSON round-trip, used only to snapshot a config for a
 *  later deep-equal comparison — never passed to applyTreeOp itself. */
function snapshot(config: BuilderConfig): BuilderConfig {
  return JSON.parse(JSON.stringify(config)) as BuilderConfig;
}

describe("applyTreeOp", () => {
  it("insert: adds a new node into a container's children at the given index", () => {
    const config = baseConfig();
    const subtree: PaywallNode = { type: "spacer", id: "sp1", size: 8 };
    const op: PaywallTreeOp = { kind: "insert", parentId: "root", index: 1, subtree };
    const next = applyTreeOp(config, op);
    expect(next.root.children.map((c) => c.id)).toEqual(["title", "sp1", "packages"]);
  });

  it("replace: swaps a node's whole subtree", () => {
    const config = baseConfig();
    const subtree: PaywallNode = { type: "text", id: "title", key: "new_key", role: "subtitle" };
    const op: PaywallTreeOp = { kind: "replace", nodeId: "title", subtree };
    const next = applyTreeOp(config, op);
    const replaced = next.root.children.find((c) => c.id === "title");
    expect(replaced).toEqual(subtree);
  });

  it("remove: deletes a node from its parent's children", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = { kind: "remove", nodeId: "title" };
    const next = applyTreeOp(config, op);
    expect(next.root.children.map((c) => c.id)).toEqual(["packages"]);
  });

  it("updateProps: shallow-merges a patch into the node", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "updateProps",
      nodeId: "title",
      patch: { role: "caption" },
    };
    const next = applyTreeOp(config, op);
    const updated = next.root.children.find((c) => c.id === "title");
    expect(updated).toMatchObject({ role: "caption", key: "title_key" });
  });

  it("setLocalizations: merges entries into config.localizations[locale], preserving existing keys", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "setLocalizations",
      locale: "en",
      entries: { new_key: "New Value" },
    };
    const next = applyTreeOp(config, op);
    expect(next.localizations.en).toEqual({
      title_key: "Go Pro",
      cta_key: "Continue",
      new_key: "New Value",
    });
  });

  it("setLocalizations: creates a new locale table when the locale is unknown", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "setLocalizations",
      locale: "tr",
      entries: { title_key: "Pro Ol" },
    };
    const next = applyTreeOp(config, op);
    expect(next.localizations.tr).toEqual({ title_key: "Pro Ol" });
    expect(next.localizations.en).toEqual(config.localizations.en);
  });

  it("throws TARGET_NOT_FOUND for insert with a bad parentId", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "nope",
      index: 0,
      subtree: { type: "spacer", id: "sp1" },
    };
    expect(() => applyTreeOp(config, op)).toThrow(TreeOpError);
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TreeOpError);
      expect((err as TreeOpError).code).toBe("TARGET_NOT_FOUND");
    }
  });

  it("throws TARGET_NOT_FOUND for replace with a bad nodeId", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "replace",
      nodeId: "nope",
      subtree: { type: "spacer", id: "sp1" },
    };
    expect(() => applyTreeOp(config, op)).toThrow(TreeOpError);
    try {
      applyTreeOp(config, op);
    } catch (err) {
      expect((err as TreeOpError).code).toBe("TARGET_NOT_FOUND");
    }
  });

  it("throws TARGET_NOT_FOUND for remove with a bad nodeId", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = { kind: "remove", nodeId: "nope" };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("TARGET_NOT_FOUND");
    }
  });

  it("throws NOT_A_CONTAINER when inserting under a text node", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "title",
      index: 0,
      subtree: { type: "spacer", id: "sp1" },
    };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("NOT_A_CONTAINER");
    }
  });

  it("throws INDEX_OUT_OF_RANGE when the insert index is beyond the children length", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 99,
      subtree: { type: "spacer", id: "sp1" },
    };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("INDEX_OUT_OF_RANGE");
    }
  });

  it("throws INDEX_OUT_OF_RANGE when the insert index is negative", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: -1,
      subtree: { type: "spacer", id: "sp1" },
    };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("INDEX_OUT_OF_RANGE");
    }
  });

  it("throws CANNOT_REMOVE_ROOT when removing the root node", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = { kind: "remove", nodeId: "root" };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("CANNOT_REMOVE_ROOT");
    }
  });

  it("throws CANNOT_REMOVE_ROOT when replacing the root node", () => {
    const config = baseConfig();
    const op: PaywallTreeOp = {
      kind: "replace",
      nodeId: "root",
      subtree: { type: "stack", id: "root2", axis: "v", children: [] },
    };
    try {
      applyTreeOp(config, op);
      expect.unreachable();
    } catch (err) {
      expect((err as TreeOpError).code).toBe("CANNOT_REMOVE_ROOT");
    }
  });

  it("is pure: the input config is deep-equal unchanged after the call", () => {
    const config = baseConfig();
    const before = snapshot(config);
    applyTreeOp(config, {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp1" },
    });
    expect(config).toEqual(before);
  });

  it("is pure across every op kind, including error paths", () => {
    const config = baseConfig();
    const before = snapshot(config);
    const ops: PaywallTreeOp[] = [
      { kind: "insert", parentId: "root", index: 0, subtree: { type: "spacer", id: "sp2" } },
      { kind: "replace", nodeId: "title", subtree: { type: "spacer", id: "sp3" } },
      { kind: "remove", nodeId: "packages" },
      { kind: "updateProps", nodeId: "title", patch: { role: "caption" } },
      { kind: "setLocalizations", locale: "en", entries: { x: "y" } },
    ];
    for (const op of ops) {
      applyTreeOp(config, op);
    }
    try {
      applyTreeOp(config, { kind: "remove", nodeId: "root" });
    } catch {
      // expected — CANNOT_REMOVE_ROOT, still must not mutate.
    }
    expect(config).toEqual(before);
  });
});

describe("paywallTreeOpSchema", () => {
  it("accepts a well-formed insert op", () => {
    const op = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp1", size: 8 },
    };
    expect(paywallTreeOpSchema.safeParse(op).success).toBe(true);
  });

  it("accepts a well-formed setLocalizations op", () => {
    const op = { kind: "setLocalizations", locale: "en", entries: { a: "b" } };
    expect(paywallTreeOpSchema.safeParse(op).success).toBe(true);
  });

  it("rejects an insert op whose subtree has an unknown node type", () => {
    const op = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "bogusNodeType", id: "sp1" },
    };
    expect(paywallTreeOpSchema.safeParse(op).success).toBe(false);
  });

  it("rejects a replace op whose subtree has an unknown node type", () => {
    const op = {
      kind: "replace",
      nodeId: "title",
      subtree: { type: "bogusNodeType", id: "sp1" },
    };
    expect(paywallTreeOpSchema.safeParse(op).success).toBe(false);
  });

  it("rejects an unknown op kind", () => {
    const op = { kind: "teleport", nodeId: "title" };
    expect(paywallTreeOpSchema.safeParse(op).success).toBe(false);
  });
});
