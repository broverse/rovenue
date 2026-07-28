import { z, type ZodArray, type ZodLazy, type ZodTypeAny } from "zod";
import { builderConfigSchema, type BuilderConfig, type PaywallNode, type StackNode } from "./schema";

// =============================================================
// Pure paywall builder-config tree operations, shared by the dashboard
// builder VM and the AI-FAB intent handler (Task 2+): both apply the
// SAME `applyTreeOp` so an AI-proposed edit and a hand-drawn one go
// through one implementation. Mirrors the insert/remove/update/
// container semantics of `apps/dashboard/src/components/paywall-builder/
// tree-ops.ts`, but as PURE functions over the whole `BuilderConfig`
// (not just `StackNode`, since `setLocalizations` touches
// `config.localizations`) and NOT imported from apps/dashboard — this
// package cannot depend on the dashboard app.
// =============================================================

export type PaywallTreeOp =
  | { kind: "insert"; parentId: string; index: number; subtree: PaywallNode }
  | { kind: "replace"; nodeId: string; subtree: PaywallNode }
  | { kind: "remove"; nodeId: string }
  | { kind: "updateProps"; nodeId: string; patch: Record<string, unknown> }
  | { kind: "setLocalizations"; locale: string; entries: Record<string, string> };

/**
 * The strict `PaywallNode` union schema, recovered from `builderConfigSchema`
 * rather than re-declared here. `schema.ts` does not export the per-node
 * schemas or the node union itself (only the assembled `builderConfigSchema`
 * / `emptyBuilderConfig`), and this module must not add exports to
 * `schema.ts` — a parallel session owns that file this phase.
 *
 * `builderConfigSchema.root` is the stack-node schema, whose `children`
 * field is `z.lazy(() => z.array(<the node union>))`. Unwrapping the
 * `ZodLazy` (`.schema`, a public zod getter — see zod's `ZodLazy` class) and
 * then the `ZodArray` (`.element`, likewise public) recovers exactly the
 * same strict union schema.ts builds internally, so a subtree with an
 * unknown node `type` is rejected identically to how the top-level config
 * schema would reject it — no drift possible, since it IS that schema.
 */
function extractPaywallNodeSchema(): z.ZodType<PaywallNode> {
  const stackSchema = (
    builderConfigSchema as unknown as z.ZodObject<{
      root: z.ZodObject<{ children: ZodLazy<ZodArray<ZodTypeAny>> }>;
    }>
  ).shape.root;
  const childrenLazy = stackSchema.shape.children;
  const arraySchema = childrenLazy.schema;
  return arraySchema.element as z.ZodType<PaywallNode>;
}

const paywallNodeSchema: z.ZodType<PaywallNode> = extractPaywallNodeSchema();

export const paywallTreeOpSchema: z.ZodType<PaywallTreeOp> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("insert"),
    parentId: z.string().min(1),
    index: z.number().int(),
    subtree: paywallNodeSchema,
  }),
  z.object({
    kind: z.literal("replace"),
    nodeId: z.string().min(1),
    subtree: paywallNodeSchema,
  }),
  z.object({
    kind: z.literal("remove"),
    nodeId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("updateProps"),
    nodeId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("setLocalizations"),
    locale: z.string().min(1),
    entries: z.record(z.string(), z.string()),
  }),
]);

export class TreeOpError extends Error {
  constructor(
    public readonly code: "TARGET_NOT_FOUND" | "NOT_A_CONTAINER" | "INDEX_OUT_OF_RANGE" | "CANNOT_REMOVE_ROOT",
  ) {
    super(code);
    this.name = "TreeOpError";
  }
}

/**
 * Node types whose `children` array is addressable by the ops below.
 * Mirrors `isContainerNode` in the dashboard's `tree-ops.ts` byte-for-byte
 * (stack, carousel, stickyFooter) — re-declared here rather than imported,
 * since this package cannot depend on apps/dashboard. If the dashboard's
 * container set changes, this must change with it.
 */
function isContainerNode(node: PaywallNode): node is Extract<PaywallNode, { children: PaywallNode[] }> {
  return node.type === "stack" || node.type === "carousel" || node.type === "stickyFooter";
}

/** Depth-first search for `id`, walking container children, `fallback`, and
 *  `packageList.cellTemplate` subtrees. */
