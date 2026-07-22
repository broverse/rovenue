import { z } from "zod";

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
};

export type ButtonNode = {
  type: "button";
  id: string;
  labelKey: string;
  style: "primary" | "secondary" | "plain";
  action: { kind: "close" } | { kind: "url"; url: string } | { kind: "restore" };
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
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
};

export type PurchaseButtonNode = {
  type: "purchaseButton";
  id: string;
  labelKey: string;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
};

export type SpacerNode = {
  type: "spacer";
  id: string;
  size?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
};

export type PaywallNode =
  | StackNode
  | TextNode
  | ImageNode
  | ButtonNode
  | PackageListNode
  | PurchaseButtonNode
  | SpacerNode;

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
  purchaseButton: ["labelKey"],
  spacer: [],
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
});

const purchaseButtonNodeSchema: z.ZodType<PurchaseButtonNode> = z.object({
  type: z.literal("purchaseButton"),
  id: z.string().min(1),
  labelKey: z.string(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.purchaseButton).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
});

const spacerNodeSchema: z.ZodType<SpacerNode> = z.object({
  type: z.literal("spacer"),
  id: z.string().min(1),
  size: z.number().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.spacer).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
});

const paywallNodeSchema: z.ZodType<PaywallNode> = z.union([
  stackNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  buttonNodeSchema,
  packageListNodeSchema,
  purchaseButtonNodeSchema,
  spacerNodeSchema,
]);
paywallNodeSchemaRef = paywallNodeSchema;

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
