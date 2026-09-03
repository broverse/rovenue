import { isKnownIconName } from "./icon-registry";
import {
  CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
  FEATURE_LIST_SOFT_MAX,
  LOTTIE_MAX_SPEED,
  LOTTIE_MIN_SPEED,
  OVERRIDABLE_PROP_KEYS,
  VIDEO_DEFAULT_AUTOPLAY,
  VIDEO_DEFAULT_MUTED,
  type BuilderConfig,
  type ButtonNode,
  type PaywallNode,
  type StackNode,
  type ThemeUrl,
} from "./schema";
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

/**
 * A URL string is empty when it's absent or blank after trimming — the same
 * rule `isMissingLocaleValue` applies to localization text, restated here
 * for URLs so the two domains don't have to share one name for two
 * different things. Whitespace reads as filled to a naive `!== ""` check
 * but is exactly as unusable as `""`.
 */
function isEmptyUrlValue(url: string | undefined): boolean {
  return typeof url !== "string" || url.trim() === "";
}

/**
 * Pushes EMPTY_MEDIA_URL for every empty variant of one ThemeUrl-typed
 * field on one node: `light` unconditionally — it's the url every renderer
 * falls back to — and `dark` only when the field is PRESENT. An ABSENT dark
 * variant just means "use light on both themes," a complete config, not a
 * hole; a PRESENT-but-blank one resolves to nothing on that theme, which is
 * exactly the hole light's check exists to catch. `fieldLabel` names the
 * field in the message ("url" or "posterUrl") so the author knows which
 * control on the Content tab to open.
 */
function pushEmptyMediaUrlIssues(
  issues: BuilderIssue[],
  node: PaywallNode,
  fieldLabel: string,
  url: ThemeUrl,
): void {
  if (isEmptyUrlValue(url.light)) {
    issues.push({
      code: "EMPTY_MEDIA_URL",
      nodeId: node.id,
      message: `${node.type} "${node.id}" has an empty ${fieldLabel}.light — replace the placeholder before publishing.`,
    });
  }
  if (url.dark !== undefined && isEmptyUrlValue(url.dark)) {
    issues.push({
      code: "EMPTY_MEDIA_URL",
      nodeId: node.id,
      message: `${node.type} "${node.id}" has an empty ${fieldLabel}.dark — replace the placeholder before publishing, or remove the dark override.`,
    });
  }
}

/** True for a `{kind: "url", url: ""}` (or whitespace) action. `close` and
 *  `restore` carry no url to be empty, so they never match. */
function isEmptyUrlAction(action: ButtonNode["action"]): boolean {
  return action.kind === "url" && isEmptyUrlValue(action.url);
}

/**
 * Which localization keys each node type contributes. Same shape as
 * OVERRIDABLE_PROP_KEYS and exhaustive by construction, so a new node type
 * cannot be added without deciding this.
 *
 * A function rather than a list of property names because wave B's
 * featureList/socialProof/timeline carry arrays of localized rows, which a
 * flat name list cannot express.
 *
 * Keyed by a mapped type over the discriminant (`[K in PaywallNode["type"]]`)
 * rather than `Record<PaywallNode["type"], (node: PaywallNode) => string[]>`
 * so each row's parameter is `Extract<PaywallNode, { type: K }>` — that row's
 * specific node type — instead of the whole union. That is what lets
 * `text: (n) => [n.key]` type-check with no cast: `n` really is a `TextNode`
 * in that row, so reaching for a field the row's own type doesn't have is a
 * compile error, not a silently-accepted `as` cast to the wrong member. Do
 * not collapse this back to a plain `Record` — that reintroduces exactly the
 * per-row cast-to-anything hole this type exists to close.
 */
type LocalizedKeyFns = {
  [K in PaywallNode["type"]]: (node: Extract<PaywallNode, { type: K }>) => string[];
};

