import type { PaywallNode } from "@rovenue/shared/paywall";
import { isContainerNode } from "./tree-ops";
import { DRAG_EDGE_BAND_FRACTION } from "./layer-tree";
import type { Rect } from "./canvas-helpers";

// =============================================================
// Pure geometry + target-resolution helpers for Part 2 of paywall-builder
// drag-and-drop: dragging elements directly INSIDE the device mockup
// (`canvas.tsx`). Part 1 (`layer-tree.tsx`) drags rows in a flat vertical
// list, so a hovered row's drop bands always split on Y. The canvas has
// no such list — a node's on-screen neighbours sit along whichever axis
// its PARENT actually lays them out on (a horizontal stack's children
// sit left-to-right, so "before"/"after" there has to split on X, not Y)
// — so every function here takes the axis explicitly rather than
// hardcoding one, and `canvas.tsx` supplies it from the config tree
// (via `findParent` + `containerAxis`), never from the DOM.
//
// Everything below is DOM-agnostic on purpose: `canvas.tsx` does the
// `document.elementsFromPoint` hit-testing and `getBoundingClientRect`
// calls, then hands plain data in so this file stays unit-testable
// without jsdom.
// =============================================================

/** Pointer must move at least this many px past its pointerdown origin
 * before a drag visually starts — below this, pointerup still resolves to
 * a plain click (see `canvas.tsx`'s `handleClick`), so an author clicking
 * to select a node never accidentally arms a drag on a shaky click. */
export const CANVAS_DRAG_THRESHOLD_PX = 5;

/** Fraction of a CONTAINER target's rect (along the active split axis)
 * reserved for its "before"/"after" edge bands; the remainder is "into".
 * Shared with the Layers panel's own DnD (`layer-tree.tsx`) rather than
 * re-declared, so the two surfaces can never drift to different feels. */
export const CANVAS_DROP_EDGE_BAND_FRACTION = DRAG_EDGE_BAND_FRACTION;

/** Thickness of the canvas's between-elements insertion line, in px. A
 * separate constant from the Layers panel's `INSERTION_LINE_THICKNESS_PX`
 * on purpose — the canvas overlay sits over a scaled device mockup, a
 * different visual scale from a 100px-tall list row, so a slightly
 * thicker line reads better there. */
export const CANVAS_INSERTION_LINE_THICKNESS_PX = 3;

export type Point = { x: number; y: number };

export type CanvasDropZone = "before" | "after" | "into";

/** How a container lays out its children — the axis "before"/"after"
 * splits along when the container is the DROP TARGET's parent. */
export type ContainerAxis = "vertical" | "horizontal" | "layered";

/** The two real split directions "before"/"after" can ever render as —
 * `ContainerAxis` minus the "layered" case, which has no spatial cue to
 * split on (see `normalizeSplitAxis`). */
export type SplitAxis = "vertical" | "horizontal";

/**
 * Maps a container node to the axis its children are laid out along,
 * mirroring the renderer's actual CSS (`packages/paywall-renderer/src/
 * nodes.tsx`): a `stack` respects its own `axis` field, with "z" (layered,
 * children stacked on top of one another) called out separately since it
 * has no left-right/top-bottom arrangement at all; a `carousel`'s page
 * track is always `flexDirection: row` (pages sit side by side); a
 * `stickyFooter`'s children are always `flexDirection: column`.
 */
export function containerAxis(node: PaywallNode): ContainerAxis {
  if (node.type === "stack") {
    if (node.axis === "h") return "horizontal";
    if (node.axis === "z") return "layered";
    return "vertical";
  }
  if (node.type === "carousel") return "horizontal";
  return "vertical"; // stickyFooter — the only other container type
}

/**
 * `ContainerAxis` collapsed to a real split direction. A "layered" (z-axis)
 * stack's children have no spatial left-right/top-bottom relationship to
 * split a pointer position on — they're drawn on top of one another — so
 * this falls back to a plain vertical split. That's an arbitrary choice,
 * not a derived one, but a documented default beats leaving the case
 * unhandled.
 */
export function normalizeSplitAxis(axis: ContainerAxis): SplitAxis {
  return axis === "layered" ? "vertical" : axis;
}

/**
 * Which drop zone `pointer` falls in over `targetRect`, splitting along
 * `parentAxis` (the LAYOUT AXIS OF THE TARGET'S PARENT — see the module
 * doc comment for why it's the parent's axis, not the target's own).
 * Mirrors `layer-tree.tsx`'s `computeDropZone`: a non-container target has
 * no "into" band at all (a straight 50/50 before/after split); a container
 * reserves its two `CANVAS_DROP_EDGE_BAND_FRACTION` edge bands for
 * before/after and treats the remaining middle as "into".
 */
