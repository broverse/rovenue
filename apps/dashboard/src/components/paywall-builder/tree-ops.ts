import {
  ICON_DEFAULT_SIZE,
  DIVIDER_DEFAULT_THICKNESS,
  DIVIDER_DEFAULT_INSET,
  MAX_BUILDER_DEPTH,
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

/**
 * Depth of the node with `id`, root-relative (root itself is depth 1, same
 * convention as `measureNodeTree`). Walks the identical addressability
 * model as `search`/`searchParent` — container children, a `packageList`'s
 * `cellTemplate`, and `fallback` — so a node reachable ONLY through a
 * cellTemplate or fallback subtree still gets an honest depth. Returns
 * null when `id` isn't found anywhere.
 */
function nodeDepth(node: PaywallNode, id: string, depth = 1): number | null {
  if (node.id === id) return depth;
  if (isContainerNode(node)) {
    for (const child of node.children) {
      const found = nodeDepth(child, id, depth + 1);
      if (found !== null) return found;
    }
  }
  if (node.type === "packageList" && node.cellTemplate) {
    const found = nodeDepth(node.cellTemplate, id, depth + 1);
    if (found !== null) return found;
  }
  if (node.fallback) {
    const found = nodeDepth(node.fallback, id, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Height of `node`'s own subtree — 1 for a leaf, more for a container with
 * descendants. `moveNodeTo` needs this (not the moved node's OWN depth)
 * because what can breach `MAX_BUILDER_DEPTH` after a re-parent is the
 * subtree's DEEPEST descendant, not the moved node itself: a 3-deep
 * subtree dropped into a container near the cap can breach even though
 * the moved node's own single-level depth would not. Same traversal
 * (children/cellTemplate/fallback) as `nodeDepth`, for the same reason.
 */
function subtreeHeight(node: PaywallNode): number {
  let tallestChild = 0;
  if (isContainerNode(node)) {
    for (const child of node.children) tallestChild = Math.max(tallestChild, subtreeHeight(child));
  }
  if (node.type === "packageList" && node.cellTemplate) {
    tallestChild = Math.max(tallestChild, subtreeHeight(node.cellTemplate));
  }
  if (node.fallback) tallestChild = Math.max(tallestChild, subtreeHeight(node.fallback));
  return 1 + tallestChild;
}

/** True when `id` names `node` itself or any of its descendants (children/cellTemplate/fallback). */
function containsId(node: PaywallNode, id: string): boolean {
  if (node.id === id) return true;
  if (isContainerNode(node) && node.children.some((c) => containsId(c, id))) return true;
  if (node.type === "packageList" && node.cellTemplate && containsId(node.cellTemplate, id)) return true;
  if (node.fallback && containsId(node.fallback, id)) return true;
  return false;
}

/**
 * Moves `id` to `index` inside `newParentId`'s children — a re-parent when
 * `newParentId` differs from the current parent, a reorder when it's the
 * same. Returns a new root, or `null` when the move is illegal (never a
 * corrupted tree). Illegal:
 *
 * - `id` isn't addressable (unknown id, the root itself, or a node only
 *   reachable via a `fallback`/`cellTemplate` slot — same `findParent`
 *   rule every other op here follows).
 * - `newParentId` doesn't resolve to a node, or resolves to a non-container.
 * - `newParentId` is `id` itself or one of `id`'s own descendants — you
 *   cannot move a subtree inside itself.
 * - The move would push some node in the moved SUBTREE past
 *   `MAX_BUILDER_DEPTH`. Node count never changes on a move, so only depth
 *   needs checking — and it's the subtree's HEIGHT that matters, not the
 *   moved node's own depth (see `subtreeHeight`).
 *
 * CROSS-SCOPE DECISION (main tree ↔ inside a `packageList.cellTemplate`
 * subtree): allowed, deliberately, with no extra scope-tracking. Every
 * legality check above (`findParent`, `findNode`, `containsId`, the depth
 * walk) already recurses through `cellTemplate` exactly like an ordinary
 * `children` array — that's the whole point of the addressability model
 * this file documents up top. There is no separate "which scope am I in"
 * concept anywhere in insert/remove/find, so a move that crosses the
 * boundary is just an ordinary re-parent to these functions, and nothing
 * about the tree SHAPE is ambiguous. (Fallback subtrees are the same
 * story, though moot in practice: the Layers panel never lists a fallback
 * node as a row, so the UI never offers one as a drag source or drop
 * target — see `layer-tree-flatten.ts`.)
 *
 * Reorders within the SAME parent get the classic index-shift treatment:
 * removing the node at its old index shifts every later sibling left by
 * one, so a forward move's target index (expressed against the ORIGINAL
 * array) is decremented by one before inserting.
 */
export function moveNodeTo(
  root: StackNode,
  id: string,
  newParentId: string,
  index: number,
): StackNode | null {
  if (id === root.id) return null; // the root has no parent+index — not movable

  const located = findParent(root, id);
  if (!located) return null; // unknown id, or reachable only via fallback/cellTemplate slot

  const { parent: oldParent, index: oldIndex } = located;
  const movingNode = oldParent.children[oldIndex]!;

  const newParent = findNode(root, newParentId);
  if (!newParent || !isContainerNode(newParent)) return null; // target missing or not a container

  if (containsId(movingNode, newParentId)) return null; // into itself or its own descendant

  const parentDepth = nodeDepth(root, newParentId);
  if (parentDepth === null) return null; // defensive — findNode above already guarantees this
  if (parentDepth + subtreeHeight(movingNode) > MAX_BUILDER_DEPTH) return null;

  let targetIndex = index;
  if (oldParent.id === newParentId) {
    if (targetIndex === oldIndex) return root; // dropped back where it started — true no-op
    if (targetIndex > oldIndex) targetIndex -= 1;
  }

  const withoutNode = removeNode(root, id);
  return insertNode(withoutNode, newParentId, movingNode, targetIndex);
}

/**
 * Cheap legality probe for the Layers panel while dragging: "would ANY
 * drop of `id` onto `newParentId` be legal?" Legality never depends on the
 * drop index (only container-ness, self/descendant containment, and
 * subtree depth do — see `moveNodeTo`), so a dry run at index 0 answers it
 * without the caller needing to know a real index yet, and without
 * duplicating `moveNodeTo`'s rules here.
 */
export function canMoveTo(root: StackNode, id: string, newParentId: string): boolean {
  return moveNodeTo(root, id, newParentId, 0) !== null;
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
 * button/purchaseButton/footerLinks nodes derive a FRESH localization key
 * from that id (`text_<id>` / `button_<id>` / `purchaseButton_<id>` /
 * `footerLinks_<id>_1`) so the caller can immediately register an empty
 * string for it in every locale table.
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
    case "footerLinks":
      // Restore is the only footer link every store requires and the only
      // one that needs no URL from the author — see the module doc comment.
      return {
        type: "footerLinks",
        id,
        links: [{ labelKey: `footerLinks_${id}_1`, action: { kind: "restore" } }],
      };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown node type: ${String(exhaustive)}`);
    }
  }
}
