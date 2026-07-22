import type { PaywallNode, StackNode } from "@rovenue/shared/paywall";

// =============================================================
// Pure flattening of a builder-config node tree into indented rows
// for the layer tree panel. Walks stack children AND (Phase D2)
// `packageList.cellTemplate` subtrees — matches tree-ops'
// addressability model for everything EXCEPT the cellTemplate root
// itself: a node reachable solely via a `fallback` slot, or a
// cellTemplate root's own single-slot position on its packageList,
// has no parent+index to move/delete against (tree-ops excludes
// both from insert/remove/move) — `fallback` is excluded from the
// layer tree entirely, but a cellTemplate root SHOULD still be
// visible (labeled `isCellTemplateRoot`) since the UI shows/edits it
// as a nested branch (add/remove via the VM's `setCellTemplate`,
// not move/reorder).
// =============================================================

export type FlatTreeRow = {
  node: PaywallNode;
  depth: number;
  parentId: string | null;
  /** Index among this node's siblings in the parent's `children` array. */
  index: number;
  /** Sibling count at this node's level — lets the caller disable move-down at the edge. */
  siblingCount: number;
  /**
   * True only for the root node of a `packageList.cellTemplate` subtree —
   * not addressable by index (see the module doc above), so the layer
   * tree row for it disables move/reorder controls and instead offers
   * "remove template" (`vm.setCellTemplate(packageListId, "none")`).
   */
  isCellTemplateRoot: boolean;
};

export function flattenTree(root: StackNode): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  function walk(
    node: PaywallNode,
    depth: number,
    parentId: string | null,
    index: number,
    siblingCount: number,
    isCellTemplateRoot: boolean,
  ) {
    rows.push({ node, depth, parentId, index, siblingCount, isCellTemplateRoot });
    if (node.type === "stack") {
      node.children.forEach((child, i) =>
        walk(child, depth + 1, node.id, i, node.children.length, false),
      );
    }
    if (node.type === "packageList" && node.cellTemplate) {
      walk(node.cellTemplate, depth + 1, node.id, 0, 1, true);
    }
  }

  walk(root, 0, null, 0, 1, false);
  return rows;
}
