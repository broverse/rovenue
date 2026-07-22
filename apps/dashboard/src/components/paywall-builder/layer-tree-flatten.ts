import type { PaywallNode, StackNode } from "@rovenue/shared/paywall";

// =============================================================
// Pure flattening of a builder-config node tree into indented rows
// for the layer tree panel. Walks stack children only (matches
// tree-ops' addressability model — a node reachable solely via a
// `fallback` slot has no parent+index to move/delete against, so
// it's intentionally excluded here too).
// =============================================================

export type FlatTreeRow = {
  node: PaywallNode;
  depth: number;
  parentId: string | null;
  /** Index among this node's siblings in the parent's `children` array. */
  index: number;
  /** Sibling count at this node's level — lets the caller disable move-down at the edge. */
  siblingCount: number;
};

export function flattenTree(root: StackNode): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  function walk(node: PaywallNode, depth: number, parentId: string | null, index: number, siblingCount: number) {
    rows.push({ node, depth, parentId, index, siblingCount });
    if (node.type === "stack") {
      node.children.forEach((child, i) => walk(child, depth + 1, node.id, i, node.children.length));
    }
  }

  walk(root, 0, null, 0, 1);
  return rows;
}
