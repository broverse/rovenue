import type { CSSProperties } from "react";
import type { NodeBorder, NodeSize, StackNode, ThemeColor } from "@rovenue/shared/paywall";

// =============================================================
// Pure style-computation helpers. No CSS framework — every node
// renders with inline styles only (spec constraint).
// =============================================================

/** Resolve a `{light, dark?}` theme pair against the active colorScheme. Missing dark -> light. */
export function resolveThemeColor(
  color: ThemeColor | undefined,
  colorScheme: "light" | "dark",
): string | undefined {
  if (!color) return undefined;
  if (colorScheme === "dark") return color.dark ?? color.light;
  return color.light;
}

/**
 * Ink used for text the config leaves uncoloured.
 *
 * The renderer paints its own backgrounds, so it must own its own text
 * colour too: with no explicit `color`, text would inherit the HOST page's
 * colour, and a host whose ambient colour is light (a dark-themed app
 * embedding a light paywall — e.g. the dashboard's builder canvas) renders
 * white-on-white. Found by a browser smoke of the builder, where every
 * uncoloured node was invisible in the light preview.
 */
const DEFAULT_INK: Record<"light" | "dark", string> = {
  light: "#0F172A",
  dark: "#F8FAFC",
};

/** Configured colour for this scheme, else the self-contained default ink. */
export function resolveTextColor(
  color: ThemeColor | undefined,
  colorScheme: "light" | "dark",
): string {
  return resolveThemeColor(color, colorScheme) ?? DEFAULT_INK[colorScheme];
}

/** Resolve a `{light, dark?}` image URL pair against the active colorScheme. Missing dark -> light. */
export function resolveThemeUrl(
  url: { light: string; dark?: string },
  colorScheme: "light" | "dark",
): string {
  if (colorScheme === "dark") return url.dark ?? url.light;
  return url.light;
}

// =============================================================
// Node style pass (border / background / labelColor / cornerRadius, spec
// 2026-07-29). All additive: every helper below returns exactly what the
// pre-existing call sites produced when the new props are absent, which is
// the regression pin this wave requires on every platform.
// =============================================================

/**
 * CSS `border` shorthand for a `NodeBorder` — always drawn INSIDE the node's
 * own `cornerRadius` (spec: standard CSS box-model already does this, so no
 * extra clipping is needed here). `NodeBorder`'s own doc comment is why both
 * fields are read together rather than independently: a border with only a
 * width or only a color would render nothing meaningful, so the type makes
 * that state unrepresentable and this helper has nothing to guard against.
 * Absent `border` -> undefined, i.e. no CSS `border` instruction at all,
 * which is today's output on every node type that gains this prop.
 */
export function borderStyle(
  border: NodeBorder | undefined,
  colorScheme: "light" | "dark",
): string | undefined {
  if (!border) return undefined;
  return `${border.width}px solid ${resolveThemeColor(border.color, colorScheme)}`;
}

/** A text node's optional badge/chip fill — background + cornerRadius, the
 *  only two props `TextNode` gains (spec: no padding). Absent background AND
 *  absent cornerRadius resolve to `{ backgroundColor: undefined, borderRadius:
 *  undefined }`, i.e. no style instruction at all — today's output. */
export function textBadgeStyle(
  background: ThemeColor | undefined,
  cornerRadius: number | undefined,
  colorScheme: "light" | "dark",
): CSSProperties {
  return {
    backgroundColor: resolveThemeColor(background, colorScheme),
    borderRadius: cornerRadius !== undefined ? `${cornerRadius}px` : undefined,
  };
}

/** The visual a button/purchaseButton draws before any of its own custom
 *  style props are considered — for `button` this is `BUTTON_STYLE_BASE[node
 *  .style]`, for `purchaseButton` (which has no variant) a single fixed
 *  visual. Both live in nodes.tsx, next to the JSX that consumes them. */
export type ButtonBaseVisual = { background?: string; color: string; border: string };

/** The subset of `ButtonNode`/`PurchaseButtonNode` this wave added — passed
 *  in directly from the node object, which is structurally a superset. */
export type ButtonCustomStyleProps = {
  background?: ThemeColor;
  labelColor?: ThemeColor;
  border?: NodeBorder;
  cornerRadius?: number;
};

