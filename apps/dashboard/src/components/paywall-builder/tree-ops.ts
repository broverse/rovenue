import {
  ICON_DEFAULT_SIZE,
  DIVIDER_DEFAULT_THICKNESS,
  DIVIDER_DEFAULT_INSET,
  type CarouselNode,
  type PaywallNode,
  type StackNode,
  type StickyFooterNode,
} from "@rovenue/shared/paywall";

/** A new icon node starts as a checkmark — the commonest use is a feature-list mark. */
const DEFAULT_ICON_NAME = "check";

/**
 * A new countdown starts as a 15-minute session timer, not an absolute
 * deadline: `durationSeconds` needs no author input to be valid, where
 * `endsAt` unset would immediately raise COUNTDOWN_NO_DEADLINE — the
 * author's first look at the node would be an error badge.
 */
export const COUNTDOWN_DEFAULT_DURATION_SECONDS = 900;

// =============================================================
// Pure, immutable manipulation of a paywall builder-config node
// tree (`BuilderConfig.root`). Every function here returns a NEW
// root when it makes a change (structural sharing for untouched
// branches — siblings that weren't on the path to the mutated node
// keep their original object identity) and returns the SAME root
// reference, unchanged, when the operation is a no-op. Callers
// (the builder VM) rely on `===` to cheaply detect "nothing
// changed" and on the input tree being byte-for-byte identical
// after every call (never mutated in place).
//
// Addressability model: a node's `children` array (stack and
// carousel nodes have one) is the only place `insertNode`/`removeNode`/
// `moveNode` can act — a node that exists solely as some other
// node's `fallback` has no parent + index in this model (there's
// nothing to reorder a lone fallback slot against) and is therefore
// NOT addressable by those three ops; `findNode`/`updateNode` still
// reach into fallback subtrees since they only need the node
// itself, not a parent list.
//
// A `packageList.cellTemplate` (Phase D2) is the same kind of single
// node slot as `fallback` — the cellTemplate ROOT itself has no
// parent+index and is therefore not insertable/removable/moveable
// (the VM's `setCellTemplate` action owns creating/clearing it
// wholesale). Everything INSIDE that subtree — normally a stack with
// its own `children` — is fully addressable exactly like any other
// part of the tree, so every op below also recurses into
// `packageList.cellTemplate` alongside `fallback`.
//
// `carousel` (Wave D1) is a second container type alongside `stack` —
// its `children` are pages, addressable by insertNode/removeNode/
// moveNode exactly the same way. `isContainerNode` is the single
// switch every traversal below shares, so a new container type is one
// line to add here rather than one line in each of six places.
//
// `stickyFooter` (Wave C) is the third, and it was MISSING here until
// Wave D1 — `newNode` gave it an empty `children` array but no op could
// ever put anything in it, so an author could create a sticky footer and
// never place the purchase button that is its entire purpose. All three
// renderers had always drawn `stickyFooter.children` correctly; the gap
// was authoring-only, which is why a review comparing the three
// renderers did not surface it.
// =============================================================

/**
 * Node types whose `children` array is addressable by the ops below.
 *
 * Exported because the LAYER TREE needs the same answer: `layer-tree.tsx`
 * gates its "+ Add node" button on it and `layer-tree-flatten.ts` gates its
 * recursion on it. Wave D1's first attempt taught the cost of a second list —
 * the data layer here learned about carousel/stickyFooter while the UI kept
 * its own `type === "stack"` literal, so `insertNode` worked and nothing at
 * all changed on screen. One switch, imported everywhere; never re-spelt.
 */
export function isContainerNode(
  node: PaywallNode,
): node is StackNode | CarouselNode | StickyFooterNode {
  return node.type === "stack" || node.type === "carousel" || node.type === "stickyFooter";
}