export function computeCanvasDropZone(
  pointer: Point,
  targetRect: Rect,
  parentAxis: ContainerAxis,
  isContainer: boolean,
): CanvasDropZone {
  const axis = normalizeSplitAxis(parentAxis);
  const ratio =
    axis === "horizontal"
      ? (pointer.x - targetRect.left) / targetRect.width
      : (pointer.y - targetRect.top) / targetRect.height;

  if (!isContainer) return ratio < 0.5 ? "before" : "after";
  if (ratio < CANVAS_DROP_EDGE_BAND_FRACTION) return "before";
  if (ratio > 1 - CANVAS_DROP_EDGE_BAND_FRACTION) return "after";
  return "into";
}

/** One candidate element under the pointer, deepest-first (the order
 * `document.elementsFromPoint` already returns). */
export interface CanvasDragCandidate {
  nodeId: string;
  rect: Rect;
}

/** What a candidate's id resolves to in the config tree — the same shape
 * `findNode`/`findParent` (tree-ops.ts) already answer, bundled together
 * so `resolveCanvasDropTarget` can stay DOM- and VM-agnostic. */
export interface CanvasNodeInfo {
  node: PaywallNode;
  /** `null` for the root or a `cellTemplate` root — tree-ops' own
   * addressability rule (see tree-ops.ts's module doc comment). */
  parentId: string | null;
  /** Meaningless when `parentId` is null. */
  index: number;
}

export interface CanvasDropResolution {
  /** The candidate node the drop indicator anchors to (for positioning). */
  targetNodeId: string;
  zone: CanvasDropZone;
  /** `moveNodeTo`'s own args. */
  parentId: string;
  index: number;
  /** The axis the before/after split actually used (already normalized —
   * see `normalizeSplitAxis`), so the caller can draw the insertion line
   * on the right edge without recomputing it. Present for "into" too
   * (the entered container's own axis), even though the ring overlay
   * doesn't need it, for a uniform shape. */
  splitAxis: SplitAxis;
}

/**
 * Walks `candidates` (deepest DOM element under the pointer first) and
 * returns the first one that resolves to a LEGAL drop, or `null` if none
 * do — the caller then shows no indicator at all rather than a wrong one.
 * "Legal" is entirely delegated to `canDropOn` (`canMoveTo` from
 * tree-ops.ts, gated on the resolved parent id): a leaf with an illegal
 * container behind it, the dragged node's own subtree, a depth breach —
 * none of that legality is re-derived here, it just falls through to the
 * next candidate, e.g. the container sitting behind an illegal leaf.
 */
export function resolveCanvasDropTarget(
  candidates: readonly CanvasDragCandidate[],
  pointer: Point,
  draggedId: string,
  lookup: (nodeId: string) => CanvasNodeInfo | null,
  canDropOn: (parentId: string) => boolean,
): CanvasDropResolution | null {
  for (const candidate of candidates) {
    if (candidate.nodeId === draggedId) continue; // can't drop a node onto itself

    const info = lookup(candidate.nodeId);
    if (!info) continue; // unaddressable id (shouldn't happen — defensive)
    const { node, parentId, index } = info;

    if (parentId === null) {
      // Root (or a cellTemplate root) has no parent to reorder against —
      // the only zone that ever applies is "into" it, exactly like the
      // Layers panel's root row (`layer-tree.tsx`'s `computeDropZone`).
      if (!isContainerNode(node) || !canDropOn(node.id)) continue;
      return {
        targetNodeId: node.id,
        zone: "into",
        parentId: node.id,
        index: node.children.length,
        splitAxis: normalizeSplitAxis(containerAxis(node)),
      };
    }

    const parentInfo = lookup(parentId);
    const parentAxis =
      parentInfo && isContainerNode(parentInfo.node) ? containerAxis(parentInfo.node) : "vertical";
    const zone = computeCanvasDropZone(pointer, candidate.rect, parentAxis, isContainerNode(node));

    if (zone === "into") {
      if (!isContainerNode(node) || !canDropOn(node.id)) continue;
      return {
        targetNodeId: node.id,
        zone,
        parentId: node.id,
        index: node.children.length,
        splitAxis: normalizeSplitAxis(containerAxis(node)),
      };
    }

    if (!canDropOn(parentId)) continue;
    return {
      targetNodeId: node.id,
      zone,
      parentId,
      index: zone === "before" ? index : index + 1,
      splitAxis: normalizeSplitAxis(parentAxis),
    };
  }
  return null;
}
