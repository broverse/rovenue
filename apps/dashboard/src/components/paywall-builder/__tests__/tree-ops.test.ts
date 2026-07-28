import { describe, expect, it } from "vitest";
import {
  DIVIDER_DEFAULT_INSET,
  DIVIDER_DEFAULT_THICKNESS,
  ICON_DEFAULT_SIZE,
  type CarouselNode,
  type PackageListNode,
  type PaywallNode,
  type StackNode,
  type StickyFooterNode,
  type TextNode,
} from "@rovenue/shared/paywall";
import {
  findNode,
  findParent,
  insertNode,
  removeNode,
  moveNode,
  updateNode,
  newNode,
  COUNTDOWN_DEFAULT_DURATION_SECONDS,
} from "../tree-ops";

// Fixture tree:
// root (stack v)
//   t1 (text)
//   s2 (stack h)
//     t2a (text)
//     t2b (text)
//     fallback: t2fallback (text)
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

describe("findNode", () => {
  it("finds the root by id", () => {
    const root = fixture();
    expect(findNode(root, "root")).toBe(root);
  });

  it("finds a nested node", () => {
    const root = fixture();
    const found = findNode(root, "t2a");
    expect(found?.id).toBe("t2a");
  });

  it("finds a node inside a fallback subtree", () => {
    const root = fixture();
    const found = findNode(root, "t2fallback");
    expect(found?.id).toBe("t2fallback");
  });

  it("returns null for an unknown id", () => {
    const root = fixture();
    expect(findNode(root, "nope")).toBeNull();
  });
});

describe("findParent", () => {
  it("returns null for the root (no parent)", () => {
    const root = fixture();
    expect(findParent(root, "root")).toBeNull();
  });

  it("returns the parent + index for a top-level child", () => {
    const root = fixture();
    const result = findParent(root, "t1");
    expect(result?.parent.id).toBe("root");
    expect(result?.index).toBe(0);
  });

  it("returns the parent + index for a nested child", () => {
    const root = fixture();
    const result = findParent(root, "t2b");
    expect(result?.parent.id).toBe("s2");
    expect(result?.index).toBe(1);
  });

  it("returns null for a node only reachable via a fallback slot (not addressable by index)", () => {
    const root = fixture();
    expect(findParent(root, "t2fallback")).toBeNull();
  });

  it("returns null for an unknown id", () => {
    const root = fixture();
    expect(findParent(root, "nope")).toBeNull();
  });
});

describe("insertNode", () => {
  it("inserts at the end when index is omitted", () => {
    const root = fixture();
    const original = JSON.parse(JSON.stringify(root));
    const node: PaywallNode = { type: "spacer", id: "sp1", size: 8 };
    const next = insertNode(root, "root", node);
    expect(next.children.map((c) => c.id)).toEqual(["t1", "s2", "img3", "sp1"]);
    expect(root).toEqual(original);
  });

  it("inserts at a specific index", () => {
    const root = fixture();
    const node: PaywallNode = { type: "spacer", id: "sp1", size: 8 };
    const next = insertNode(root, "root", node, 1);
    expect(next.children.map((c) => c.id)).toEqual(["t1", "sp1", "s2", "img3"]);
  });

  it("inserts into a nested stack", () => {
    const root = fixture();
    const node: PaywallNode = { type: "spacer", id: "sp2", size: 4 };
    const next = insertNode(root, "s2", node, 0);
    const s2 = findNode(next, "s2") as StackNode;
    expect(s2.children.map((c) => c.id)).toEqual(["sp2", "t2a", "t2b"]);
  });

  it("is a no-op (same reference) when parentId is unknown", () => {
    const root = fixture();
    const node: PaywallNode = { type: "spacer", id: "sp1", size: 8 };
    const next = insertNode(root, "nope", node);
    expect(next).toBe(root);
  });

  it("is a no-op (same reference) when parentId resolves to a non-stack node", () => {
    const root = fixture();
    const node: PaywallNode = { type: "spacer", id: "sp1", size: 8 };
    const next = insertNode(root, "t1", node);
    expect(next).toBe(root);
  });

  it("does not mutate the input tree", () => {
    const root = fixture();
    const original = JSON.parse(JSON.stringify(root));
    insertNode(root, "s2", { type: "spacer", id: "sp3" }, 0);
    expect(root).toEqual(original);
  });

  it("preserves structural sharing for untouched branches", () => {
    const root = fixture();
    const img3Before = findNode(root, "img3");
    const next = insertNode(root, "root", { type: "spacer", id: "sp1" }, 0);
    expect(findNode(next, "img3")).toBe(img3Before);
  });
});