export const LOCALIZED_KEYS: LocalizedKeyFns = {
  stack: () => [],
  text: (n) => [n.key],
  image: () => [],
  button: (n) => [n.labelKey],
  packageList: () => [],
  purchaseButton: (n) => (n.trialLabelKey ? [n.labelKey, n.trialLabelKey] : [n.labelKey]),
  spacer: () => [],
  divider: () => [],
  icon: () => [],
  featureList: (n) => n.rows.map((r) => r.labelKey),
  timeline: (n) => n.rows.flatMap((r) => (r.captionKey ? [r.labelKey, r.captionKey] : [r.labelKey])),
  socialProof: (n) => [n.labelKey],
  // stickyFooter contributes no key of its own — its children are walked
  // separately, exactly as stack's are.
  stickyFooter: () => [],
  countdown: (n) => (n.labelKey ? [n.labelKey] : []),
  // Wave D1 — a carousel has no localized text of its own; each page carries
  // its own, and pages are walked separately, exactly as stack's children are.
  carousel: () => [],
  // Wave D2 — video/lottie carry no localized text of their own.
  video: () => [],
  lottie: () => [],
  footerLinks: (n) => n.links.map((l) => l.labelKey),
};

/**
 * Every localization key this node contributes, in whatever order its
 * `LOCALIZED_KEYS` row returns them (declaration order for a single-field
 * node; row order, then label-before-caption, for featureList/timeline).
 *
 * The cast is the one deliberate escape hatch `LocalizedKeyFns` leaves open:
 * indexing `LOCALIZED_KEYS` by a *variable* `node.type` (rather than a
 * literal `K`) gives back a union of all the row functions, and TypeScript
 * cannot prove that union member lines up with this particular `node` — so
 * the call site, not any row, needs the cast. One cast here instead of one
 * per row is the trade the mapped type buys.
 */
