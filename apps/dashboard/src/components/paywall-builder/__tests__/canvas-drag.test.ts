import { describe, expect, it } from "vitest";
import type { PaywallNode } from "@rovenue/shared/paywall";
import {
  CANVAS_DROP_EDGE_BAND_FRACTION,
  computeCanvasDropZone,
  containerAxis,
  normalizeSplitAxis,
  resolveCanvasDropTarget,
  type CanvasDragCandidate,
  type CanvasNodeInfo,
} from "../canvas-drag";

// =============================================================
// Part 2 of paywall-builder drag-and-drop (dragging directly inside the
// device mockup). These are the two PURE helpers `canvas.tsx` wires up to
// real DOM events (pointerdown/pointermove/pointerup + `document.
// elementsFromPoint`) — covered here without any DOM at all, mirroring
// tree-ops.test.ts's idiom (plain fixture nodes, no rendering).
//
// `computeCanvasDropZone` decides a zone from a pointer position + a
// rect + the axis of the TARGET'S PARENT (not the target's own axis —
// see canvas-drag.ts's module doc comment for why). `resolveCanvasDropTarget`
// walks an ordered candidate list (as `document.elementsFromPoint` would
// hand them, deepest-first) and returns the first LEGAL one, falling
// through illegal candidates exactly like the Layers panel's `canMoveTo`
// gate does for its own drag-and-drop.
// =============================================================

const RECT_100 = { left: 0, top: 0, width: 100, height: 100 };

describe("normalizeSplitAxis", () => {
  it("passes vertical/horizontal through unchanged", () => {
    expect(normalizeSplitAxis("vertical")).toBe("vertical");
    expect(normalizeSplitAxis("horizontal")).toBe("horizontal");
  });

  it("falls back a layered (z-stack) axis to vertical", () => {
    expect(normalizeSplitAxis("layered")).toBe("vertical");
  });
});

describe("containerAxis", () => {
  it("reads a stack's own axis field, v/h", () => {
    const v: PaywallNode = { type: "stack", id: "s1", axis: "v", children: [] };
    const h: PaywallNode = { type: "stack", id: "s2", axis: "h", children: [] };
    expect(containerAxis(v)).toBe("vertical");
    expect(containerAxis(h)).toBe("horizontal");
  });

  it("calls a stack's z-axis 'layered'", () => {
    const z: PaywallNode = { type: "stack", id: "s3", axis: "z", children: [] };
    expect(containerAxis(z)).toBe("layered");
  });

  it("treats a carousel's page track as horizontal", () => {
    const carousel: PaywallNode = { type: "carousel", id: "c1", children: [] };
    expect(containerAxis(carousel)).toBe("horizontal");
  });

  it("treats a stickyFooter's children as vertical", () => {
    const footer: PaywallNode = { type: "stickyFooter", id: "sf1", children: [] };
    expect(containerAxis(footer)).toBe("vertical");
  });
});