describe("removeNode", () => {
  it("removes a top-level child", () => {
    const root = fixture();
    const next = removeNode(root, "t1");
    expect(next.children.map((c) => c.id)).toEqual(["s2", "img3"]);
  });

  it("removes a nested child", () => {
    const root = fixture();
    const next = removeNode(root, "t2a");
    const s2 = findNode(next, "s2") as StackNode;
    expect(s2.children.map((c) => c.id)).toEqual(["t2b"]);
  });

  it("is a no-op on the root id (irremovable)", () => {
    const root = fixture();
    const next = removeNode(root, "root");
    expect(next).toBe(root);
  });

  it("is a no-op for an unknown id", () => {
    const root = fixture();
    const next = removeNode(root, "nope");
    expect(next).toBe(root);
  });

  it("is a no-op for a node only reachable via a fallback slot", () => {
    const root = fixture();
    const next = removeNode(root, "t2fallback");
    expect(next).toBe(root);
  });

  it("does not mutate the input tree", () => {
    const root = fixture();
    const original = JSON.parse(JSON.stringify(root));
    removeNode(root, "t2b");
    expect(root).toEqual(original);
  });

  it("preserves structural sharing for untouched branches", () => {
    const root = fixture();
    const img3Before = findNode(root, "img3");
    const next = removeNode(root, "t1");
    expect(findNode(next, "img3")).toBe(img3Before);
  });
});

describe("moveNode", () => {
  it("moves a node forward within its siblings", () => {
    const root = fixture();
    const next = moveNode(root, "t1", 1);
    expect(next.children.map((c) => c.id)).toEqual(["s2", "t1", "img3"]);
  });

  it("moves a node backward within its siblings", () => {
    const root = fixture();
    const next = moveNode(root, "img3", -1);
    expect(next.children.map((c) => c.id)).toEqual(["t1", "img3", "s2"]);
  });

  it("clamps at the start edge (no-op, same reference)", () => {
    const root = fixture();
    const next = moveNode(root, "t1", -1);
    expect(next).toBe(root);
  });

  it("clamps at the end edge (no-op, same reference)", () => {
    const root = fixture();
    const next = moveNode(root, "img3", 1);
    expect(next).toBe(root);
  });

  it("is a no-op on the root id", () => {
    const root = fixture();
    expect(moveNode(root, "root", 1)).toBe(root);
  });

  it("is a no-op for an unknown id", () => {
    const root = fixture();
    expect(moveNode(root, "nope", 1)).toBe(root);
  });

  it("moves within a nested stack", () => {
    const root = fixture();
    const next = moveNode(root, "t2b", -1);
    const s2 = findNode(next, "s2") as StackNode;
    expect(s2.children.map((c) => c.id)).toEqual(["t2b", "t2a"]);
  });

  it("does not mutate the input tree", () => {
    const root = fixture();
    const original = JSON.parse(JSON.stringify(root));
    moveNode(root, "t1", 1);
    expect(root).toEqual(original);
  });
});

describe("updateNode", () => {
  it("merges a patch into a nested node", () => {
    const root = fixture();
    const next = updateNode<TextNode>(root, "t1", { role: "title" });
    expect((findNode(next, "t1") as TextNode).role).toBe("title");
  });

  it("merges a patch into the root", () => {
    const root = fixture();
    const next = updateNode<StackNode>(root, "root", { spacing: 12 });
    expect(next.spacing).toBe(12);
  });

  it("does not mutate the input tree", () => {
    const root = fixture();
    const original = JSON.parse(JSON.stringify(root));
    updateNode<TextNode>(root, "t1", { role: "title" });
    expect(root).toEqual(original);
  });

  it("preserves structural sharing for untouched branches", () => {
    const root = fixture();
    const img3Before = findNode(root, "img3");
    const next = updateNode<TextNode>(root, "t1", { role: "title" });
    expect(findNode(next, "img3")).toBe(img3Before);
  });

  it("is a no-op (same reference) for an unknown id", () => {
    const root = fixture();
    const next = updateNode<TextNode>(root, "nope", { role: "title" });
    expect(next).toBe(root);
  });
});