/**
 * Merge a button's variant/base visual with its own optional custom style
 * props. Custom always wins; an absent custom prop leaves the base's own
 * value untouched — which is the regression pin: a button/purchaseButton
 * with none of the new props set produces exactly `{ background: base
 * .background, color: base.color, border: base.border, borderRadius:
 * `${defaultCornerRadiusPx}px` }`, byte-identical to what nodes.tsx used to
 * inline directly.
 */
export function resolveButtonVisualStyle(
  base: ButtonBaseVisual,
  custom: ButtonCustomStyleProps,
  defaultCornerRadiusPx: number,
  colorScheme: "light" | "dark",
): CSSProperties {
  return {
    background: resolveThemeColor(custom.background, colorScheme) ?? base.background,
    color: resolveThemeColor(custom.labelColor, colorScheme) ?? base.color,
    border: borderStyle(custom.border, colorScheme) ?? base.border,
    borderRadius: `${custom.cornerRadius ?? defaultCornerRadiusPx}px`,
  };
}

/** Product decision (2026-07-29): a plain `button` with no `cornerRadius`
 *  renders SQUARE — authors opt into rounding. (Both button types drew a
 *  hardcoded `"8px"` before `cornerRadius` existed; `purchaseButton` keeps
 *  that look via its own constant below.) */
export const NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX = 0;
/** `purchaseButton`'s pre-existing chip radius — deliberately NOT flipped to
 *  0 with the button default above: the purchase CTA keeps its rounded look
 *  unless a `cornerRadius` explicitly overrides it. */
export const PURCHASE_BUTTON_DEFAULT_CORNER_RADIUS_PX = 8;

function nodeSizeToCss(size: NodeSize | undefined): string | undefined {
  if (size === undefined || size === "fit") return undefined;
  if (size === "fill") return "100%";
  return `${size}px`;
}

const ALIGN_TO_FLEX: Record<"start" | "center" | "end", CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

/** Container styles for a stack node: axis v/h drive flex, z is a single-cell grid overlay. */
export function stackContainerStyle(
  node: Pick<
    StackNode,
    "axis" | "spacing" | "align" | "padding" | "size" | "background" | "cornerRadius" | "border"
  >,
  colorScheme: "light" | "dark",
): CSSProperties {
  const style: CSSProperties = {
    boxSizing: "border-box",
    width: nodeSizeToCss(node.size?.width),
    height: nodeSizeToCss(node.size?.height),
    gap: node.spacing !== undefined ? `${node.spacing}px` : undefined,
    paddingTop: node.padding?.t !== undefined ? `${node.padding.t}px` : undefined,
    paddingRight: node.padding?.r !== undefined ? `${node.padding.r}px` : undefined,
    paddingBottom: node.padding?.b !== undefined ? `${node.padding.b}px` : undefined,
    paddingLeft: node.padding?.l !== undefined ? `${node.padding.l}px` : undefined,
    backgroundColor: resolveThemeColor(node.background, colorScheme),
    borderRadius: node.cornerRadius !== undefined ? `${node.cornerRadius}px` : undefined,
    border: borderStyle(node.border, colorScheme),
  };

  if (node.axis === "z") {
    style.display = "grid";
    if (node.align) {
      style.alignItems = ALIGN_TO_FLEX[node.align];
      style.justifyItems = ALIGN_TO_FLEX[node.align];
    }
  } else {
    style.display = "flex";
    style.flexDirection = node.axis === "h" ? "row" : "column";
    if (node.align) style.alignItems = ALIGN_TO_FLEX[node.align];
  }

  return style;
}

/** Every direct child of a z-axis stack shares grid cell (1,1) to overlay. */
export const Z_OVERLAY_CHILD_STYLE: CSSProperties = {
  gridColumn: "1 / 1",
  gridRow: "1 / 1",
};

// =============================================================
// Video (spec §6, wave D2). The renderer draws a plain `<video>` element and
// drives it via the element itself (`play()`/`pause()`) — see `Video` in
// nodes.tsx — this file only owns the element's static style.
// =============================================================

/** A video always fills the width of its slot; height and only aspectRatio
 *  ever constrain the vertical dimension, matching `renderImage`'s own
 *  `maxWidth: "100%"`. */
