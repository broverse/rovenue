import { z } from "zod";
import type { NodeVisibility } from "./visibility";

// =============================================================
// Paywall builder-config schema — the wire format the dashboard's
// visual paywall builder saves/loads and the web renderer (a later
// task in this phase) reads. Node tree is a discriminated union on
// `type`; every node carries `id: string` and an optional
// `fallback?: PaywallNode` (rendered when the primary node can't be,
// e.g. a remote image failing to load, or a condition not met later).
//
// This is the cross-task contract: React renderer, dashboard builder
// VM, and API validation all import types + `builderConfigSchema`
// from `@rovenue/shared/paywall`.
// =============================================================

export type ThemeColor = { light: string; dark?: string };

export type NodeSize = "fit" | "fill" | number;

// -------------------------------------------------------------
// Overrides (Phase D2) — conditional prop swaps evaluated at render
// time. Every node type gains an optional `overrides` array; only
// the node's own OPTIONAL VISUAL fields are overridable (see
// `OVERRIDABLE_PROP_KEYS` below) — structural fields (type, id,
// children, axis, packageIds, defaultSelected, cellLayout, action,
// url, size, padding, cellTemplate) are never overridable.
// -------------------------------------------------------------

export type OverrideCondition = { kind: "introEligible" } | { kind: "selected" };

export type NodeOverride = { when: OverrideCondition; props: Record<string, unknown> };