/**
 * Resolves the insert target for the Layers panel's "New Element" button
 * (below the row list, not anchored to any particular row):
 *
 * - A selected CONTAINER node is used directly. This includes a
 *   `cellTemplate` root that happens to be a container (always true today —
 *   `setCellTemplate`'s "default" mode always seeds a stack) even though
 *   that id has no parent+index of its own (see the addressability-model
 *   note atop this file) — `insertNode` finds targets by id, not by
 *   parent+index, so it's still a perfectly valid target.
 * - A selected LEAF resolves to its immediate container parent.
 *   `findParent` already recurses through `cellTemplate`/`fallback`
 *   subtrees, so a leaf nested inside a cellTemplate still resolves to
 *   the right container.
 * - Anything else falls back to the tree's root: nothing selected, a
 *   stale/deleted selection, or a selected id that resolves to neither
 *   of the above (e.g. a non-container cellTemplate root, or a lone
 *   `fallback` leaf — both have no parent+index and so no `findParent`
 *   result). The root is always a valid, always-present container.
 */
export function resolveAddTargetId(root: StackNode, selectedNodeId: string | null): string {
  if (selectedNodeId !== null) {
    const selected = findNode(root, selectedNodeId);
    if (selected && isContainerNode(selected)) return selected.id;
    const located = findParent(root, selectedNodeId);
    if (located) return located.parent.id;
  }
  return root.id;
}

/** Depth-first search for `id`, walking container children AND fallback slots. */
export function findNode(root: StackNode, id: string): PaywallNode | null {
  return search(root, id);
}

function search(node: PaywallNode, id: string): PaywallNode | null {
  if (node.id === id) return node;
  if (isContainerNode(node)) {
    for (const child of node.children) {
      const found = search(child, id);
      if (found) return found;
    }
  }
  if (node.type === "packageList" && node.cellTemplate) {
    const found = search(node.cellTemplate, id);
    if (found) return found;
  }
  if (node.fallback) {
    const found = search(node.fallback, id);
    if (found) return found;
  }
  return null;
}

/**
 * Finds the container node (stack, carousel or stickyFooter) whose `children` array
 * contains `id`, plus its index in that array. Returns null for the
 * root (no parent), an unknown id, or an id only reachable via a
 * `fallback` slot.
 */
export function findParent(
  root: StackNode,
  id: string,
): { parent: StackNode | CarouselNode | StickyFooterNode; index: number } | null {
  return searchParent(root, id);
}

function searchParent(
  node: PaywallNode,
  id: string,
): { parent: StackNode | CarouselNode | StickyFooterNode; index: number } | null {
  if (isContainerNode(node)) {
    const index = node.children.findIndex((c) => c.id === id);
    if (index >= 0) return { parent: node, index };
    for (const child of node.children) {
      const found = searchParent(child, id);
      if (found) return found;
    }
  }
  if (node.type === "packageList" && node.cellTemplate) {
    const found = searchParent(node.cellTemplate, id);
    if (found) return found;
  }
  if (node.fallback) {
    const found = searchParent(node.fallback, id);
    if (found) return found;
  }
  return null;
}

/**
 * Rebuilds the path from `root` down to the node whose id === `targetId`,
 * applying `transform` to it. Every ancestor on the path is shallow-
 * copied; every other branch keeps its original object identity. If
 * `targetId` isn't found anywhere in the tree, `root` is returned
 * unchanged (same reference).
 */
function transformNode(
  node: PaywallNode,
  targetId: string,
  transform: (n: PaywallNode) => PaywallNode,
): PaywallNode {
  if (node.id === targetId) return transform(node);

  let next: PaywallNode = node;

  if (isContainerNode(node)) {
    let childrenChanged = false;
    const nextChildren = node.children.map((child) => {
      const updated = transformNode(child, targetId, transform);
      if (updated !== child) childrenChanged = true;
      return updated;
    });
    // Spread the narrowed `node` (not the widened `next`) so the result
    // stays a well-typed StackNode/CarouselNode rather than an ambiguous
    // union member.
    if (childrenChanged) next = { ...node, children: nextChildren };
  }

  if (node.type === "packageList" && node.cellTemplate) {
    const nextCellTemplate = transformNode(node.cellTemplate, targetId, transform);
    // Same narrowed-`node` rationale as the stack branch above.
    if (nextCellTemplate !== node.cellTemplate) {
      next = { ...node, cellTemplate: nextCellTemplate };
    }
  }

  if (next.fallback) {
    const nextFallback = transformNode(next.fallback, targetId, transform);
    if (nextFallback !== next.fallback) {
      next = { ...next, fallback: nextFallback } as PaywallNode;
    }
  }

  return next;
}