describe("computeCanvasDropZone", () => {
  describe("vertical parent axis (Y split)", () => {
    it("a leaf splits 50/50, no into band", () => {
      expect(computeCanvasDropZone({ x: 50, y: 10 }, RECT_100, "vertical", false)).toBe("before");
      expect(computeCanvasDropZone({ x: 50, y: 90 }, RECT_100, "vertical", false)).toBe("after");
      expect(computeCanvasDropZone({ x: 50, y: 49 }, RECT_100, "vertical", false)).toBe("before");
      expect(computeCanvasDropZone({ x: 50, y: 51 }, RECT_100, "vertical", false)).toBe("after");
    });

    it("a container reserves edge bands for before/after, middle is into", () => {
      const edge = CANVAS_DROP_EDGE_BAND_FRACTION * 100;
      expect(computeCanvasDropZone({ x: 50, y: edge - 5 }, RECT_100, "vertical", true)).toBe("before");
      expect(computeCanvasDropZone({ x: 50, y: 100 - edge + 5 }, RECT_100, "vertical", true)).toBe("after");
      expect(computeCanvasDropZone({ x: 50, y: 50 }, RECT_100, "vertical", true)).toBe("into");
    });
  });

  describe("horizontal parent axis (X split)", () => {
    it("a leaf splits 50/50 on X, not Y", () => {
      // y is deep in the "after" half but x says "before" — horizontal
      // axis must win, proving the split really uses X here.
      expect(computeCanvasDropZone({ x: 10, y: 90 }, RECT_100, "horizontal", false)).toBe("before");
      expect(computeCanvasDropZone({ x: 90, y: 10 }, RECT_100, "horizontal", false)).toBe("after");
    });

    it("a container reserves edge bands on X, middle is into", () => {
      const edge = CANVAS_DROP_EDGE_BAND_FRACTION * 100;
      expect(computeCanvasDropZone({ x: edge - 5, y: 50 }, RECT_100, "horizontal", true)).toBe("before");
      expect(computeCanvasDropZone({ x: 100 - edge + 5, y: 50 }, RECT_100, "horizontal", true)).toBe("after");
      expect(computeCanvasDropZone({ x: 50, y: 50 }, RECT_100, "horizontal", true)).toBe("into");
    });
  });

  describe("layered parent axis (z-stack — no spatial cue, falls back to Y)", () => {
    it("splits on Y exactly like a vertical parent", () => {
      expect(computeCanvasDropZone({ x: 90, y: 10 }, RECT_100, "layered", false)).toBe("before");
      expect(computeCanvasDropZone({ x: 10, y: 90 }, RECT_100, "layered", false)).toBe("after");
    });
  });
});