export type StackNode = {
  type: "stack";
  id: string;
  axis: "v" | "h" | "z";
  children: PaywallNode[];
  spacing?: number;
  align?: "start" | "center" | "end";
  padding?: { t?: number; r?: number; b?: number; l?: number };
  size?: { width?: NodeSize; height?: NodeSize };
  background?: ThemeColor;
  cornerRadius?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type TextNode = {
  type: "text";
  id: string;
  key: string;
  role: "title" | "subtitle" | "body" | "caption";
  color?: ThemeColor;
  align?: "start" | "center" | "end";
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type ImageNode = {
  type: "image";
  id: string;
  url: { light: string; dark?: string };
  height?: number;
  cornerRadius?: number;
  alt?: string;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type ButtonNode = {
  type: "button";
  id: string;
  labelKey: string;
  style: "primary" | "secondary" | "plain";
  action: { kind: "close" } | { kind: "url"; url: string } | { kind: "restore" };
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type PackageListNode = {
  type: "packageList";
  id: string;
  packageIds: string[];
  defaultSelected?: string;
  cellLayout: "row" | "column";
  /**
   * Optional subtree rendered once per effective package, with
   * cell-scoped variables, replacing the built-in (name + price)
   * cell. Absent → current built-in cell (backward compatible).
   * `packageList`/`purchaseButton` nodes are invalid anywhere inside
   * this subtree — enforced by the validator (CELL_TEMPLATE_BAD_NODE),
   * not the schema, since the shape is a normal PaywallNode.
   */
  cellTemplate?: PaywallNode;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type PurchaseButtonNode = {
  type: "purchaseButton";
  id: string;
  labelKey: string;
  /** Shown instead of `labelKey` when the selected package's trial/intro
   *  period is active (see `resolveCtaLabelKey` in variables.ts). Absent =
   *  always `labelKey`. */
  trialLabelKey?: string;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

export type SpacerNode = {
  type: "spacer";
  id: string;
  size?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  /** Which platforms / app versions this node renders on. Absent = everywhere. */
  visibility?: NodeVisibility;
};

/** Default hairline thickness, in device-independent pixels. */
export const DIVIDER_DEFAULT_THICKNESS = 1;
/** Default horizontal inset, in device-independent pixels. */
export const DIVIDER_DEFAULT_INSET = 0;
/** Default icon edge length, in device-independent pixels. */
export const ICON_DEFAULT_SIZE = 24;
/** Drawn when a divider has no `color`. A hairline rule, not body text —
 *  the web renderer previously reached for the TEXT colour helper and drew
 *  an opaque near-black bar. */
export const DIVIDER_DEFAULT_COLOR = { light: "#E5E7EB", dark: "#374151" } as const;

export type DividerNode = {
  type: "divider";
  id: string;
  color?: ThemeColor;
  /** Defaults to DIVIDER_DEFAULT_THICKNESS. */
  thickness?: number;
  /** Horizontal inset on both sides. Defaults to DIVIDER_DEFAULT_INSET. */
  inset?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type IconNode = {
  type: "icon";
  id: string;
  /** A name from icon-registry.json. Deliberately a free string: unknown
   *  names render nothing and fail open, so adding an icon later is not a
   *  wire change older SDKs reject. */
  name: string;
  /** Defaults to ICON_DEFAULT_SIZE. */
  size?: number;
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

/** A feature row with no icon, when it is included. */
export const FEATURE_ROW_DEFAULT_ICON = "check";
/** A feature row with no icon, when `included` is false. */
export const FEATURE_ROW_EXCLUDED_ICON = "x";
export const FEATURE_ROW_DEFAULT_INCLUDED = true;
/** Beyond this many rows a feature list stops converting well — a warning,
 *  never a block. */
export const FEATURE_LIST_SOFT_MAX = 6;
export const TIMELINE_ROW_DEFAULT_ICON = "clock";
/** The connector between timeline steps is the same hairline as a divider. */
export const TIMELINE_CONNECTOR_DEFAULT_COLOR = DIVIDER_DEFAULT_COLOR;
export const SOCIAL_PROOF_STAR_DEFAULT_COLOR = { light: "#F59E0B", dark: "#FBBF24" } as const;
export const SOCIAL_PROOF_MAX_RATING = 5;

/** A countdown past its deadline holds at zero rather than vanishing —
 *  hiding it collapses whatever space it occupied, which is a layout jump
 *  as the out-of-the-box behaviour. */
export const COUNTDOWN_DEFAULT_ON_EXPIRY = "freeze" as const;
/** Tick interval, identical on all three platforms. */
export const COUNTDOWN_TICK_MS = 1000;
/**
 * Storage-key prefix for a `durationSeconds` countdown's persisted
 * "first shown to this user" anchor. The full key is this prefix plus the
 * paywall identifier (an absent identifier collapsing to the empty suffix),
 * so ONE anchor is shared by every countdown node on the same paywall.
 *
 * Cross-platform by value, not by import: iOS writes it into `UserDefaults`
 * (`RovenuePaywallView.swift`), Android into `SharedPreferences`
 * (`NodeViewFactory.kt`), the web into `localStorage`
 * (`@rovenue/paywall-renderer`'s `resolvePersistedFirstShownAt`). Both
 * native copies are hand-mirrored string literals — keep them in sync with
 * this one, or the same paywall anchors differently per platform.
 */
export const COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX = "rovenue.paywall.countdown.firstShownAt.";
export const STICKY_FOOTER_DEFAULT_BACKGROUND = { light: "#FFFFFF", dark: "#111827" } as const;
/**
 * Bottom clearance the scrolled content reserves for a pinned sticky footer
 * BEFORE the footer's real height has been measured — a pre-measurement
 * placeholder, never the final value: every renderer measures the footer and
 * replaces this the moment it can (web `ResizeObserver`, SwiftUI
 * `GeometryReader` overlay preference, Android the footer's laid-out height).
 *
 * A static guess is wrong the instant the footer is taller than it (a CTA
 * plus fine print routinely is), leaving the last scrolled item unreachable —
 * the same class of bug as no scrolling at all. So it exists only to keep
 * the very first frame from being obviously wrong, and the three platforms
 * agree on it purely so that first frame looks identical.
 *
 * Cross-platform by value, not by import, exactly like
 * COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX: `px` on the web (imported from here by
 * `@rovenue/paywall-renderer`), `pt` in `RovenuePaywallView.swift`, `dp` in
 * `NodeViewFactory.kt`. Both native copies are hand-mirrored literals — this
 * constant is mirrored into `render-fixtures.json`'s `defaults` so the
 * native by-value sync tests can catch drift.
 */
export const STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT = 96;

export type FeatureRow = {
  labelKey: string;
  /** Registry icon name; unknown names fail open like any icon. */
  icon?: string;
  /** Defaults to FEATURE_ROW_DEFAULT_INCLUDED. */
  included?: boolean;
};

export type FeatureListNode = {
  type: "featureList";
  id: string;
  rows: FeatureRow[];
  /** Applied to each row's icon that does not carry its own. Absent = inherit. */
  iconColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type TimelineRow = {
  labelKey: string;
  captionKey?: string;
  icon?: string;
};

export type TimelineNode = {
  type: "timeline";
  id: string;
  rows: TimelineRow[];
  /** Absent = TIMELINE_CONNECTOR_DEFAULT_COLOR. */
  connectorColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type SocialProofNode = {
  type: "socialProof";
  id: string;
  /** 0…SOCIAL_PROOF_MAX_RATING. Absent renders no stars at all. */
  rating?: number;
  labelKey: string;
  /** Absent = SOCIAL_PROOF_STAR_DEFAULT_COLOR. */
  starColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type StickyFooterNode = {
  type: "stickyFooter";
  id: string;
  children: PaywallNode[];
  /** Absent = STICKY_FOOTER_DEFAULT_BACKGROUND. A pinned bar needs an
   *  opaque background or the content scrolls visibly beneath it. */
  background?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type CountdownNode = {
  type: "countdown";
  id: string;
  /** ISO-8601 absolute deadline. Mutually exclusive with durationSeconds. */
  endsAt?: string;
  /** Seconds from this paywall's first show to this user, persisted.
   *  Mutually exclusive with endsAt. */
  durationSeconds?: number;
  /** Absent = COUNTDOWN_DEFAULT_ON_EXPIRY. */
  onExpiry?: "freeze" | "hide";
  labelKey?: string;
  /** Absent = inherit the ambient text colour. */
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type PaywallNode =
  | StackNode
  | TextNode
  | ImageNode
  | ButtonNode
  | PackageListNode
  | PurchaseButtonNode
  | SpacerNode
  | DividerNode
  | IconNode
  | FeatureListNode
  | TimelineNode
  | SocialProofNode
  | StickyFooterNode
  | CountdownNode;

/**
 * Per node-type whitelist of override-able prop keys — the node's own
 * OPTIONAL visual fields only. Used by both the strict authoring schema
 * (rejects any other key at parse time) and the validator's defensive
 * re-check (`OVERRIDE_BAD_PROP`) on already-parsed configs.
 */
export const OVERRIDABLE_PROP_KEYS: Record<PaywallNode["type"], readonly string[]> = {
  stack: ["spacing", "align", "background", "cornerRadius"],
  text: ["key", "color", "align"],
  image: ["cornerRadius"],
  button: ["labelKey", "style"],
  packageList: [],
  purchaseButton: ["labelKey", "trialLabelKey"],
  spacer: [],
  divider: ["color", "thickness"],
  icon: ["name", "color"],
  featureList: ["iconColor"],
  timeline: ["connectorColor"],
  socialProof: ["rating", "starColor"],
  stickyFooter: ["background"],
  countdown: ["color"],
};

export type BuilderConfig = {
  formatVersion: 2;
  defaultLocale: string;
  localizations: Record<string, Record<string, string>>;
  background?: ThemeColor;
  root: StackNode;
};

// -------------------------------------------------------------
// Zod schemas. The node union is recursive (stack.children +
// every node's `fallback`), so it's built with z.lazy. TS strict
// mode can't infer the recursive type from z.lazy alone, so each
// piece is annotated with an explicit z.ZodType<T> — a plain
// `z.infer` on a lazy union degrades to `any`/loses precision.
// -------------------------------------------------------------

const themeColorSchema: z.ZodType<ThemeColor> = z.object({
  light: z.string(),
  dark: z.string().optional(),
});

const nodeSizeSchema: z.ZodType<NodeSize> = z.union([
  z.literal("fit"),
  z.literal("fill"),
  z.number(),
]);

// `paywallNodeSchema` is defined below via z.lazy once all node
// schemas exist, then wired back in as `fallback` on each of them.
let paywallNodeSchemaRef: z.ZodType<PaywallNode>;
const lazyPaywallNodeSchema: z.ZodType<PaywallNode> = z.lazy(() => paywallNodeSchemaRef);

const overrideConditionSchema: z.ZodType<OverrideCondition> = z.union([
  z.object({ kind: z.literal("introEligible") }),
  z.object({ kind: z.literal("selected") }),
]);

/**
 * Builds the strict `overrides` array schema for one node type: `when.kind`
 * restricted to the two known literals (via `overrideConditionSchema`),
 * `props` keys restricted to that type's own optional visual fields —
 * any other key (including structural fields) fails the parse.
 */
function overridesArraySchema(allowedKeys: readonly string[]): z.ZodType<NodeOverride[]> {
  const allowed = new Set(allowedKeys);
  const propsSchema: z.ZodType<Record<string, unknown>> = z
    .record(z.string(), z.unknown())
    .superRefine((props, ctx) => {
      for (const key of Object.keys(props)) {
        if (!allowed.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${key}" is not an overridable prop for this node type.`,
            path: [key],
          });
        }
      }
    });
  return z.array(
    z.object({
      when: overrideConditionSchema,
      props: propsSchema,
    }),
  );
}

const nodeVisibilitySchema = z.object({
  platform: z.array(z.enum(["ios", "android", "web"])).optional(),
  minAppVersion: z.string().optional(),
  maxAppVersion: z.string().optional(),
});

const stackNodeSchema: z.ZodType<StackNode> = z.object({
  type: z.literal("stack"),
  id: z.string().min(1),
  axis: z.enum(["v", "h", "z"]),
  children: z.lazy(() => z.array(lazyPaywallNodeSchema)),
  spacing: z.number().optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  padding: z
    .object({
      t: z.number().optional(),
      r: z.number().optional(),
      b: z.number().optional(),
      l: z.number().optional(),
    })
    .optional(),
  size: z
    .object({
      width: nodeSizeSchema.optional(),
      height: nodeSizeSchema.optional(),
    })
    .optional(),
  background: themeColorSchema.optional(),
  cornerRadius: z.number().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.stack).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const textNodeSchema: z.ZodType<TextNode> = z.object({
  type: z.literal("text"),
  id: z.string().min(1),
  key: z.string(),
  role: z.enum(["title", "subtitle", "body", "caption"]),
  color: themeColorSchema.optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.text).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const imageNodeSchema: z.ZodType<ImageNode> = z.object({
  type: z.literal("image"),
  id: z.string().min(1),
  url: z.object({ light: z.string(), dark: z.string().optional() }),
  height: z.number().optional(),
  cornerRadius: z.number().optional(),
  alt: z.string().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.image).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const buttonActionSchema: z.ZodType<ButtonNode["action"]> = z.union([
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("url"), url: z.string() }),
  z.object({ kind: z.literal("restore") }),
]);

const buttonNodeSchema: z.ZodType<ButtonNode> = z.object({
  type: z.literal("button"),
  id: z.string().min(1),
  labelKey: z.string(),
  style: z.enum(["primary", "secondary", "plain"]),
  action: buttonActionSchema,
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.button).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const packageListNodeSchema: z.ZodType<PackageListNode> = z.object({
  type: z.literal("packageList"),
  id: z.string().min(1),
  packageIds: z.array(z.string()),
  defaultSelected: z.string().optional(),
  cellLayout: z.enum(["row", "column"]),
  cellTemplate: lazyPaywallNodeSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.packageList).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const purchaseButtonNodeSchema: z.ZodType<PurchaseButtonNode> = z.object({
  type: z.literal("purchaseButton"),
  id: z.string().min(1),
  labelKey: z.string(),
  trialLabelKey: z.string().min(1).optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.purchaseButton).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const spacerNodeSchema: z.ZodType<SpacerNode> = z.object({
  type: z.literal("spacer"),
  id: z.string().min(1),
  size: z.number().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.spacer).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const dividerNodeSchema: z.ZodType<DividerNode> = z.object({
  type: z.literal("divider"),
  id: z.string().min(1),
  color: themeColorSchema.optional(),
  thickness: z.number().optional(),
  inset: z.number().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.divider).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const iconNodeSchema: z.ZodType<IconNode> = z.object({
  type: z.literal("icon"),
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().optional(),
  color: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.icon).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const featureRowSchema: z.ZodType<FeatureRow> = z.object({
  labelKey: z.string().min(1),
  icon: z.string().min(1).optional(),
  included: z.boolean().optional(),
});

const featureListNodeSchema: z.ZodType<FeatureListNode> = z.object({
  type: z.literal("featureList"),
  id: z.string().min(1),
  rows: z.array(featureRowSchema),
  iconColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.featureList).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const timelineRowSchema: z.ZodType<TimelineRow> = z.object({
  labelKey: z.string().min(1),
  captionKey: z.string().min(1).optional(),
  icon: z.string().min(1).optional(),
});

const timelineNodeSchema: z.ZodType<TimelineNode> = z.object({
  type: z.literal("timeline"),
  id: z.string().min(1),
  rows: z.array(timelineRowSchema),
  connectorColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.timeline).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const socialProofNodeSchema: z.ZodType<SocialProofNode> = z.object({
  type: z.literal("socialProof"),
  id: z.string().min(1),
  rating: z.number().min(0).max(SOCIAL_PROOF_MAX_RATING).optional(),
  labelKey: z.string().min(1),
  starColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.socialProof).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const stickyFooterNodeSchema: z.ZodType<StickyFooterNode> = z.object({
  type: z.literal("stickyFooter"),
  id: z.string().min(1),
  children: z.lazy(() => z.array(lazyPaywallNodeSchema)),
  background: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.stickyFooter).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const countdownNodeSchema: z.ZodType<CountdownNode> = z
  .object({
    type: z.literal("countdown"),
    id: z.string().min(1),
    endsAt: z.string().datetime().optional(),
    durationSeconds: z.number().positive().optional(),
    onExpiry: z.enum(["freeze", "hide"]).optional(),
    labelKey: z.string().min(1).optional(),
    color: themeColorSchema.optional(),
    overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.countdown).optional(),
    fallback: lazyPaywallNodeSchema.optional(),
    visibility: nodeVisibilitySchema.optional(),
  })
  // Both is ambiguous; NEITHER is allowed so a half-authored node still
  // saves — the validator blocks the publish instead.
  .refine((n) => !(n.endsAt !== undefined && n.durationSeconds !== undefined), {
    message: "endsAt and durationSeconds are mutually exclusive",
  });

const paywallNodeSchema: z.ZodType<PaywallNode> = z.union([
  stackNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  buttonNodeSchema,
  packageListNodeSchema,
  purchaseButtonNodeSchema,
  spacerNodeSchema,
  dividerNodeSchema,
  iconNodeSchema,
  featureListNodeSchema,
  timelineNodeSchema,
  socialProofNodeSchema,
  stickyFooterNodeSchema,
  countdownNodeSchema,
]);
paywallNodeSchemaRef = paywallNodeSchema;

export const MAX_BUILDER_DEPTH = 32;
export const MAX_BUILDER_NODES = 500;

/**
 * Iterative (explicit-stack) walk over a raw candidate builder-config,
 * counting node-ish objects and tracking depth via `children` arrays and
 * `fallback` objects. Runs on UNVALIDATED input, so it treats any object as
 * a potential node — an over-count is fine (limits are generous), the point
 * is that this function itself can never blow the call stack.
 */
export function measureNodeTree(raw: unknown): { depth: number; nodes: number } {
  const root = (raw as { root?: unknown } | null)?.root;
  if (typeof root !== "object" || root === null) return { depth: 0, nodes: 0 };
  let nodes = 0;
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== "object" || value === null) continue;
    nodes += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (nodes > MAX_BUILDER_NODES || depth > MAX_BUILDER_DEPTH) break;
    const node = value as { children?: unknown; fallback?: unknown };
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push({ value: child, depth: depth + 1 });
    }
    if (typeof node.fallback === "object" && node.fallback !== null) {
      stack.push({ value: node.fallback, depth: depth + 1 });
    }
  }
  return { depth: maxDepth, nodes };
}

export const builderConfigSchema: z.ZodType<BuilderConfig> = z.object({
  formatVersion: z.literal(2),
  defaultLocale: z.string().min(1),
  localizations: z.record(z.string(), z.record(z.string(), z.string())),
  background: themeColorSchema.optional(),
  root: stackNodeSchema,
});

/** A minimal, schema-valid starting point for a new paywall in the builder. */
export function emptyBuilderConfig(defaultLocale = "en"): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale,
    localizations: { [defaultLocale]: {} },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [],
    },
  };
}
