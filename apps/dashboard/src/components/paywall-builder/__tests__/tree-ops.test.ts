import { describe, expect, it } from "vitest";
import type { PaywallNode, StackNode, TextNode } from "@rovenue/shared/paywall";
import {
  findNode,
  findParent,
  insertNode,
  removeNode,
  moveNode,
  updateNode,
  newNode,
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

  it("uses whatever idGen returns as the node id", () => {
    let calls = 0;
    const node = newNode("text", () => `x${++calls}`);
    expect(node.id).toBe("x1");
  });
});