export function localizedKeysOf(node: PaywallNode): string[] {
  return (LOCALIZED_KEYS[node.type] as (node: PaywallNode) => string[])(node);
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
    | "OVERRIDE_SELECTED_OUTSIDE_CELL"
    // An icon node whose `name` is not in icon-registry.json. Renders nothing
    // on every platform (fail open by design — see IconNode), so this is a
    // typo warning, not a broken config.
    | "UNKNOWN_ICON_NAME"
    // Wave B — a featureList with more rows than FEATURE_LIST_SOFT_MAX.
    // Authoring guidance from conversion research, not a broken config.
    | "FEATURE_LIST_TOO_LONG"
    // Wave B — a featureList/timeline with no rows. An unfinished node, but
    // it must still save.
    | "EMPTY_ROWS"
    // Wave C — a stickyFooter that is not a direct child of config.root.
    // It still renders (inline, like a stack), just not pinned.
    | "STICKY_FOOTER_NOT_AT_ROOT"
    // Wave C — more than one stickyFooter in the tree.
    | "MULTIPLE_STICKY_FOOTERS"
    // Wave C — a countdown with neither endsAt nor durationSeconds. Parses
    // fine (a normal mid-edit state) but cannot render, so it must not ship.
    | "COUNTDOWN_NO_DEADLINE"
    // Wave C — a countdown whose endsAt has already passed.
    | "COUNTDOWN_DEADLINE_PAST"
    // Wave D1 — a carousel with no pages; cannot render at all.
    | "CAROUSEL_EMPTY"
    // Wave D1 — autoAdvanceSeconds below CAROUSEL_MIN_AUTO_ADVANCE_SECONDS.
    | "CAROUSEL_AUTO_ADVANCE_TOO_FAST"
    // Wave D1 — a carousel with exactly one page; nothing to carousel through.
    | "CAROUSEL_SINGLE_PAGE"
    // Wave D2 — a video that autoplays with sound; browsers refuse to
    // autoplay unmuted video, so it will not actually autoplay as authored.
    | "VIDEO_AUTOPLAY_UNMUTED"
    // Wave D2 — a video that does not autoplay and has no posterUrl, so it
    // shows a blank frame until the viewer presses play.
    | "VIDEO_NO_POSTER"
    // Wave D2 — a lottie speed outside [LOTTIE_MIN_SPEED, LOTTIE_MAX_SPEED].
    // Authoring guidance, not a broken config — the renderer honours whatever
    // speed it is given.
    | "LOTTIE_SPEED_OUT_OF_RANGE"
    // Wave D2 — a video inside a carousel with no fallback. The accepted
    // cross-platform limitation this code exists to mitigate: a carousel
    // decides its pages SYNCHRONOUSLY, but a video's load failure is
    // ASYNCHRONOUS, so a source that parses and then fails after mounting
    // keeps its page and its dot — a blank page behind a dot that promises
    // something to swipe to. Making the page list shrink after mount was
    // assessed on all three paging primitives and rejected as
    // disproportionate; a `fallback` makes the blank page impossible in
    // practice, so the author is told to carry one.
    | "VIDEO_IN_CAROUSEL_NO_FALLBACK"
    // Task 8b — an image/video/lottie node whose `url.light` is blank, or
    // whose PRESENT `url.dark`/`video.posterUrl.dark` is blank. Every
    // gallery template's placeholder media (and the long-standing `hero`
    // preset) ships this way on purpose, so it must save freely — but it
    // must not reach a device with nothing to draw.
    | "EMPTY_MEDIA_URL"
    // Task 8b — a button, or a footerLinks link, whose action is
    // `{kind:"url", url:""}`. A template's footer factory emits Terms/
    // Privacy links exactly this way because it cannot know a project's
    // real legal URLs — a normal, save-able mid-authoring state, but a
    // link that goes nowhere is an App Store review risk on top of being
    // cosmetic, so it must not ship.
    | "EMPTY_ACTION_URL";
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
  // A typo to surface, not a broken config — it renders nothing and the
  // renderers fail open, so it must block neither save nor publish.
  UNKNOWN_ICON_NAME: "warning",
  // Authoring guidance from the conversion research, not a broken config.
  FEATURE_LIST_TOO_LONG: "warning",
  // An unfinished node, almost never an intent — but it must still save.
  EMPTY_ROWS: "warning",
  // Renders inline instead of pinned — degraded, not broken.
  STICKY_FOOTER_NOT_AT_ROOT: "warning",
  MULTIPLE_STICKY_FOOTERS: "warning",
  // The author's dated promotion has already passed.
  COUNTDOWN_DEADLINE_PAST: "warning",
  // Authoring guidance, not a broken config — the renderer honours whatever
  // interval it is given.
  CAROUSEL_AUTO_ADVANCE_TOO_FAST: "warning",
  // Technically renders, just pointlessly — a single page is not a broken
  // config, only a probably-unintended one.
  CAROUSEL_SINGLE_PAGE: "warning",
  // Authoring guidance — browsers silently refuse the autoplay rather than
  // breaking the config; the renderer falls back to click-to-play.
  VIDEO_AUTOPLAY_UNMUTED: "warning",
  // A missing poster degrades the first frame, it doesn't break the config.
  VIDEO_NO_POSTER: "warning",
  // Authoring guidance, not a broken config — the renderer honours whatever
  // speed it is given.
  LOTTIE_SPEED_OUT_OF_RANGE: "warning",
  // Advice about an ACCEPTED limitation, not a defect in the config: the
  // paywall renders exactly as authored unless the video fails mid-load, so
  // this must block neither the save nor the publish.
  VIDEO_IN_CAROUSEL_NO_FALLBACK: "warning",

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
  // Cannot render at all, so it must not ship — but it must still save,
  // because "I have not chosen the deadline yet" is a normal edit state.
  COUNTDOWN_NO_DEADLINE: "publish",
  // Cannot render at all, so it must not ship — but a carousel with no pages
  // yet is a normal edit state (the author adds pages next), so it must
  // still save.
  CAROUSEL_EMPTY: "publish",
  // Task 8b — every gallery template's placeholder media (and the
  // long-standing `hero` preset) ships with `url: { light: "" }` on
  // purpose, precisely so a template can be applied and its copy edited
  // before the author has picked real art. That is ordinary work in
  // progress and MUST still persist; only shipping it to a device — where
  // it draws nothing — is the problem.
  EMPTY_MEDIA_URL: "publish",
  // Task 8b — a template's footer factory emits Terms/Privacy links as
  // `{kind:"url", url:""}` because it cannot know a project's real legal
  // URLs; that placeholder is the same kind of normal in-progress state as
  // EMPTY_MEDIA_URL and must still save. It blocks publish rather than
  // warning because a link that goes nowhere is not merely cosmetic — a
  // non-functional Terms/Privacy link is an App Store review risk.
  EMPTY_ACTION_URL: "publish",

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
 * Where a node sits, carried down the one walk below so that a rule about
 * PLACEMENT (rather than about the node's own props) needs no second
 * traversal of its own.
 */
interface NodeWalkContext {
  /**
   * True for the cellTemplate root and everything beneath it
   * (children/fallback), reset to false only outside any cellTemplate — a
   * nested cellTemplate (unusual but not forbidden) simply stays `true`.
   */
  insideCellTemplate: boolean;
  /**
   * True for every DESCENDANT of a carousel — its pages, and anything nested
   * inside them — but NOT for the carousel node itself. A carousel's own
   * `fallback` is excluded too: it replaces the carousel entirely, so it is
   * never one of its pages.
   */
  insideCarousel: boolean;
}

const ROOT_WALK_CONTEXT: NodeWalkContext = { insideCellTemplate: false, insideCarousel: false };

/**
 * Depth-first walk over every node in the tree, including `fallback` AND
 * `packageList.cellTemplate` subtrees.
 */
function walkNodes(
  node: PaywallNode,
  visit: (node: PaywallNode, ctx: NodeWalkContext) => void,
  ctx: NodeWalkContext = ROOT_WALK_CONTEXT,
): void {
  visit(node, ctx);
  // A carousel's CHILDREN are its pages; the carousel itself is not one.
  const childCtx: NodeWalkContext =
    node.type === "carousel" ? { ...ctx, insideCarousel: true } : ctx;
  if (node.type === "stack" || node.type === "stickyFooter" || node.type === "carousel") {
    for (const child of node.children) walkNodes(child, visit, childCtx);
  }
  if (node.type === "packageList" && node.cellTemplate) {
    walkNodes(node.cellTemplate, visit, { ...ctx, insideCellTemplate: true });
  }
  // `ctx`, not `childCtx`: a node's fallback stands in for the NODE, so it
  // inherits the node's own placement, not the placement of its children.
  if (node.fallback) walkNodes(node.fallback, visit, ctx);
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
  if (node.type === "stack" || node.type === "stickyFooter" || node.type === "carousel") {
    for (const c of node.children) collectCommerceReach(c, effective, out);
  }
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
    for (const key of localizedKeysOf(node)) {
      usages.push({ key, nodeId: node.id, nodeType: node.type, viaOverride: false });
    }
    for (const key of overrideLocKeys(node)) {
      usages.push({ key, nodeId: node.id, nodeType: node.type, viaOverride: true });
    }
  });
  return usages;
}