function findNode(node: PaywallNode, id: string): PaywallNode | null {
  if (node.id === id) return node;
  if (isContainerNode(node)) {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  if (node.type === "packageList" && node.cellTemplate) {
    const found = findNode(node.cellTemplate, id);
    if (found) return found;
  }
  if (node.fallback) {
    const found = findNode(node.fallback, id);
    if (found) return found;
  }
  return null;
}

/**
 * Finds the container node (stack, carousel or stickyFooter) whose
 * `children` array contains `id`, plus its index in that array. Returns
 * null for the root (no parent), an unknown id, or an id only reachable via
 * a `fallback`/`cellTemplate` slot — same addressability model as the
 * dashboard's `findParent`.
 */
function findParent(
  node: PaywallNode,
  id: string,
): { parent: Extract<PaywallNode, { children: PaywallNode[] }>; index: number } | null {
  if (isContainerNode(node)) {
    const index = node.children.findIndex((c) => c.id === id);
    if (index >= 0) return { parent: node, index };
    for (const child of node.children) {
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  if (node.type === "packageList" && node.cellTemplate) {
    const found = findParent(node.cellTemplate, id);
    if (found) return found;
  }
  if (node.fallback) {
    const found = findParent(node.fallback, id);
    if (found) return found;
  }
  return null;
}

/**
 * Rebuilds the path from `node` down to the node whose `id === targetId`,
 * applying `transform` to it. Every ancestor on the path is shallow-copied;
 * every other branch keeps its original object identity — the purity
 * discipline `applyTreeOp` relies on. If `targetId` isn't found anywhere,
 * `node` is returned unchanged (same reference).
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
    if (childrenChanged) next = { ...node, children: nextChildren };
  }

  if (node.type === "packageList" && node.cellTemplate) {
    const nextCellTemplate = transformNode(node.cellTemplate, targetId, transform);
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

/**
 * Pure: returns a NEW config; throws `TreeOpError` on an invalid target.
 * Never mutates `config` or any value reachable from it — every changed
 * branch is a fresh object, every untouched branch keeps its original
 * identity (structural sharing), exactly like the dashboard's tree-ops.
 *
 * `setLocalizations` MERGES `entries` into `config.localizations[locale]`
 * (creating the locale table if absent) rather than replacing it — an
 * AI-proposed copy edit for one key must not wipe out every other key
 * already translated for that locale.
 *
 * The root stack (`config.root`) can never be removed or replaced away —
 * both throw `CANNOT_REMOVE_ROOT` rather than silently no-op'ing, so a
 * caller (the AI intent handler's dry run, the builder VM) always knows
 * when an op didn't do what it asked.
 */
export function applyTreeOp(config: BuilderConfig, op: PaywallTreeOp): BuilderConfig {
  switch (op.kind) {
    case "insert": {
      const parent = findNode(config.root, op.parentId);
      if (!parent) throw new TreeOpError("TARGET_NOT_FOUND");
      if (!isContainerNode(parent)) throw new TreeOpError("NOT_A_CONTAINER");
      if (op.index < 0 || op.index > parent.children.length) {
        throw new TreeOpError("INDEX_OUT_OF_RANGE");
      }
      const nextRoot = transformNode(config.root, op.parentId, (node) => {
        if (!isContainerNode(node)) return node;
        const children = node.children.slice();
        children.splice(op.index, 0, op.subtree);
        return { ...node, children };
      }) as StackNode;
      return { ...config, root: nextRoot };
    }
    case "replace": {
      if (op.nodeId === config.root.id) throw new TreeOpError("CANNOT_REMOVE_ROOT");
      const target = findNode(config.root, op.nodeId);
      if (!target) throw new TreeOpError("TARGET_NOT_FOUND");
      const nextRoot = transformNode(config.root, op.nodeId, () => op.subtree) as StackNode;
      return { ...config, root: nextRoot };
    }
    case "remove": {
      if (op.nodeId === config.root.id) throw new TreeOpError("CANNOT_REMOVE_ROOT");
      const located = findParent(config.root, op.nodeId);
      if (!located) throw new TreeOpError("TARGET_NOT_FOUND");
      const { parent, index } = located;
      const nextRoot = transformNode(config.root, parent.id, (node) => {
        if (!isContainerNode(node)) return node;
        const children = node.children.slice();
        children.splice(index, 1);
        return { ...node, children };
      }) as StackNode;
      return { ...config, root: nextRoot };
    }
    case "updateProps": {
      const target = findNode(config.root, op.nodeId);
      if (!target) throw new TreeOpError("TARGET_NOT_FOUND");
      const nextRoot = transformNode(
        config.root,
        op.nodeId,
        (node) => ({ ...node, ...op.patch }) as PaywallNode,
      ) as StackNode;
      return { ...config, root: nextRoot };
    }
    case "setLocalizations": {
      const existing = config.localizations[op.locale] ?? {};
      const merged = { ...existing, ...op.entries };
      return {
        ...config,
        localizations: { ...config.localizations, [op.locale]: merged },
      };
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Unknown tree op kind: ${String((exhaustive as { kind?: string }).kind)}`);
    }
  }
}
