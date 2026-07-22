import { describe, expect, it } from "vitest";
import type { StackNode } from "@rovenue/shared/paywall";
import { flattenTree } from "../layer-tree-flatten";

// Fixture tree:
// root (stack v)
//   t1 (text)
//   s2 (stack h)
//     t2a (text)
//     t2b (text)
//     fallback: t2fallback (text)   -- must be EXCLUDED from flattening
//   img3 (image)
function fixture(): StackNode {
  return {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "k1", role: "body" },
      {
        type: "stack",
        id: "s2",
        axis: "h",
        children: [
          { type: "text", id: "t2a", key: "k2a", role: "body" },
          { type: "text", id: "t2b", key: "k2b", role: "body" },
        ],
        fallback: { type: "text", id: "t2fallback", key: "kf", role: "body" },
      },
      { type: "image", id: "img3", url: { light: "https://x/y.png" } },
    ],
  };
}

describe("flattenTree", () => {
  it("walks the tree depth-first, in document order", () => {
    const rows = flattenTree(fixture());
    expect(rows.map((r) => r.node.id)).toEqual(["root", "t1", "s2", "t2a", "t2b", "img3"]);
  });

  it("computes depth relative to the root", () => {
    const rows = flattenTree(fixture());
    const depthById = Object.fromEntries(rows.map((r) => [r.node.id, r.depth]));
    expect(depthById).toEqual({ root: 0, t1: 1, s2: 1, t2a: 2, t2b: 2, img3: 1 });
  });

  it("records parentId, index and siblingCount", () => {
    const rows = flattenTree(fixture());
    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));

    expect(byId.root).toMatchObject({ parentId: null, index: 0, siblingCount: 1 });
    expect(byId.t1).toMatchObject({ parentId: "root", index: 0, siblingCount: 3 });
    expect(byId.s2).toMatchObject({ parentId: "root", index: 1, siblingCount: 3 });
    expect(byId.img3).toMatchObject({ parentId: "root", index: 2, siblingCount: 3 });
    expect(byId.t2a).toMatchObject({ parentId: "s2", index: 0, siblingCount: 2 });
    expect(byId.t2b).toMatchObject({ parentId: "s2", index: 1, siblingCount: 2 });
  });

  it("excludes fallback subtrees — they aren't addressable by move/delete", () => {
    const rows = flattenTree(fixture());
    expect(rows.some((r) => r.node.id === "t2fallback")).toBe(false);
  });

  it("handles an empty stack", () => {
    const root: StackNode = { type: "stack", id: "root", axis: "v", children: [] };
    const rows = flattenTree(root);
    expect(rows).toEqual([{ node: root, depth: 0, parentId: null, index: 0, siblingCount: 1 }]);
  });
});