describe("newNode", () => {
  const idGen = () => "gen1";

  it("creates a stack with empty children", () => {
    const node = newNode("stack", idGen);
    expect(node).toMatchObject({ type: "stack", id: "gen1", axis: "v", children: [] });
  });

  it("creates a text node with a fresh key derived from the id", () => {
    const node = newNode("text", idGen);
    expect(node.type).toBe("text");
    expect((node as TextNode).key).toBe("text_gen1");
  });

  it("creates a button node with a fresh labelKey derived from the id", () => {
    const node = newNode("button", idGen);
    expect(node.type).toBe("button");
    if (node.type === "button") {
      expect(node.labelKey).toBe("button_gen1");
      expect(node.action).toEqual({ kind: "close" });
    }
  });

  it("creates a purchaseButton node with a fresh labelKey derived from the id", () => {
    const node = newNode("purchaseButton", idGen);
    expect(node.type).toBe("purchaseButton");
    if (node.type === "purchaseButton") {
      expect(node.labelKey).toBe("purchaseButton_gen1");
    }
  });

  it("creates an image node with sensible defaults", () => {
    const node = newNode("image", idGen);
    expect(node.type).toBe("image");
    if (node.type === "image") {
      expect(node.url).toEqual({ light: "" });
    }
  });

  it("creates a packageList node with an empty packageIds (= all)", () => {
    const node = newNode("packageList", idGen);
    expect(node.type).toBe("packageList");
    if (node.type === "packageList") {
      expect(node.packageIds).toEqual([]);
    }
  });

  it("creates a spacer node", () => {
    const node = newNode("spacer", idGen);
    expect(node.type).toBe("spacer");
  });

  it("creates a divider with the default thickness and inset", () => {
    const node = newNode("divider", idGen);
    expect(node).toEqual({
      type: "divider",
      id: "gen1",
      thickness: DIVIDER_DEFAULT_THICKNESS,
      inset: DIVIDER_DEFAULT_INSET,
    });
  });

  it("creates an icon defaulting to the check glyph", () => {
    const node = newNode("icon", idGen);
    expect(node).toEqual({ type: "icon", id: "gen1", name: "check", size: ICON_DEFAULT_SIZE });
  });

  it("uses whatever idGen returns as the node id", () => {
    let calls = 0;
    const node = newNode("text", () => `x${++calls}`);
    expect(node.id).toBe("x1");
  });

  it("creates a featureList with one starter row", () => {
    const node = newNode("featureList", idGen);
    expect(node).toEqual({
      type: "featureList",
      id: node.id,
      rows: [{ labelKey: `featureList_${node.id}_1` }],
    });
  });

  it("creates a timeline with one starter row", () => {
    const node = newNode("timeline", idGen);
    expect(node).toEqual({
      type: "timeline",
      id: node.id,
      rows: [{ labelKey: `timeline_${node.id}_1` }],
    });
  });

  it("creates socialProof with a label key", () => {
    const node = newNode("socialProof", idGen);
    expect(node).toEqual({ type: "socialProof", id: node.id, labelKey: `socialProof_${node.id}` });
  });

  it("creates a stickyFooter with no children", () => {
    const node = newNode("stickyFooter", idGen);
    expect(node).toEqual({ type: "stickyFooter", id: node.id, children: [] });
  });

  it("creates a countdown defaulting to a duration", () => {
    // An absolute date would start invalid and immediately raise
    // COUNTDOWN_NO_DEADLINE; a duration needs no author input to be valid.
    const node = newNode("countdown", idGen);
    expect(node).toEqual({
      type: "countdown",
      id: node.id,
      durationSeconds: COUNTDOWN_DEFAULT_DURATION_SECONDS,
    });
  });

  it("creates a carousel with no children", () => {
    const node = newNode("carousel", idGen);
    expect(node).toEqual({ type: "carousel", id: node.id, children: [] });
  });
});