/** Immutably inserts `node` into `parentId`'s children at `index` (default: end). */
export function insertNode(
  root: StackNode,
  parentId: string,
  node: PaywallNode,
  index?: number,
): StackNode {
  return transformNode(root, parentId, (parent) => {
    if (!isContainerNode(parent)) return parent; // not a container — no-op
    const children = parent.children.slice();
    const at =
      index === undefined ? children.length : Math.max(0, Math.min(children.length, index));
    children.splice(at, 0, node);
    return { ...parent, children };
  }) as StackNode;
}

/** Removes `id` from its parent's children. The root is irremovable. */
export function removeNode(root: StackNode, id: string): StackNode {
  if (id === root.id) return root;
  const located = findParent(root, id);
  if (!located) return root;
  const { parent, index } = located;
  return transformNode(root, parent.id, (p) => {
    if (!isContainerNode(p)) return p;
    const children = p.children.slice();
    children.splice(index, 1);
    return { ...p, children };
  }) as StackNode;
}

/** Moves `id` one slot toward `dir` among its siblings. Clamps at the edges (no-op). */
export function moveNode(root: StackNode, id: string, dir: 1 | -1): StackNode {
  if (id === root.id) return root;
  const located = findParent(root, id);
  if (!located) return root;
  const { parent, index } = located;
  const target = index + dir;
  if (target < 0 || target >= parent.children.length) return root;
  return transformNode(root, parent.id, (p) => {
    if (!isContainerNode(p)) return p;
    const children = p.children.slice();
    const [item] = children.splice(index, 1);
    children.splice(target, 0, item);
    return { ...p, children };
  }) as StackNode;
}

/** Shallow-merges `patch` into the node with `id` (root included). */
export function updateNode<T extends PaywallNode>(
  root: StackNode,
  id: string,
  patch: Partial<T>,
): StackNode {
  return transformNode(root, id, (n) => ({ ...n, ...patch }) as PaywallNode) as StackNode;
}

/**
 * Builds a new node of `type` with sensible defaults. `idGen` supplies
 * the id (callers pass e.g. `() => createId().slice(0, 8)`); text/
 * button/purchaseButton nodes derive a FRESH localization key from
 * that id (`text_<id>` / `button_<id>` / `purchaseButton_<id>`) so the
 * caller can immediately register an empty string for it in every
 * locale table.
 */
export function newNode(type: PaywallNode["type"], idGen: () => string): PaywallNode {
  const id = idGen();
  switch (type) {
    case "stack":
      return { type: "stack", id, axis: "v", children: [] };
    case "text":
      return { type: "text", id, key: `text_${id}`, role: "body" };
    case "image":
      return { type: "image", id, url: { light: "" } };
    case "button":
      return {
        type: "button",
        id,
        labelKey: `button_${id}`,
        style: "secondary",
        action: { kind: "close" },
      };
    case "packageList":
      return { type: "packageList", id, packageIds: [], cellLayout: "column" };
    case "purchaseButton":
      return { type: "purchaseButton", id, labelKey: `purchaseButton_${id}` };
    case "spacer":
      return { type: "spacer", id, size: 16 };
    case "divider":
      return { type: "divider", id, thickness: DIVIDER_DEFAULT_THICKNESS, inset: DIVIDER_DEFAULT_INSET };
    case "icon":
      return { type: "icon", id, name: DEFAULT_ICON_NAME, size: ICON_DEFAULT_SIZE };
    case "featureList":
      return { type: "featureList", id, rows: [{ labelKey: `featureList_${id}_1` }] };
    case "timeline":
      return { type: "timeline", id, rows: [{ labelKey: `timeline_${id}_1` }] };
    case "socialProof":
      return { type: "socialProof", id, labelKey: `socialProof_${id}` };
    case "stickyFooter":
      return { type: "stickyFooter", id, children: [] };
    case "countdown":
      return { type: "countdown", id, durationSeconds: COUNTDOWN_DEFAULT_DURATION_SECONDS };
    case "carousel":
      return { type: "carousel", id, children: [] };
    case "video":
      return { type: "video", id, url: { light: "" } };
    case "lottie":
      return { type: "lottie", id, url: { light: "" } };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown node type: ${String(exhaustive)}`);
    }
  }
}
