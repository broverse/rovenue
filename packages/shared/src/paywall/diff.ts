import type { BuilderConfig, PaywallNode } from "./schema";

// =============================================================
// Structural diff between two builder configs.
//
// Server-side so the four render targets and the dashboard don't each
// reimplement it. Powers GET /paywalls/:id/diff and the builder's
// "Draft → Published" modal.
//
// Values are compared as JSON strings so the result is renderable
// verbatim without the caller re-serialising, and so `undefined` vs
// absent collapses to the same thing.
// =============================================================

export type BuilderConfigDiffEntry = {
  kind: "added" | "removed" | "changed";
  scope: "config" | "node" | "localization";
  /** Node the change belongs to; null for config/localization scope. */
  nodeId: string | null;
  nodeType: PaywallNode["type"] | null;
  /** Dotted path relative to the scope, or the literal "node" for add/remove. */
  field: string;
  from: string | null;
  to: string | null;
};

/**
 * Keys handled by the tree walk rather than the per-node prop flatten:
 * `id` identifies the node, and the other three are subtrees whose nodes
 * are diffed in their own right. Without this exclusion a change deep in
 * a `fallback` would be reported twice.
 */
const STRUCTURAL_KEYS = new Set(["id", "children", "fallback", "cellTemplate"]);

function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object") {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out[prefix] = "[]";
      return;
    }
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out[prefix] = "{}";
    return;
  }
  for (const [k, v] of entries) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function nodeProps(node: PaywallNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    flatten(v, k, out);
  }
  return out;
}

/** Document-order walk descending into children, fallback and cellTemplate. */
function collectNodes(root: PaywallNode | undefined): Map<string, PaywallNode> {
  const map = new Map<string, PaywallNode>();
  if (!root) return map;
  const stack: PaywallNode[] = [root];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (!map.has(node.id)) map.set(node.id, node);
    const nested: PaywallNode[] = [];
    if (node.type === "stack") nested.push(...node.children);
    if (node.type === "packageList" && node.cellTemplate) nested.push(node.cellTemplate);
    if (node.fallback) nested.push(node.fallback);
    stack.unshift(...nested);
  }
  return map;
}

function diffMaps(
  from: Record<string, string>,
  to: Record<string, string>,
  make: (
    kind: BuilderConfigDiffEntry["kind"],
    field: string,
    a: string | null,
    b: string | null,
  ) => BuilderConfigDiffEntry,
): BuilderConfigDiffEntry[] {
  const out: BuilderConfigDiffEntry[] = [];
  for (const [field, a] of Object.entries(from)) {
    const b = to[field];
    if (b === undefined) out.push(make("removed", field, a, null));
    else if (b !== a) out.push(make("changed", field, a, b));
  }
  for (const [field, b] of Object.entries(to)) {
    if (from[field] === undefined) out.push(make("added", field, null, b));
  }
  return out;
}

function configProps(config: BuilderConfig | null): Record<string, string> {
  if (!config) return {};
  const out: Record<string, string> = {};
  flatten(config.defaultLocale, "defaultLocale", out);
  if (config.background) flatten(config.background, "background", out);
  return out;
}

function localizationProps(config: BuilderConfig | null): Record<string, string> {
  if (!config) return {};
  const out: Record<string, string> = {};
  for (const [locale, entries] of Object.entries(config.localizations)) {
    for (const [key, value] of Object.entries(entries)) {
      out[`${locale}.${key}`] = JSON.stringify(value);
    }
  }
  return out;
}

/**
 * Ordering is deterministic: config fields, then nodes in `to` document
 * order followed by nodes only present in `from`, then localizations.
 * The diff modal renders the list as-is.
 */
export function diffBuilderConfigs(
  from: BuilderConfig | null,
  to: BuilderConfig | null,
): BuilderConfigDiffEntry[] {
  const entries: BuilderConfigDiffEntry[] = [];

  entries.push(
    ...diffMaps(configProps(from), configProps(to), (kind, field, a, b) => ({
      kind,
      scope: "config",
      nodeId: null,
      nodeType: null,
      field,
      from: a,
      to: b,
    })),
  );

  const fromNodes = collectNodes(from?.root);
  const toNodes = collectNodes(to?.root);

  for (const [id, toNode] of toNodes) {
    const fromNode = fromNodes.get(id);
    if (!fromNode) {
      entries.push({
        kind: "added",
        scope: "node",
        nodeId: id,
        nodeType: toNode.type,
        field: "node",
        from: null,
        to: toNode.type,
      });
      continue;
    }
    entries.push(
      ...diffMaps(nodeProps(fromNode), nodeProps(toNode), (kind, field, a, b) => ({
        kind,
        scope: "node",
        nodeId: id,
        nodeType: toNode.type,
        field,
        from: a,
        to: b,
      })),
    );
  }

  for (const [id, fromNode] of fromNodes) {
    if (toNodes.has(id)) continue;
    entries.push({
      kind: "removed",
      scope: "node",
      nodeId: id,
      nodeType: fromNode.type,
      field: "node",
      from: fromNode.type,
      to: null,
    });
  }

  entries.push(
    ...diffMaps(localizationProps(from), localizationProps(to), (kind, field, a, b) => ({
      kind,
      scope: "localization",
      nodeId: null,
      nodeType: null,
      field,
      from: a,
      to: b,
    })),
  );

  return entries;
}
