import { OVERRIDABLE_PROP_KEYS, type BuilderConfig, type PaywallNode, type StackNode } from "./schema";
import { compareVersions } from "./visibility";

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

/**
 * Own-property test. `Object.hasOwn` would read better, but it is ES2022
 * and this module is re-exported through `@rovenue/shared/paywall`, which
 * the React Native SDK bundles — so it executes on Hermes, where older
 * engines in the supported fleet lack it. This form needs no lib bump and
 * still avoids the prototype walk a bare `in` would do.
 */
function hasOwnKey(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

export type BuilderIssue = {
  code:
    | "DUPLICATE_NODE_ID"
    | "UNKNOWN_LOC_KEY"
    // The key exists in the default locale but its value is blank. A normal
    // in-progress authoring state, so it must NOT block the save — only the
    // publish. See ISSUE_SEVERITY.
    | "EMPTY_LOC_VALUE"
    | "FOREIGN_PACKAGE_ID"
    | "MISSING_PURCHASE_BUTTON"
    | "LOCALE_KEY_GAP"
    // Emitted by the API's builderConfig write path when the payload fails
    // the structural Zod parse (or exceeds depth/size bounds) — not by
    // validateBuilderConfig itself, which only sees parsed configs. In the
    // union so the dashboard renders API issue lists fully typed.
    | "SCHEMA_INVALID"
    // A node whose visibility bounds cross, so it renders nowhere.
    | "VISIBILITY_NEVER_MATCHES"
    // A visibility bound the comparator cannot read, so it never applies.
    | "VISIBILITY_BOUND_UNPARSEABLE"
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
 * How far an issue stops the author:
 * - `save`    — the builderConfig cannot even persist. A broken config.
 * - `publish` — persists fine, but must not ship to devices. A legitimate
 *               work-in-progress, e.g. copy nobody has written yet.
 * - `warning` — blocks nothing.
 *
 * The tiers are ordered: everything that blocks a save also blocks a publish.
 */
export type IssueSeverity = "save" | "publish" | "warning";

/**
 * The single severity table. A code appears at most once, so the tiers cannot
 * overlap — the earlier shape (a warning set plus a publish set, each predicate
 * a negation over them) let a code land in both and silently degrade to a
 * warning, i.e. the strictest-looking mistake produced the loosest behaviour.
 *
 * Deliberately keyed `string` rather than `BuilderIssue["code"]`:
 * `INTRO_VARIABLE_UNGUARDED` is spec'd (Phase D3's intro-variable lint) but not
 * yet emitted by `validateBuilderConfig`, so membership stays forward-tolerant
 * instead of becoming a type error the day the validator starts emitting it.
 */
const ISSUE_SEVERITY: Readonly<Record<string, IssueSeverity>> = {
  // Warnings — block nothing.
  LOCALE_KEY_GAP: "warning",
  OVERRIDE_SELECTED_OUTSIDE_CELL: "warning",
  INTRO_VARIABLE_UNGUARDED: "warning",
  // Dead content, not a broken config. A gate that refused it would be the
  // fifth in this project to reject a legitimate work-in-progress.
  VISIBILITY_NEVER_MATCHES: "warning",
  // Fail open is the right answer when RENDERING — but silence is the wrong
  // answer when AUTHORING. Without this the author types "v1.2.0", the node
  // shows everywhere, and nothing anywhere says the bound was ignored.
  VISIBILITY_BOUND_UNPARSEABLE: "warning",

  // Publish-only — a draft in this state is ordinary work in progress and
  // MUST still persist. Four of these are reachable from the builder UI in
  // one or two clicks (add a package list before its purchase button;
  // switch the offering; switch the default locale to a new empty one; add
  // a node inside a cellTemplate), and blocking the save on them meant the
  // author kept working while nothing was written. OVERRIDE_BAD_PROP is
  // listed for consistency only: the strict authoring schema rejects a
  // non-allow-listed override prop at parse time, so such a config answers
  // SCHEMA_INVALID before this table is ever consulted.
  UNKNOWN_LOC_KEY: "publish",
  EMPTY_LOC_VALUE: "publish",
  FOREIGN_PACKAGE_ID: "publish",
  MISSING_PURCHASE_BUTTON: "publish",
  CELL_TEMPLATE_BAD_NODE: "publish",
  OVERRIDE_BAD_PROP: "publish",

  // Anything unlisted stays "save" — see issueSeverity. Only DUPLICATE_NODE_ID
  // relies on that today: tree-ops addresses nodes by id, so a duplicate makes
  // the builder's own next edit ambiguous. It is not reachable from the UI
  // (the builder generates ids), so blocking it costs an author nothing.
};

/** Anything unlisted blocks the save — the strictest tier, so a code added
 * later fails closed until it is deliberately classified.
 *
 * own-property-guarded like `UNKNOWN_LOC_KEY`'s defaultLocaleTable lookup
 * above: an unguarded `ISSUE_SEVERITY[issue.code]` also resolves inherited
 * `Object` prototype properties (`issue.code === "constructor"` returns the
 * `Object` constructor function, a truthy non-"save" value), which would fail
 * OPEN on the save gate — `isBlockingIssue` returns `false` for a code that
 * was never classified, the opposite of the fail-closed default this function
 * documents.
 */
export function issueSeverity(issue: { code: string }): IssueSeverity {
  return hasOwnKey(ISSUE_SEVERITY, issue.code) ? ISSUE_SEVERITY[issue.code]! : "save";
}

/** True when an issue must block the SAVE (the API's builderConfig PATCH). */
export function isBlockingIssue(issue: { code: string }): boolean {
  return issueSeverity(issue) === "save";
}

/** True when an issue must block a PUBLISH — every save-blocker, plus the
 * publish-only tier. */
export function isPublishBlockingIssue(issue: { code: string }): boolean {
  return issueSeverity(issue) !== "warning";
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

const ALL_PLATFORMS = ["ios", "android", "web"] as const;
type PlatformId = (typeof ALL_PLATFORMS)[number];

/** Platforms this node ITSELF allows. Absent or empty = all (fail open). */
function ownPlatforms(node: PaywallNode): ReadonlySet<PlatformId> {
  const p = node.visibility?.platform;
  return p && p.length > 0 ? new Set(p) : new Set(ALL_PLATFORMS);
}

/**
 * Record every packageList and purchaseButton with the set of platforms on
 * which it can actually appear — its own visibility intersected with every
 * ancestor's. Version bounds are ignored on purpose: they are unknowable at
 * author time and fail open, so a node hidden only by version still counts
 * as reachable, which keeps this check from over-blocking.
 *
 * cellTemplate entry does NOT reset the platform set (a nested node inherits
 * it), which keeps the no-visibility case byte-identical to the old
 * boolean check — a purchaseButton anywhere still counts.
 */
function collectCommerceReach(
  node: PaywallNode,
  inherited: ReadonlySet<PlatformId>,
  out: { packageLists: Set<PlatformId>[]; purchaseButtons: Set<PlatformId>[] },
): void {
  const effective = new Set<PlatformId>(
    [...inherited].filter((pl) => ownPlatforms(node).has(pl)),
  );
  if (node.type === "packageList") out.packageLists.push(effective);
  if (node.type === "purchaseButton") out.purchaseButtons.push(effective);
  if (node.type === "stack") for (const c of node.children) collectCommerceReach(c, effective, out);
  if (node.type === "packageList" && node.cellTemplate) collectCommerceReach(node.cellTemplate, effective, out);
  if (node.fallback) collectCommerceReach(node.fallback, effective, out);
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
  return typeof value !== "string" || value.trim() === "";
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

  // VISIBILITY_NEVER_MATCHES — bounds that cross, so the node renders nowhere.
  for (const node of allNodes) {
    const { minAppVersion, maxAppVersion } = node.visibility ?? {};
    // A bound the comparator cannot read is silently ignored at render time
    // (fail open). Say so here, or the author believes a gate exists that
    // does not — "v1.2.0" is the likeliest thing anyone types.
    for (const [field, bound] of [
      ["minAppVersion", minAppVersion],
      ["maxAppVersion", maxAppVersion],
    ] as const) {
      if (bound && compareVersions(bound, bound) === null) {
        issues.push({
          code: "VISIBILITY_BOUND_UNPARSEABLE",
          nodeId: node.id,
          message: `Node "${node.id}" has ${field} "${bound}", which is not a dotted number, so it will be ignored.`,
        });
      }
    }
    if (!minAppVersion || !maxAppVersion) continue;
    const cmp = compareVersions(minAppVersion, maxAppVersion);
    // `null` means we could not compare them, which is NOT the same as
    // knowing they cross — say nothing rather than guess.
    if (cmp !== null && cmp > 0) {
      issues.push({
        code: "VISIBILITY_NEVER_MATCHES",
        nodeId: node.id,
        message: `Node "${node.id}" has minAppVersion "${minAppVersion}" above maxAppVersion "${maxAppVersion}", so it can never render.`,
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
      if (!hasOwnKey(defaultLocaleTable, key)) {
        issues.push({
          code: "UNKNOWN_LOC_KEY",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") has no entry in the default locale ("${config.defaultLocale}").`,
        });
      } else if (isMissingLocaleValue(defaultLocaleTable[key])) {
        issues.push({
          code: "EMPTY_LOC_VALUE",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") is blank in the default locale ("${config.defaultLocale}") — fill it in before publishing.`,
        });
      }
    }
  }

  // FOREIGN_PACKAGE_ID — packageList.packageIds/defaultSelected outside the offering.
  for (const node of allNodes) {
    if (node.type !== "packageList") continue;
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
  // MISSING_PURCHASE_BUTTON — on every platform where a package list can
  // appear, a purchase button must too. `visibility` makes this per-platform:
  // hiding the only purchase button on Android leaves that store's paywall
  // showing plans with no way to buy. With no visibility anywhere this
  // reduces to the old "packageList exists but no purchaseButton" — all
  // three platforms break together, one issue.
  const reach = { packageLists: [] as Set<PlatformId>[], purchaseButtons: [] as Set<PlatformId>[] };
  collectCommerceReach(config.root, new Set(ALL_PLATFORMS), reach);
  const brokenPlatforms = ALL_PLATFORMS.filter(
    (pl) =>
      reach.packageLists.some((s) => s.has(pl)) && !reach.purchaseButtons.some((s) => s.has(pl)),
  );
  if (brokenPlatforms.length > 0) {
    const where =
      brokenPlatforms.length === ALL_PLATFORMS.length
        ? "no purchaseButton renders on any platform"
        : `no purchaseButton renders on ${brokenPlatforms.join(", ")}`;
    issues.push({
      code: "MISSING_PURCHASE_BUTTON",
      message: `A packageList is present but ${where}, so those users cannot buy.`,
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

  // LOCALE_KEY_GAP — per (non-default locale, key the TREE uses that is written
  // in the default locale but missing there).
  //
  // Scoped to tree usage, not to the whole default-locale table: `removeNode`
  // never prunes `localizations`, so deleting a node orphans its key forever,
  // and no builder UI can delete a localization key. A table-scoped loop warned
  // about those orphans while the localization matrix — which lists tree usages
  // — had no row for them: an unclearable warning with nothing to act on.
  const usedKeys = [...new Set(collectLocalizationUsages(config.root).map((u) => u.key))];
  for (const [locale, table] of Object.entries(config.localizations)) {
    if (locale === config.defaultLocale) continue;
    for (const key of usedKeys) {
      // Already reported against the default locale by UNKNOWN_LOC_KEY /
      // EMPTY_LOC_VALUE — and the message below would be a lie.
      if (isMissingLocaleValue(defaultLocaleTable[key])) continue;
      if (isMissingLocaleValue(table[key])) {
        issues.push({
          code: "LOCALE_KEY_GAP",
          locale,
          key,
          message: `Locale "${locale}" has no text for key "${key}", which is set in the default locale.`,
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
