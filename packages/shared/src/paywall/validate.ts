import type { BuilderConfig, PaywallNode, StackNode } from "./schema";

// =============================================================
// Cross-node-tree validation for a builder config: things Zod's
// per-node shape checks can't express (uniqueness, cross-references
// into localizations / the offering, and tree-wide invariants).
//
// Returned issues are not all "errors" in the blocking sense —
// LOCALE_KEY_GAP is a warning by convention — but every issue comes
// back in the same flat array; the caller (dashboard UI / publish
// gate) decides severity by `code`.
// =============================================================

export type BuilderIssue = {
  code:
    | "DUPLICATE_NODE_ID"
    | "UNKNOWN_LOC_KEY"
    | "FOREIGN_PACKAGE_ID"
    | "MISSING_PURCHASE_BUTTON"
    | "LOCALE_KEY_GAP";
  nodeId?: string;
  locale?: string;
  key?: string;
  message: string;
};

/** Depth-first walk over every node in the tree, including fallbacks. */
function walkNodes(node: PaywallNode, visit: (node: PaywallNode) => void): void {
  visit(node);
  if (node.type === "stack") {
    for (const child of node.children) walkNodes(child, visit);
  }
  if (node.fallback) walkNodes(node.fallback, visit);
}

/**
 * Every localization key referenced by a text/button/purchaseButton node
 * anywhere in the tree (including inside `fallback` subtrees), deduped.
 */
export function collectLocalizationKeys(root: StackNode): string[] {
  const seen = new Set<string>();
  walkNodes(root, (node) => {
    if (node.type === "text") seen.add(node.key);
    if (node.type === "button" || node.type === "purchaseButton") {
      seen.add(node.labelKey);
    }
  });
  return [...seen];
}

export function validateBuilderConfig(
  config: BuilderConfig,
  opts: { offeringPackageIds: string[] },
): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const offeringSet = new Set(opts.offeringPackageIds);

  const allNodes: PaywallNode[] = [];
  walkNodes(config.root, (node) => allNodes.push(node));

  // DUPLICATE_NODE_ID — across the whole tree.
  const idCounts = new Map<string, number>();
  for (const node of allNodes) {
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        code: "DUPLICATE_NODE_ID",
        nodeId: id,
        message: `Node id "${id}" is used by ${count} nodes; ids must be unique across the tree.`,
      });
    }
  }

  const defaultLocaleTable = config.localizations[config.defaultLocale] ?? {};

  // UNKNOWN_LOC_KEY — text/button/purchaseButton key missing from defaultLocale.
  for (const node of allNodes) {
    let key: string | undefined;
    if (node.type === "text") key = node.key;
    if (node.type === "button" || node.type === "purchaseButton") key = node.labelKey;
    if (key === undefined) continue;
    if (!(key in defaultLocaleTable)) {
      issues.push({
        code: "UNKNOWN_LOC_KEY",
        nodeId: node.id,
        key,
        message: `Key "${key}" (node "${node.id}") is not present in the default locale ("${config.defaultLocale}") table.`,
      });
    }
  }

  // FOREIGN_PACKAGE_ID — packageList.packageIds/defaultSelected outside the offering.
  // MISSING_PURCHASE_BUTTON — a packageList exists but no purchaseButton does.
  let hasPackageList = false;
  let hasPurchaseButton = false;
  for (const node of allNodes) {
    if (node.type === "purchaseButton") hasPurchaseButton = true;
    if (node.type !== "packageList") continue;
    hasPackageList = true;

    for (const packageId of node.packageIds) {
      if (!offeringSet.has(packageId)) {
        issues.push({
          code: "FOREIGN_PACKAGE_ID",
          nodeId: node.id,
          message: `packageList "${node.id}" references package id "${packageId}" which is not in the offering.`,
        });
      }
    }
    if (node.defaultSelected !== undefined && !offeringSet.has(node.defaultSelected)) {
      issues.push({
        code: "FOREIGN_PACKAGE_ID",
        nodeId: node.id,
        message: `packageList "${node.id}" defaultSelected "${node.defaultSelected}" is not in the offering.`,
      });
    }
  }
  if (hasPackageList && !hasPurchaseButton) {
    issues.push({
      code: "MISSING_PURCHASE_BUTTON",
      message: "A packageList is present but no purchaseButton exists in the tree.",
    });
  }

  // LOCALE_KEY_GAP — per (non-default locale, key present in defaultLocale but missing there).
  const defaultKeys = Object.keys(defaultLocaleTable);
  for (const [locale, table] of Object.entries(config.localizations)) {
    if (locale === config.defaultLocale) continue;
    for (const key of defaultKeys) {
      if (!(key in table)) {
        issues.push({
          code: "LOCALE_KEY_GAP",
          locale,
          key,
          message: `Locale "${locale}" is missing key "${key}" present in the default locale.`,
        });
      }
    }
  }

  return issues;
}

/** locale → defaultLocale → null */
export function resolveText(
  config: BuilderConfig,
  locale: string,
  key: string,
): string | null {
  const direct = config.localizations[locale]?.[key];
  if (direct !== undefined) return direct;
  const fallback = config.localizations[config.defaultLocale]?.[key];
  return fallback !== undefined ? fallback : null;
}
