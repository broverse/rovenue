import { describe, expect, it } from "vitest";
import { applyTreeOp, emptyBuilderConfig, type PaywallNode } from "@rovenue/shared/paywall";
import { isContainerNode, newNode } from "../tree-ops";

// =============================================================
// Drift tripwire (deferred from Task 1's ledger, folded into Task 5).
//
// `packages/shared/src/paywall/tree-op.ts` HAND-MIRRORS the dashboard's
// `isContainerNode` (stack/carousel/stickyFooter) because the shared
// package can't import from apps/dashboard. Nothing enforced the two
// copies stay in sync — a new container type added only on the dashboard
// side (or vice versa) would silently make `applyTreeOp` reject inserts
// under it while the dashboard's own tree-ops happily accepted them.
//
// This test derives the container-node list from the DASHBOARD's own
// `isContainerNode` over EVERY node type in the `PaywallNode` union, then
// asserts shared `applyTreeOp` accepts an `insert` under each one found.
// `NODE_TYPE_WITNESS` below is exhaustiveness-checked by TypeScript: if a
// node type is ever added to (or removed from) the union, this file fails
// to compile until the witness object is updated — so a schema change
// can't silently skip the container set this test actually exercises.
// =============================================================

const NODE_TYPE_WITNESS: Record<PaywallNode["type"], true> = {
  stack: true,
  text: true,
  image: true,
  button: true,
  packageList: true,
  purchaseButton: true,
  spacer: true,
  divider: true,
  icon: true,
  featureList: true,
  timeline: true,
  socialProof: true,
  stickyFooter: true,
  countdown: true,
  carousel: true,
  video: true,
  lottie: true,
};

const ALL_NODE_TYPES = Object.keys(NODE_TYPE_WITNESS) as PaywallNode["type"][];

describe("dashboard/shared container-node set drift tripwire", () => {
  it("shared applyTreeOp accepts an insert under every node type the dashboard's isContainerNode calls a container", () => {
    let n = 0;
    const idGen = () => `drift_${n++}`;

    const containerTypes = ALL_NODE_TYPES.filter((type) => isContainerNode(newNode(type, idGen)));

    // Sanity: fails loudly if the filter itself goes vacuous (e.g. a typo
    // in isContainerNode's switch) rather than silently passing zero cases.
    // Order follows NODE_TYPE_WITNESS's declaration order, not tree-ops.ts's
    // isContainerNode switch order — don't assume the two match.
    expect(new Set(containerTypes)).toEqual(new Set(["stack", "carousel", "stickyFooter"]));
    expect(containerTypes).toHaveLength(3);

    for (const type of containerTypes) {
      const container = newNode(type, idGen);
      const leaf = newNode("text", idGen);

      const config = emptyBuilderConfig("en");
      config.root = { ...config.root, children: [container] };

      const result = applyTreeOp(config, {
        kind: "insert",
        parentId: container.id,
        index: 0,
        subtree: leaf,
      });

      const insertedParent = result.root.children.find((c) => c.id === container.id) as
        | (PaywallNode & { children?: PaywallNode[] })
        | undefined;
      expect(insertedParent?.children?.some((c) => c.id === leaf.id), `insert under ${type} failed`).toBe(
        true,
      );
    }
  });
});