/**
 * Every localization key any node contributes per `LOCALIZED_KEYS`, anywhere
 * in the tree (including inside `fallback` and `cellTemplate` subtrees),
 * PLUS any `key`/`labelKey` introduced by an override, deduped in
 * first-seen order.
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
  opts: {
    offeringPackageIds: string[];
    /** Injectable clock for COUNTDOWN_DEADLINE_PAST, so the check does not
     *  depend on the wall clock in tests. Defaults to Date.now. */
    now?: () => number;
  },
): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const offeringSet = new Set(opts.offeringPackageIds);
  const now = opts.now ?? Date.now;

  const nodesWithCtx: Array<{ node: PaywallNode } & NodeWalkContext> = [];
  walkNodes(config.root, (node, ctx) => {
    nodesWithCtx.push({ node, ...ctx });
  });
  const allNodes: PaywallNode[] = nodesWithCtx.map((n) => n.node);

  // Direct children of config.root, computed once — STICKY_FOOTER_NOT_AT_ROOT
  // needs this, and it is cheaper to compute up front than to thread a depth
  // parameter through the existing walk.
  const rootChildIds = new Set(config.root.children.map((c) => c.id));

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

  // UNKNOWN_ICON_NAME — an icon node whose name isn't in the registry, OR a
  // featureList/timeline row whose per-row `icon` isn't either. Both fail
  // open identically (render nothing, on every platform), so this is a typo
  // warning either way — a row icon is not a lesser case than a standalone
  // icon node, since an author picks it per row and is just as likely to
  // typo it there.
  for (const node of allNodes) {
    if (node.type === "icon" && !isKnownIconName(node.name)) {
      issues.push({
        code: "UNKNOWN_ICON_NAME",
        nodeId: node.id,
        message: `Icon "${node.name}" (node "${node.id}") is not in the icon registry — it will render nothing.`,
      });
    }
    if (node.type === "featureList" || node.type === "timeline") {
      for (const row of node.rows) {
        if (row.icon && !isKnownIconName(row.icon)) {
          issues.push({
            code: "UNKNOWN_ICON_NAME",
            nodeId: node.id,
            message: `Icon "${row.icon}" (row in "${node.id}") is not in the icon registry — it will render nothing.`,
          });
        }
      }
    }
  }

  // FEATURE_LIST_TOO_LONG / EMPTY_ROWS — wave B's row-carrying node types.
  for (const node of allNodes) {
    if (node.type === "featureList" && node.rows.length > FEATURE_LIST_SOFT_MAX) {
      issues.push({
        code: "FEATURE_LIST_TOO_LONG",
        nodeId: node.id,
        message: `Feature list "${node.id}" has ${node.rows.length} rows; ${FEATURE_LIST_SOFT_MAX} or fewer converts better.`,
      });
    }
    if ((node.type === "featureList" || node.type === "timeline") && node.rows.length === 0) {
      issues.push({
        code: "EMPTY_ROWS",
        nodeId: node.id,
        message: `"${node.id}" has no rows and will render nothing.`,
      });
    }
  }

  // STICKY_FOOTER_NOT_AT_ROOT / MULTIPLE_STICKY_FOOTERS — wave C.
  //
  // The pinning rule, authoritative for all three renderers: a stickyFooter
  // is pinned when it is a DIRECT child of the root, whatever its position
  // among its siblings; among several such footers, the LAST one wins and
  // the earlier ones fall through to the ordinary dispatcher and render
  // inline. Position among siblings deliberately does not matter for a
  // single footer — an author who drops a footer above a text node still
  // means "pin this", and a pinned bar's own position is the bottom of the
  // screen either way. So the only shape this warns about is a footer that
  // is NOT a direct root child (nested inside a stack, a cellTemplate, a
  // fallback subtree), which really does render inline.
  const stickyFooterNodes = allNodes.filter((n) => n.type === "stickyFooter");
  for (const node of stickyFooterNodes) {
    if (!rootChildIds.has(node.id)) {
      issues.push({
        code: "STICKY_FOOTER_NOT_AT_ROOT",
        nodeId: node.id,
        message: `stickyFooter "${node.id}" is not a direct child of the root — it will render inline, not pinned.`,
      });
    }
  }
  if (stickyFooterNodes.length > 1) {
    issues.push({
      code: "MULTIPLE_STICKY_FOOTERS",
      // Says what actually happens, not merely what is "expected": the
      // author needs to know WHICH one they will see pinned.
      message: `${stickyFooterNodes.length} stickyFooter nodes found; only the last one that is a direct child of the root is pinned — the others render inline.`,
    });
  }

  // COUNTDOWN_NO_DEADLINE / COUNTDOWN_DEADLINE_PAST — wave C.
  for (const node of allNodes) {
    if (node.type !== "countdown") continue;
    if (node.endsAt === undefined && node.durationSeconds === undefined) {
      issues.push({
        code: "COUNTDOWN_NO_DEADLINE",
        nodeId: node.id,
        message: `countdown "${node.id}" has neither endsAt nor durationSeconds, so it cannot render.`,
      });
    }
    if (node.endsAt !== undefined && new Date(node.endsAt).getTime() < now()) {
      issues.push({
        code: "COUNTDOWN_DEADLINE_PAST",
        nodeId: node.id,
        message: `countdown "${node.id}" has endsAt "${node.endsAt}" which is already in the past.`,
      });
    }
  }

  // CAROUSEL_EMPTY / CAROUSEL_SINGLE_PAGE / CAROUSEL_AUTO_ADVANCE_TOO_FAST — wave D1.
  for (const node of allNodes) {
    if (node.type !== "carousel") continue;
    if (node.children.length === 0) {
      issues.push({
        code: "CAROUSEL_EMPTY",
        nodeId: node.id,
        message: `carousel "${node.id}" has no pages, so it cannot render.`,
      });
    } else if (node.children.length === 1) {
      issues.push({
        code: "CAROUSEL_SINGLE_PAGE",
        nodeId: node.id,
        message: `carousel "${node.id}" has only one page; there is nothing to carousel through.`,
      });
    }
    if (node.autoAdvanceSeconds !== undefined && node.autoAdvanceSeconds < CAROUSEL_MIN_AUTO_ADVANCE_SECONDS) {
      issues.push({
        code: "CAROUSEL_AUTO_ADVANCE_TOO_FAST",
        nodeId: node.id,
        message: `carousel "${node.id}" has autoAdvanceSeconds ${node.autoAdvanceSeconds}, below the ${CAROUSEL_MIN_AUTO_ADVANCE_SECONDS}s floor a reader can follow.`,
      });
    }
  }

  // VIDEO_AUTOPLAY_UNMUTED / VIDEO_NO_POSTER — wave D2.
  for (const node of allNodes) {
    if (node.type !== "video") continue;
    const effectiveAutoplay = node.autoplay ?? VIDEO_DEFAULT_AUTOPLAY;
    const effectiveMuted = node.muted ?? VIDEO_DEFAULT_MUTED;
    if (effectiveAutoplay && !effectiveMuted) {
      issues.push({
        code: "VIDEO_AUTOPLAY_UNMUTED",
        nodeId: node.id,
        message: `video "${node.id}" autoplays with sound; browsers refuse to autoplay unmuted video, so it will not actually play automatically.`,
      });
    }
    if (!effectiveAutoplay && node.posterUrl === undefined) {
      issues.push({
        code: "VIDEO_NO_POSTER",
        nodeId: node.id,
        message: `video "${node.id}" does not autoplay and has no posterUrl, so it shows a blank frame until the viewer presses play.`,
      });
    }
  }

  // VIDEO_IN_CAROUSEL_NO_FALLBACK — wave D2. A rule about WHERE the node
  // sits, so it reads the walk's own parent context (exactly as
  // CELL_TEMPLATE_BAD_NODE below does) rather than re-walking the tree.
  for (const { node, insideCarousel } of nodesWithCtx) {
    if (node.type !== "video" || !insideCarousel) continue;
    if (node.fallback === undefined) {
      issues.push({
        code: "VIDEO_IN_CAROUSEL_NO_FALLBACK",
        nodeId: node.id,
        message: `video "${node.id}" is a carousel page with no fallback — a carousel fixes its pages and dots before the video loads, so a video that fails while loading leaves a blank page behind a dot. A fallback fills it.`,
      });
    }
  }

  // LOTTIE_SPEED_OUT_OF_RANGE — wave D2.
  for (const node of allNodes) {
    if (node.type !== "lottie") continue;
    if (node.speed !== undefined && (node.speed < LOTTIE_MIN_SPEED || node.speed > LOTTIE_MAX_SPEED)) {
      issues.push({
        code: "LOTTIE_SPEED_OUT_OF_RANGE",
        nodeId: node.id,
        message: `lottie "${node.id}" has speed ${node.speed}, outside ${LOTTIE_MIN_SPEED}–${LOTTIE_MAX_SPEED} — playback will read as broken rather than stylised.`,
      });
    }
  }

  // EMPTY_MEDIA_URL — Task 8b. image/video/lottie `url`, plus `video.posterUrl`
  // when it's present (an ABSENT posterUrl is VIDEO_NO_POSTER's territory
  // above, unchanged — a node that never carried a poster is a different
  // thing from one whose poster resolves to nothing).
  for (const node of allNodes) {
    if (node.type === "image" || node.type === "video" || node.type === "lottie") {
      pushEmptyMediaUrlIssues(issues, node, "url", node.url);
    }
    if (node.type === "video" && node.posterUrl !== undefined) {
      pushEmptyMediaUrlIssues(issues, node, "posterUrl", node.posterUrl);
    }
  }

  // EMPTY_ACTION_URL — Task 8b. A button's own action, or any footerLinks
  // link's action, that is `{kind:"url", url:""}`.
  for (const node of allNodes) {
    if (node.type === "button" && isEmptyUrlAction(node.action)) {
      issues.push({
        code: "EMPTY_ACTION_URL",
        nodeId: node.id,
        message: `button "${node.id}" has an empty url action — replace the placeholder before publishing.`,
      });
    }
    if (node.type === "footerLinks") {
      for (const link of node.links) {
        if (isEmptyUrlAction(link.action)) {
          issues.push({
            code: "EMPTY_ACTION_URL",
            nodeId: node.id,
            message: `footerLinks "${node.id}" has a link with an empty url action — replace the placeholder before publishing.`,
          });
        }
      }
    }
  }

  const defaultLocaleTable = config.localizations[config.defaultLocale] ?? {};

  // UNKNOWN_LOC_KEY — text/button/purchaseButton key (base or override-provided)
  // missing from defaultLocale.
  for (const node of allNodes) {
    const keysToCheck: string[] = [];
    keysToCheck.push(...localizedKeysOf(node));
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
    // `OVERRIDABLE_PROP_KEYS[node.type]` is now a union of per-type literal
    // tuples (schema.ts's `as const satisfies`, Task 1), not `readonly
    // string[]` — indexing by the unnarrowed `node.type` yields a union of
    // specific literal keys across every node type, not a general string
    // array. `propKey` below is a plain `string` off `Object.keys`, so the
    // Set's element type is widened back to `string` explicitly here — a
    // type-only annotation, `allowed`'s actual members are unchanged.
    const allowed = new Set<string>(OVERRIDABLE_PROP_KEYS[node.type]);
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
