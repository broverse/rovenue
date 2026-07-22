import type { PaywallNode, StackNode } from "@rovenue/shared/paywall";

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
// Addressability model: a node's `children` array (only stack
// nodes have one) is the only place `insertNode`/`removeNode`/
// `moveNode` can act — a node that exists solely as some other
// node's `fallback` has no parent + index in this model (there's
// nothing to reorder a lone fallback slot against) and is therefore
// NOT addressable by those three ops; `findNode`/`updateNode` still
// reach into fallback subtrees since they only need the node
// itself, not a parent list.
// =============================================================

/** Depth-first search for `id`, walking stack children AND fallback slots. */
export function findNode(root: StackNode, id: string): PaywallNode | null {
  return search(root, id);
}

function search(node: PaywallNode, id: string): PaywallNode | null {
  if (node.id === id) return node;
  if (node.type === "stack") {
    for (const child of node.children) {
      const found = search(child, id);
      if (found) return found;
    }
  }
  if (node.fallback) {
    const found = search(node.fallback, id);
    if (found) return found;
  }
  return null;
}

/**
 * Finds the stack node whose `children` array contains `id`, plus
 * its index in that array. Returns null for the root (no parent),
 * an unknown id, or an id only reachable via a `fallback` slot.
 */
export function findParent(
  root: StackNode,
  id: string,
): { parent: StackNode; index: number } | null {
  return searchParent(root, id);
}

function searchParent(node: PaywallNode, id: string): { parent: StackNode; index: number } | null {
  if (node.type === "stack") {
    const index = node.children.findIndex((c) => c.id === id);
    if (index >= 0) return { parent: node, index };
    for (const child of node.children) {
      const found = searchParent(child, id);
      if (found) return found;
    }
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

  if (node.type === "stack") {
    let childrenChanged = false;
    const nextChildren = node.children.map((child) => {
      const updated = transformNode(child, targetId, transform);
      if (updated !== child) childrenChanged = true;
      return updated;
    });
    // Spread the narrowed `node` (not the widened `next`) so the result
    // stays a well-typed StackNode rather than an ambiguous union member.
    if (childrenChanged) next = { ...node, children: nextChildren };
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
    if (parent.type !== "stack") return parent; // not a container — no-op
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
    if (p.type !== "stack") return p;
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
    if (p.type !== "stack") return p;
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
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown node type: ${String(exhaustive)}`);
    }
  }
}