export const VIDEO_WIDTH_CSS = "100%";

/**
 * Fit the whole frame inside the slot, letterboxing rather than cropping, so
 * a configured `aspectRatio` that disagrees with the source's intrinsic one
 * never cuts content off. This is also the UA default for `<video>` — but
 * DECLARED, not inherited: a host stylesheet with a broad
 * `video { object-fit: cover }` (or a `* { object-fit: ... }` reset) would
 * otherwise silently flip web to cropping and break the three-platform
 * agreement with iOS's `.resizeAspect` / `.scaledToFit` and Android's
 * `RESIZE_MODE_FIT`. An inline element style outranks any host rule short of
 * `!important`, and this is asserted in the renderer tests.
 */
export const VIDEO_OBJECT_FIT_CSS = "contain";

/**
 * Style for the `<video>` element. `aspectRatio` is passed through ONLY when
 * the node configures one — an absent `aspectRatio` must set no CSS ratio at
 * all, letting the source's own intrinsic dimensions govern (spec §6.1: never
 * substitute a number here, not even a "sensible" default like 16/9).
 */
export function videoStyle(aspectRatio: number | undefined): CSSProperties {
  return {
    display: "block",
    width: VIDEO_WIDTH_CSS,
    objectFit: VIDEO_OBJECT_FIT_CSS,
    aspectRatio: aspectRatio !== undefined ? String(aspectRatio) : undefined,
  };
}

// =============================================================
// Carousel (spec §3, wave D1). Paging is CSS scroll-snap, never JS
// scroll maths — the track opts into native snapping and each page
// opts into a snap stop; the browser owns the animation, the
// renderer only owns which page is "current" for the dots.
// =============================================================

/** Each page occupies the WHOLE track width — one page visible at a time,
 *  matching `TabView`'s one-page-per-screen on iOS and `ViewPager2` on
 *  Android (spec §3.1). */
export const CAROUSEL_PAGE_FLEX_BASIS = "100%";
/** `x mandatory`: paging always settles on a snap point after a drag or a
 *  programmatic scroll, on the horizontal axis only. */
export const CAROUSEL_TRACK_SCROLL_SNAP_TYPE = "x mandatory";
/** Each page is its own snap stop, centered in the track. */
export const CAROUSEL_PAGE_SCROLL_SNAP_ALIGN = "center";

/** Filled-circle diameter for a single page dot. */
export const CAROUSEL_DOT_SIZE_PX = 8;
/** Gap between adjacent dots in the indicator row. */
export const CAROUSEL_DOT_GAP_PX = 8;
/** A perfect circle, independent of `CAROUSEL_DOT_SIZE_PX`. */
export const CAROUSEL_DOT_BORDER_RADIUS = "50%";
/** Full opacity for the dot marking the current page. */
export const CAROUSEL_DOT_ACTIVE_OPACITY = 1;
/** Dimmed opacity for every other dot — visibly present, clearly not current. */
export const CAROUSEL_DOT_INACTIVE_OPACITY = 0.3;

/**
 * A page dot's own style. `color` is always a RESOLVED value by the time it
 * reaches here — see the call site in `Carousel` (I1): an absent
 * `indicatorColor` is substituted with the paywall's own ink via
 * `resolveTextColor`, the same substitution `Countdown` makes for its own
 * uncoloured case, rather than left as an `undefined` pass-through for
 * `currentColor` to resolve against whatever the embedding page happens to
 * have. Spec §3.2 calls out a real regression this "leave it uninstructed"
 * shape already caused once (wave B's Kotlin drew from a stale vendored
 * asset instead of truly inheriting), so a test must check the RESOLVED
 * colour, not the mere presence or absence of an inline instruction on this
 * element.
 */
export function carouselDotStyle(active: boolean, color: string): CSSProperties {
  return {
    width: `${CAROUSEL_DOT_SIZE_PX}px`,
    height: `${CAROUSEL_DOT_SIZE_PX}px`,
    borderRadius: CAROUSEL_DOT_BORDER_RADIUS,
    flexShrink: 0,
    backgroundColor: "currentColor",
    color,
    opacity: active ? CAROUSEL_DOT_ACTIVE_OPACITY : CAROUSEL_DOT_INACTIVE_OPACITY,
  };
}
