import { OVERRIDABLE_PROP_KEYS, type BuilderConfig, type PaywallNode, type StackNode } from "./schema";

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
    | "LOCALE_KEY_GAP"
    // Emitted by the API's builderConfig write path when the payload fails
    // the structural Zod parse (or exceeds depth/size bounds) — not by
    // validateBuilderConfig itself, which only sees parsed configs. In the
    // union so the dashboard renders API issue lists fully typed.
    | "SCHEMA_INVALID"
    // Phase D2 — overrides / cellTemplate.
    | "CELL_TEMPLATE_BAD_NODE"
    | "OVERRIDE_BAD_PROP"
    | "OVERRIDE_SELECTED_OUTSIDE_CELL";
  nodeId?: string;
  locale?: string;
  key?: string;
  message: string;
};

/**
 * Issue codes that do NOT block a save: the builderConfig still persists
 * (the API answers 200) and the dashboard renders them as warnings rather
 * than errors. Shared so the API gate and the builder view-model can never
 * drift apart — they used to keep hand-synced copies.
 *
 * Deliberately `ReadonlySet<string>` rather than
 * `ReadonlySet<BuilderIssue["code"]>`: `INTRO_VARIABLE_UNGUARDED` is spec'd
 * (Phase D3's intro-variable lint) but not yet emitted by
 * `validateBuilderConfig`, so membership stays forward-tolerant instead of
 * becoming a type error the day the validator starts emitting it.
 */
export const WARNING_ISSUE_CODES: ReadonlySet<string> = new Set([
  "LOCALE_KEY_GAP",
  "OVERRIDE_SELECTED_OUTSIDE_CELL",
  "INTRO_VARIABLE_UNGUARDED",
]);

/** True when an issue must block the save (i.e. it isn't a warning). */
export function isBlockingIssue(issue: { code: string }): boolean {
  return !WARNING_ISSUE_CODES.has(issue.code);
}

/**
 * Depth-first walk over every node in the tree, including `fallback` AND
 * `packageList.cellTemplate` subtrees. `insideCellTemplate` is true for the
 * cellTemplate root and everything beneath it (children/fallback), reset to
 * false only outside any cellTemplate — a nested cellTemplate (unusual but
 * not forbidden) simply stays `true`.
 */
function walkNodes(
  node: PaywallNode,
  visit: (node: PaywallNode, insideCellTemplate: boolean) => void,
  insideCellTemplate = false,
): void {
  visit(node, insideCellTemplate);
  if (node.type === "stack") {
    for (const child of node.children) walkNodes(child, visit, insideCellTemplate);
  }
  if (node.type === "packageList" && node.cellTemplate) {
    walkNodes(node.cellTemplate, visit, true);
  }
  if (node.fallback) walkNodes(node.fallback, visit, insideCellTemplate);
}

/**
 * `key`/`labelKey` values carried by a node's `overrides` — an override
 * that swaps a text/button node's key introduces a NEW localization key
 * that must be collected/checked exactly like the node's base key.
 */
function overrideLocKeys(node: PaywallNode): string[] {
  const keys: string[] = [];
  for (const override of node.overrides ?? []) {
    const key = override.props["key"];
    if (typeof key === "string") keys.push(key);
    const labelKey = override.props["labelKey"];
    if (typeof labelKey === "string") keys.push(labelKey);
  }
  return keys;
}

/** One (localization key → owning node) pair discovered in the tree. */
export interface LocalizationUsage {
  key: string;
  nodeId: string;
  nodeType: PaywallNode["type"];
  /** True when the key came from `overrides[].props`, not the node's own field. */
  viaOverride: boolean;
}

/**
 * Every (key, owning node) pair in the tree, in document order — including
 * `fallback` and `packageList.cellTemplate` subtrees, and keys introduced by
 * `overrides`. This is the single traversal; `collectLocalizationKeys` is a
 * projection of it, so the two can never disagree about what the tree uses.
 */
export function collectLocalizationUsages(root: StackNode): LocalizationUsage[] {
  const usages: LocalizationUsage[] = [];
  walkNodes(root, (node) => {
    if (node.type === "text") {
      usages.push({ key: node.key, nodeId: node.id, nodeType: node.type, viaOverride: false });
    }
    if (node.type === "button" || node.type === "purchaseButton") {
      usages.push({ key: node.labelKey, nodeId: node.id, nodeType: node.type, viaOverride: false });
    }
    for (const key of overrideLocKeys(node)) {
      usages.push({ key, nodeId: node.id, nodeType: node.type, viaOverride: true });
    }
  });
  return usages;
}

/**
 * Every localization key referenced by a text/button/purchaseButton node
 * anywhere in the tree (including inside `fallback` and `cellTemplate`
 * subtrees), PLUS any `key`/`labelKey` introduced by an override, deduped
 * in first-seen order.
 */