describe("resolveCanvasDropTarget", () => {
  /** Builds a lookup + candidate list from a tiny fixed table, so each
   * test only has to describe the shape of the tree it cares about. */
  function makeLookup(table: Record<string, CanvasNodeInfo>) {
    return (id: string) => table[id] ?? null;
  }

  const legalEverywhere = () => true;
  const illegalEverywhere = () => false;

  it("resolves the root candidate to 'into' it, always", () => {
    const root: PaywallNode = { type: "stack", id: "root", axis: "v", children: [] };
    const lookup = makeLookup({ root: { node: root, parentId: null, index: 0 } });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "root", rect: RECT_100 }];

    const result = resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, legalEverywhere);

    expect(result).toEqual({ targetNodeId: "root", zone: "into", parentId: "root", index: 0, splitAxis: "vertical" });
  });

  it("skips the root candidate when the move is illegal, with no fallthrough target", () => {
    const root: PaywallNode = { type: "stack", id: "root", axis: "v", children: [] };
    const lookup = makeLookup({ root: { node: root, parentId: null, index: 0 } });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "root", rect: RECT_100 }];

    expect(resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, illegalEverywhere)).toBeNull();
  });

  it("resolves a leaf candidate to before/after against its parent's axis", () => {
    const parent: PaywallNode = { type: "stack", id: "parent", axis: "h", children: [] };
    const leaf: PaywallNode = { type: "text", id: "leaf", key: "k", role: "body" };
    const lookup = makeLookup({
      parent: { node: parent, parentId: null, index: 0 },
      leaf: { node: leaf, parentId: "parent", index: 2 },
    });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "leaf", rect: RECT_100 }];

    // x=10 -> "before" on a horizontal-split leaf
    const before = resolveCanvasDropTarget(candidates, { x: 10, y: 50 }, "dragged", lookup, legalEverywhere);
    expect(before).toEqual({ targetNodeId: "leaf", zone: "before", parentId: "parent", index: 2, splitAxis: "horizontal" });

    // x=90 -> "after"; index shifts to index+1 (pre-removal array position —
    // moveNodeTo itself owns the same-parent forward-shift, same seam as
    // the Layers panel's `dropTargetFor`).
    const after = resolveCanvasDropTarget(candidates, { x: 90, y: 50 }, "dragged", lookup, legalEverywhere);
    expect(after).toEqual({ targetNodeId: "leaf", zone: "after", parentId: "parent", index: 3, splitAxis: "horizontal" });
  });

  it("resolves a container candidate's middle band to 'into' it, appended", () => {
    const parent: PaywallNode = { type: "stack", id: "parent", axis: "v", children: [] };
    const inner: PaywallNode = {
      type: "stack",
      id: "inner",
      axis: "v",
      children: [{ type: "spacer", id: "s1", size: 8 }, { type: "spacer", id: "s2", size: 8 }],
    };
    const lookup = makeLookup({
      parent: { node: parent, parentId: null, index: 0 },
      inner: { node: inner, parentId: "parent", index: 0 },
    });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "inner", rect: RECT_100 }];

    const result = resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, legalEverywhere);

    expect(result).toEqual({ targetNodeId: "inner", zone: "into", parentId: "inner", index: 2, splitAxis: "vertical" });
  });

  it("falls through an illegal candidate to the next legal one under the pointer", () => {
    // Realistic shape: dragging a container over one of its OWN
    // descendants — every candidate inside that subtree (here, `leaf`,
    // parented by `illegalContainer`) is illegal (`canMoveTo`'s
    // self/descendant rule), but `root` — always further down
    // `elementsFromPoint`'s deepest-first stack, and always a legal
    // "into" fallback — is not.
    const illegalContainer: PaywallNode = { type: "stack", id: "illegalContainer", axis: "v", children: [] };
    const leaf: PaywallNode = { type: "text", id: "leaf", key: "k", role: "body" };
    const root: PaywallNode = { type: "stack", id: "root", axis: "v", children: [] };
    const lookup = makeLookup({
      illegalContainer: { node: illegalContainer, parentId: "root", index: 0 },
      leaf: { node: leaf, parentId: "illegalContainer", index: 0 },
      root: { node: root, parentId: null, index: 0 },
    });
    const candidates: CanvasDragCandidate[] = [
      { nodeId: "leaf", rect: RECT_100 },
      { nodeId: "root", rect: RECT_100 },
    ];
    const canDropOn = (parentId: string) => parentId === "root";

    const result = resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, canDropOn);

    expect(result).toEqual({ targetNodeId: "root", zone: "into", parentId: "root", index: 0, splitAxis: "vertical" });
  });

  it("skips the dragged node's own candidate entirely (never a target for itself)", () => {
    const draggedNode: PaywallNode = { type: "stack", id: "dragged", axis: "v", children: [] };
    const lookup = makeLookup({ dragged: { node: draggedNode, parentId: "root", index: 0 } });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "dragged", rect: RECT_100 }];

    expect(resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, legalEverywhere)).toBeNull();
  });

  it("returns null when every candidate is illegal or unresolvable", () => {
    const lookup = makeLookup({});
    const candidates: CanvasDragCandidate[] = [{ nodeId: "ghost", rect: RECT_100 }];

    expect(resolveCanvasDropTarget(candidates, { x: 50, y: 50 }, "dragged", lookup, legalEverywhere)).toBeNull();
  });

  it("a carousel candidate's before/after uses ITS OWN horizontal track axis when it's the parent", () => {
    // parent = carousel (horizontal page track); "page" is one page, a leaf.
    const carousel: PaywallNode = { type: "carousel", id: "carousel", children: [] };
    const page: PaywallNode = { type: "image", id: "page", url: { light: "https://x/y.png" } };
    const lookup = makeLookup({
      carousel: { node: carousel, parentId: null, index: 0 },
      page: { node: page, parentId: "carousel", index: 0 },
    });
    const candidates: CanvasDragCandidate[] = [{ nodeId: "page", rect: RECT_100 }];

    const result = resolveCanvasDropTarget(candidates, { x: 10, y: 90 }, "dragged", lookup, legalEverywhere);

    // x=10 -> "before" on the horizontal split, even though y=90 would say
    // "after" on a vertical one — proves the carousel's track axis (not a
    // vertical default) drove the split.
    expect(result).toEqual({ targetNodeId: "page", zone: "before", parentId: "carousel", index: 0, splitAxis: "horizontal" });
  });
});
