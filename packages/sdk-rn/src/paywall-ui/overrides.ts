// =============================================================
// overrides.ts — RN port of packages/shared/src/paywall/validate.ts's
// `applyOverrides`: same semantics (array order, later wins, shallow
// per-field overlay, identity when nothing matches, unknown `when.kind`
// never active). This is a LOCAL port, not a re-export of shared's —
// shared's `applyOverrides` is typed against the strict `PaywallNode`
// union, whose `unknown` handling differs from this package's lenient
// `BuilderNode` (an `unknown`-typed node here carries no `overrides`
// field at all, see model.ts). Mirrors
// packages/sdk-swift/.../PaywallUI/PaywallOverrides.swift and
// packages/sdk-kotlin/.../paywallui/PaywallOverrides.kt.
//
// Test cases in __tests__/overrides.test.ts mirror validate.test.ts's
// `applyOverrides` describe block (D-Task 1's shared case table)
// verbatim, adapted to BuilderNode.
// =============================================================

import type { Offering } from "../types";
import type { BuilderNode, NodeOverride } from "./model";

/** The `{ introEligible, selected }` condition set active for a node's
 *  position in the tree. Mirrors nodes.tsx's `activeOverrideConditions`
 *  return shape. */
export type OverrideActiveConditions = { introEligible: boolean; selected: boolean };

/**
 * Every known `BuilderNode` case carries an optional `overrides` array;
 * only the lenient `unknown` case doesn't (excluded before this runs).
 */
type OverridableNode = Exclude<BuilderNode, { type: "unknown" }>;

/**
 * Generic merge: base props, then every override whose `when.kind` is
 * active, in array order (later wins), merged shallowly — a direct port
 * of validate.ts's `applyOverrides` body. Pure — never mutates `node` —
 * and returns the SAME object reference when no override is active, so
 * callers on a hot render path can cheaply skip re-render via identity.
 */
function mergeActive<T extends { overrides?: NodeOverride[] }>(node: T, active: OverrideActiveConditions): T {
  const overrides = node.overrides;
  if (!overrides || overrides.length === 0) return node;

  let merged: T | null = null;
  for (const override of overrides) {
    const isActive =
      (override.when.kind === "introEligible" && active.introEligible) ||
      (override.when.kind === "selected" && active.selected);
    if (!isActive) continue;
    merged = { ...(merged ?? node), ...(override.props ?? {}) } as T;
  }
  return merged ?? node;
}

/**
 * Applies `node`'s `overrides` for the given active condition set.
 * `unknown` nodes (no `overrides` field per the lenient decoder) pass
 * through unchanged.
 */
export function applyOverrides(node: BuilderNode, active: OverrideActiveConditions): BuilderNode {
  if (node.type === "unknown") return node;
  return mergeActive(node as OverridableNode, active);
}

/**
 * The `{ introEligible, selected }` condition set active for a node's
 * position in the tree, given the cell it's scoped to (if any — `null`
 * outside any `cellTemplate` subtree). Relevance follows the same rule as
 * `{{variable}}` resolution: cell-scoped inside a `cellTemplate` subtree
 * (the cell's own package), selected-scoped everywhere else (the globally
 * selected package). `selected` is only ever true inside a `cellTemplate`
 * subtree, for the cell whose package is the current global selection.
 * Mirrors nodes.tsx's `activeOverrideConditions` / the Swift+Kotlin
 * siblings' function of the same name.
 */
export function activeOverrideConditions(
  cellPackageId: string | null,
  selectedPackageId: string | null,
  offering: Offering | null,
): OverrideActiveConditions {
  const relevantPackageId = cellPackageId ?? selectedPackageId;
  const pkg = relevantPackageId
    ? (offering?.packages.find((p) => p.identifier === relevantPackageId) ?? null)
    : null;
  const introEligible = pkg?.product.isEligibleForIntroOffer ?? false;
  const selected = cellPackageId !== null && cellPackageId === selectedPackageId;
  return { introEligible, selected };
}