// =============================================================
// Wave D1 — `carousel` is a second container type alongside `stack`.
// Without carousel wired into `isContainerNode` (search/searchParent/
// transformNode + the insert/remove/move closures), an author could
// create a carousel but never put a page inside it: insertNode would
// silently no-op the same way it does for a non-container node like
// `text`.
// =============================================================
describe("carousel as a container", () => {
  it("accepts children into a carousel", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [{ type: "carousel", id: "car1", children: [] }],
    };
    const node: PaywallNode = { type: "text", id: "t1", key: "k1", role: "body" };
    const next = insertNode(root, "car1", node);
    const carousel = findNode(next, "car1") as CarouselNode;
    expect(carousel.children).toHaveLength(1);
    expect(carousel.children[0]?.id).toBe("t1");
  });

  it("removes a child from a carousel", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "carousel",
          id: "car1",
          children: [{ type: "text", id: "t1", key: "k1", role: "body" }],
        },
      ],
    };
    const next = removeNode(root, "t1");
    const carousel = findNode(next, "car1") as CarouselNode;
    expect(carousel.children).toHaveLength(0);
  });
});

// =============================================================
// cellTemplate traversal (Phase D2) — a packageList's `cellTemplate`
// is a single node slot (like `fallback`), so the cellTemplate ROOT
// itself is not addressable by insert/remove/move (no parent+index),
// but everything INSIDE it (a normal stack subtree) is addressable
// exactly like any other part of the tree.
// =============================================================

// Fixture tree:
// root (stack v)
//   pl1 (packageList)
//     cellTemplate: cell_root (stack v)
//       cell_name (text)
//       cell_price (text)
function cellTemplateFixture(): StackNode {
  return {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      {
        type: "packageList",
        id: "pl1",
        packageIds: [],
        cellLayout: "column",
        cellTemplate: {
          type: "stack",
          id: "cell_root",
          axis: "v",
          children: [
            { type: "text", id: "cell_name", key: "k_name", role: "body" },
            { type: "text", id: "cell_price", key: "k_price", role: "caption" },
          ],
        },
      },
    ],
  };
}