export function collectLocalizationKeys(root: StackNode): string[] {
  const seen = new Set<string>();
  for (const usage of collectLocalizationUsages(root)) seen.add(usage.key);
  return [...seen];
}

/**
 * A localization value is missing when the key is absent OR the value is
 * blank. Presence alone says nothing: the builder stubs every newly-added
 * key as `""` in every locale, so a blank-but-present value is the normal
 * "nobody has written this yet" state. Shared so the validator and the
 * dashboard's localization matrix cannot drift on what "missing" means.
 */
export function isMissingLocaleValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function validateBuilderConfig(
  config: BuilderConfig,
  opts: { offeringPackageIds: string[] },
): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const offeringSet = new Set(opts.offeringPackageIds);

  const nodesWithCtx: Array<{ node: PaywallNode; insideCellTemplate: boolean }> = [];
  walkNodes(config.root, (node, insideCellTemplate) => {
    nodesWithCtx.push({ node, insideCellTemplate });
  });
  const allNodes: PaywallNode[] = nodesWithCtx.map((n) => n.node);

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

  // UNKNOWN_LOC_KEY — text/button/purchaseButton key (base or override-provided)
  // missing from defaultLocale.
  for (const node of allNodes) {
    const keysToCheck: string[] = [];
    if (node.type === "text") keysToCheck.push(node.key);
    if (node.type === "button" || node.type === "purchaseButton") keysToCheck.push(node.labelKey);
    keysToCheck.push(...overrideLocKeys(node));

    const checked = new Set<string>();
    for (const key of keysToCheck) {
      if (checked.has(key)) continue;
      checked.add(key);
      if (!(key in defaultLocaleTable)) {
        issues.push({
          code: "UNKNOWN_LOC_KEY",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") is not present in the default locale ("${config.defaultLocale}") table.`,
        });
      }
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

  // CELL_TEMPLATE_BAD_NODE — packageList/purchaseButton anywhere inside a
  // cellTemplate subtree (renderers can't nest a package cell / purchase
  // action inside a per-cell template).
  // OVERRIDE_SELECTED_OUTSIDE_CELL — a `selected`-condition override on a
  // node that isn't inside any cellTemplate subtree; renderers never match
  // `selected` there, so it's a warning rather than blocking.
  for (const { node, insideCellTemplate } of nodesWithCtx) {
    if (insideCellTemplate && (node.type === "packageList" || node.type === "purchaseButton")) {
      issues.push({
        code: "CELL_TEMPLATE_BAD_NODE",
        nodeId: node.id,
        message: `Node "${node.id}" (type "${node.type}") is not allowed inside a cellTemplate subtree.`,
      });
    }
    if (!insideCellTemplate) {
      for (const override of node.overrides ?? []) {
        if (override.when.kind === "selected") {
          issues.push({
            code: "OVERRIDE_SELECTED_OUTSIDE_CELL",
            nodeId: node.id,
            message: `Node "${node.id}" has a "selected" override but is not inside any cellTemplate subtree; it will never match.`,
          });
        }
      }
    }
  }

  // OVERRIDE_BAD_PROP — defensive re-check on already-parsed configs: the
  // strict authoring schema rejects structural/unknown prop keys at parse
  // time, so this is normally unreachable, but guards configs built/edited
  // outside the schema (e.g. programmatically) before they reach a renderer.
  for (const node of allNodes) {
    const allowed = new Set(OVERRIDABLE_PROP_KEYS[node.type]);
    for (const override of node.overrides ?? []) {
      for (const propKey of Object.keys(override.props)) {
        if (!allowed.has(propKey)) {
          issues.push({
            code: "OVERRIDE_BAD_PROP",
            nodeId: node.id,
            key: propKey,
            message: `Node "${node.id}" (type "${node.type}") has an override prop "${propKey}" that is not overridable for this node type.`,
          });
        }
      }
    }
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

/**
 * Applies a node's `overrides` for the given active condition set: base
 * props, then every override whose `when.kind` is active, in array order
 * (later wins), merged shallowly. Unknown `when.kind` values (possible when
 * called on lenient-decoded data in TS consumers) are simply never active,
 * so they're skipped without special-casing. Pure — never mutates `node` —
 * and returns the SAME object reference when no override is active, so
 * callers on a hot render path can cheaply skip re-render via identity.
 */
export function applyOverrides<T extends PaywallNode>(
  node: T,
  active: { introEligible: boolean; selected: boolean },
): T {
  const overrides = node.overrides;
  if (!overrides || overrides.length === 0) return node;

  let merged: T | null = null;
  for (const override of overrides) {
    const isActive =
      (override.when.kind === "introEligible" && active.introEligible) ||
      (override.when.kind === "selected" && active.selected);
    if (!isActive) continue;
    merged = { ...(merged ?? node), ...override.props } as T;
  }
  return merged ?? node;
}