describe("cellTemplate traversal", () => {
  describe("findNode", () => {
    it("finds the cellTemplate root", () => {
      const root = cellTemplateFixture();
      expect(findNode(root, "cell_root")?.id).toBe("cell_root");
    });

    it("finds a node nested inside the cellTemplate subtree", () => {
      const root = cellTemplateFixture();
      expect(findNode(root, "cell_price")?.id).toBe("cell_price");
    });
  });

  describe("findParent", () => {
    it("returns null for the cellTemplate root (not addressable by index, like a fallback slot)", () => {
      const root = cellTemplateFixture();
      expect(findParent(root, "cell_root")).toBeNull();
    });

    it("returns parent + index for a node inside the cellTemplate subtree", () => {
      const root = cellTemplateFixture();
      const result = findParent(root, "cell_price");
      expect(result?.parent.id).toBe("cell_root");
      expect(result?.index).toBe(1);
    });
  });

  describe("insertNode", () => {
    it("inserts into the cellTemplate subtree's own stack children", () => {
      const root = cellTemplateFixture();
      const node: PaywallNode = { type: "spacer", id: "cell_sp", size: 4 };
      const next = insertNode(root, "cell_root", node, 1);
      const cellRoot = findNode(next, "cell_root") as StackNode;
      expect(cellRoot.children.map((c) => c.id)).toEqual(["cell_name", "cell_sp", "cell_price"]);
    });

    it("does not mutate the input tree", () => {
      const root = cellTemplateFixture();
      const original = JSON.parse(JSON.stringify(root));
      insertNode(root, "cell_root", { type: "spacer", id: "cell_sp" }, 0);
      expect(root).toEqual(original);
    });
  });

  describe("removeNode", () => {
    it("removes a node from inside the cellTemplate subtree", () => {
      const root = cellTemplateFixture();
      const next = removeNode(root, "cell_name");
      const cellRoot = findNode(next, "cell_root") as StackNode;
      expect(cellRoot.children.map((c) => c.id)).toEqual(["cell_price"]);
    });

    it("is a no-op for the cellTemplate root itself (not addressable)", () => {
      const root = cellTemplateFixture();
      const next = removeNode(root, "cell_root");
      expect(next).toBe(root);
    });
  });

  describe("moveNode", () => {
    it("moves a node within the cellTemplate subtree's siblings", () => {
      const root = cellTemplateFixture();
      const next = moveNode(root, "cell_price", -1);
      const cellRoot = findNode(next, "cell_root") as StackNode;
      expect(cellRoot.children.map((c) => c.id)).toEqual(["cell_price", "cell_name"]);
    });
  });

  describe("updateNode", () => {
    it("merges a patch into a node inside the cellTemplate subtree", () => {
      const root = cellTemplateFixture();
      const next = updateNode<TextNode>(root, "cell_price", { role: "title" });
      expect((findNode(next, "cell_price") as TextNode).role).toBe("title");
    });

    it("merges a patch into the cellTemplate root itself (editable like any other node)", () => {
      const root = cellTemplateFixture();
      const next = updateNode<StackNode>(root, "cell_root", { spacing: 6 });
      expect((findNode(next, "cell_root") as StackNode).spacing).toBe(6);
    });

    it("can replace a packageList's whole cellTemplate", () => {
      const root = cellTemplateFixture();
      const next = updateNode<PackageListNode>(root, "pl1", { cellTemplate: undefined });
      expect((findNode(next, "pl1") as PackageListNode).cellTemplate).toBeUndefined();
    });

    it("preserves structural sharing for a sibling packageList untouched by a cellTemplate edit", () => {
      const root: StackNode = {
        ...cellTemplateFixture(),
        children: [
          ...cellTemplateFixture().children,
          { type: "spacer", id: "sp_sibling", size: 8 },
        ],
      };
      const spBefore = findNode(root, "sp_sibling");
      const next = updateNode<TextNode>(root, "cell_name", { role: "title" });
      expect(findNode(next, "sp_sibling")).toBe(spBefore);
    });
  });
});

// =============================================================
// Wave C shipped `stickyFooter` as a container the BUILDER could not
// populate: `newNode` gave it an empty `children` array, but it was
// absent from `isContainerNode`, so `insertNode` silently no-opped
// exactly as it does for a leaf like `text`. An author could create a
// sticky footer and never place the purchase button that is its whole
// purpose. All three renderers had always drawn `stickyFooter.children`
// correctly, so the gap was authoring-only — which is why the wave's
// review, comparing the three RENDERERS, never saw it. Found while
// wiring `carousel` in Wave D1.
// =============================================================
describe("stickyFooter as a container", () => {
  it("accepts children into a stickyFooter", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [{ type: "stickyFooter", id: "foot1", children: [] }],
    };
    const node: PaywallNode = { type: "text", id: "t1", key: "k1", role: "body" };
    const next = insertNode(root, "foot1", node);
    const footer = findNode(next, "foot1") as StickyFooterNode;
    expect(footer.children).toHaveLength(1);
    expect(footer.children[0]?.id).toBe("t1");
  });

  it("finds a node nested inside a stickyFooter", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "stickyFooter",
          id: "foot1",
          children: [{ type: "text", id: "deep", key: "k1", role: "body" }],
        },
      ],
    };
    expect(findNode(root, "deep")?.id).toBe("deep");
    expect(findParent(root, "deep")?.parent.id).toBe("foot1");
  });

  it("removes a child from a stickyFooter", () => {
    const root: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        {
          type: "stickyFooter",
          id: "foot1",
          children: [{ type: "text", id: "t1", key: "k1", role: "body" }],
        },
      ],
    };
    const next = removeNode(root, "t1");
    expect((findNode(next, "foot1") as StickyFooterNode).children).toHaveLength(0);
  });
});
