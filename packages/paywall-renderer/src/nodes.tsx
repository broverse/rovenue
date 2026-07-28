import { Fragment, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  ArrowRight, Check, Clock, Cloud, Gift, Infinity as InfinityIcon,
  Lock, Shield, Sparkles, Star, X, Zap, type LucideIcon,
} from "lucide-react";
import {
  applyOverrides,
  iconRegistry,
  isNodeVisible,
  resolveText,
  resolveCtaLabelKey,
  resolveVariables,
  ICON_DEFAULT_SIZE,
  CAROUSEL_DEFAULT_LOOP,
  CAROUSEL_DEFAULT_SHOWS_INDICATOR,
  COUNTDOWN_DEFAULT_ON_EXPIRY,
  COUNTDOWN_TICK_MS,
  DIVIDER_DEFAULT_COLOR,
  DIVIDER_DEFAULT_INSET,
  DIVIDER_DEFAULT_THICKNESS,
  FEATURE_ROW_DEFAULT_ICON,
  FEATURE_ROW_DEFAULT_INCLUDED,
  FEATURE_ROW_EXCLUDED_ICON,
  LOTTIE_DEFAULT_AUTOPLAY,
  LOTTIE_DEFAULT_LOOP,
  LOTTIE_DEFAULT_SPEED,
  SOCIAL_PROOF_MAX_RATING,
  SOCIAL_PROOF_STAR_DEFAULT_COLOR,
  STICKY_FOOTER_DEFAULT_BACKGROUND,
  TIMELINE_CONNECTOR_DEFAULT_COLOR,
  TIMELINE_ROW_DEFAULT_ICON,
  VIDEO_DEFAULT_AUTOPLAY,
  VIDEO_DEFAULT_LOOP,
  VIDEO_DEFAULT_MUTED,
  VIDEO_DEFAULT_SHOWS_CONTROLS,
  type BuilderConfig,
  type ButtonNode,
  type CarouselNode,
  type CountdownNode,
  type DividerNode,
  type FeatureListNode,
  type IconNode,
  type ImageNode,
  type LottieNode,
  type PackageListNode,
  type PackageView,
  type PaywallNode,
  type PurchaseButtonNode,
  type SocialProofNode,
  type SpacerNode,
  type StackNode,
  type StickyFooterNode,
  type TextNode,
  type TimelineNode,
  type VideoNode,
  type VisibilityPlatform,
} from "@rovenue/shared/paywall";
import type { RendererOffering } from "./types";
import {
  CAROUSEL_DOT_GAP_PX,
  CAROUSEL_PAGE_FLEX_BASIS,
  CAROUSEL_PAGE_SCROLL_SNAP_ALIGN,
  CAROUSEL_TRACK_SCROLL_SNAP_TYPE,
  carouselDotStyle,
  resolveTextColor,
  resolveThemeColor,
  resolveThemeUrl,
  stackContainerStyle,
  videoStyle,
  Z_OVERLAY_CHILD_STYLE,
} from "./styles";
import { useNodeVisible } from "./visibility";

// Registry web names -> the imported components. Built from the registry so
// a name added there without a component here is a visible undefined rather
// than a silently missing icon.
const LUCIDE_BY_EXPORT: Record<string, LucideIcon> = {
  ArrowRight, Check, Clock, Cloud, Gift, Infinity: InfinityIcon,
  Lock, Shield, Sparkles, Star, X, Zap,
};
const ICON_COMPONENT: Record<string, LucideIcon | undefined> = Object.fromEntries(
  iconRegistry.map((e) => [e.name, LUCIDE_BY_EXPORT[e.web]]),
);

// =============================================================
// Node rendering + interactivity. Presentational plus a thin layer
// of local state wiring: click-to-select a package (packageList),
// firing a purchase for the selected package (purchaseButton), and
// button actions (close/url/restore). No network, no SDK, no CSS
// framework (inline styles only) — selection state itself lives in
// `PaywallRenderer` (useState); this module only reads/writes it
// through `RenderCtx`.
// =============================================================

export type RenderCtx = {
  config: BuilderConfig;
  offering: RendererOffering | null;
  locale: string;
  colorScheme: "light" | "dark";
  /** The instant the renderer treats as "now" — see `PaywallRendererProps.now`.
   *  Re-evaluated on every `PaywallRenderer` render when the host does not
   *  supply it. The countdown node reads the WALL CLOCK for its display and
   *  uses this only as a one-off offset captured at mount, so an injected
   *  value still pins the first frame deterministically while a later
   *  re-render can never move the clock — see `Countdown`. */
  now: Date;
  /** See `PaywallRendererProps.firstShownAt` — anchors a `durationSeconds`
   *  countdown's deadline. Absent falls back to mount time (see
   *  `useCountdownDeadline`). */
  firstShownAt?: Date;
  priceView?: Record<string, PackageView>;
  /** Package -> intro-offer eligibility, keyed by packageIdentifier. Absent -> not eligible. */
  eligibility?: Record<string, boolean>;
  /** Live selection state, lifted into `PaywallRenderer`'s useState. */
  selectedPackageId: string | null;
  selectedPackage: PackageView | null;
  /**
   * True for every node inside a `packageList.cellTemplate` subtree
   * (set once per cell when the template is rendered, then inherited
   * unchanged by descendants). `overrides` with `when.kind === "selected"`
   * can only ever be active when this is true — see `activeOverrideConditions`.
   */
  /** Where this render is happening. Absent means unknown, which makes
   * every `visibility` rule fail open — see isNodeVisible in shared. */
  platform?: VisibilityPlatform | null;
  appVersion?: string | null;
  insideCellTemplate: boolean;
  /**
   * The package the current cellTemplate cell is scoped to. Null outside
   * any cellTemplate subtree. Drives both the "relevant package" for
   * `introEligible` overrides and the `selected` override (cellPackageId
   * === selectedPackageId) while `insideCellTemplate` is true.
   */
  cellPackageId: string | null;
  onSelectPackage: (packageIdentifier: string) => void;
  onPurchase: (packageIdentifier: string) => void;
  onClose?: () => void;
  onRestore?: () => void;
  onUrl?: (url: string) => void;
};

/**
 * The `{ introEligible, selected }` condition set active for `node`'s
 * position in the tree, per `RenderCtx`. Relevance follows the same rule
 * as `{{variable}}` resolution: cell-scoped inside a cellTemplate subtree
 * (the cell's own package), selected-scoped everywhere else (the globally
 * selected package). `selected` is only ever true inside a cellTemplate
 * subtree, for the cell whose package is the current global selection.
 */
function activeOverrideConditions(ctx: RenderCtx): { introEligible: boolean; selected: boolean } {
  const relevantPackageId = ctx.insideCellTemplate ? ctx.cellPackageId : ctx.selectedPackageId;
  const introEligible = relevantPackageId !== null ? (ctx.eligibility?.[relevantPackageId] ?? false) : false;
  const selected =
    ctx.insideCellTemplate && ctx.cellPackageId !== null && ctx.cellPackageId === ctx.selectedPackageId;
  return { introEligible, selected };
}

/**
 * Resolve a package's `{{variable}}` substitution values. `packageName`
 * comes from the offering package's `displayName`; price/pricePerPeriod/
 * period are NOT derivable client-agnostically from the minimal
 * `RendererOffering` contract (this package has no SDK/network access) —
 * they come from the `priceView` prop the consumer supplies, keyed by
 * packageIdentifier. Returns null when the identifier is null or isn't
 * found in `offering`; a found package with no matching `priceView` entry
 * still resolves (price fields "" rather than throwing).
 */
/**
 * Resolve effective package IDs: when packageIds is empty (meaning "all offering packages"),
 * return all identifiers from the offering; otherwise return the specified packageIds.
 */
export function effectivePackageIds(
  packageIds: string[],
  offering: RendererOffering | null,
): string[] {
  if (packageIds.length > 0) return packageIds;
  return offering?.packages.map((p) => p.packageIdentifier) ?? [];
}

export function resolvePackageView(
  offering: RendererOffering | null,
  priceView: Record<string, PackageView> | undefined,
  packageIdentifier: string | null,
): PackageView | null {
  if (!packageIdentifier) return null;
  const pkg = offering?.packages.find((p) => p.packageIdentifier === packageIdentifier);
  if (!pkg) return null;
  const view = priceView?.[packageIdentifier];
  return {
    packageName: pkg.displayName,
    price: view?.price ?? "",
    pricePerPeriod: view?.pricePerPeriod ?? "",
    period: view?.period ?? "",
    // Optional Phase D3 fields pass through as-is (undefined when absent from
    // `priceView`) — `resolveVariables` leaves a KNOWN variable verbatim when
    // its backing field is undefined, same signal as an unconfigured one.
    pricePerDay: view?.pricePerDay,
    pricePerWeek: view?.pricePerWeek,
    pricePerMonth: view?.pricePerMonth,
    pricePerYear: view?.pricePerYear,
    introPrice: view?.introPrice,
    introPeriod: view?.introPeriod,
    relativeDiscount: view?.relativeDiscount,
  };
}

/** Unknown node type -> its fallback if present, else nothing. Never throws. */
function renderFallbackOrNull(node: { fallback?: PaywallNode }, ctx: RenderCtx): ReactElement | null {
  if (node.fallback) return renderNode(node.fallback, ctx);
  return null;
}

/** Resolve a text/button/purchaseButton label: locale text -> {{variable}} substitution. Null when the key is missing everywhere. */
function resolveLabel(ctx: RenderCtx, key: string): string | null {
  const text = resolveText(ctx.config, ctx.locale, key);
  if (text === null) return null;
  return resolveVariables(text, ctx.selectedPackage);
}

const ALIGN_TO_TEXT: Record<"start" | "center" | "end", "left" | "center" | "right"> = {
  start: "left",
  center: "center",
  end: "right",
};

const ROLE_STYLE: Record<TextNode["role"], { fontSize: string; fontWeight: number }> = {
  title: { fontSize: "24px", fontWeight: 700 },
  subtitle: { fontSize: "18px", fontWeight: 600 },
  body: { fontSize: "14px", fontWeight: 400 },
  caption: { fontSize: "12px", fontWeight: 400 },
};

function renderStack(node: StackNode, ctx: RenderCtx): ReactElement {
  const style = stackContainerStyle(node, ctx.colorScheme);
  return (
    <div data-rov-node={node.id} style={style}>
      {/* Positional keys, NOT node.id: ids are user-authored and only
          validated for uniqueness server-side at write time — a stale or
          hostile payload with duplicate sibling ids passes the client parse,
          and duplicate React keys mean buggy reconciliation. Position is the
          right identity for a full-remount renderer. */}
      {node.children.map((child, index) =>
        node.axis === "z" ? (
          <div key={index} style={Z_OVERLAY_CHILD_STYLE}>
            {renderNode(child, ctx)}
          </div>
        ) : (
          <Fragment key={index}>{renderNode(child, ctx)}</Fragment>
        ),
      )}
    </div>
  );
}

function renderText(node: TextNode, ctx: RenderCtx): ReactElement | null {
  const text = resolveLabel(ctx, node.key);
  if (text === null) return renderFallbackOrNull(node, ctx);
  const roleStyle = ROLE_STYLE[node.role];
  return (
    <p
      data-rov-node={node.id}
      style={{
        margin: 0,
        color: resolveTextColor(node.color, ctx.colorScheme),
        textAlign: node.align ? ALIGN_TO_TEXT[node.align] : undefined,
        ...roleStyle,
      }}
    >
      {text}
    </p>
  );
}

function renderImage(node: ImageNode, ctx: RenderCtx): ReactElement {
  return (
    <img
      data-rov-node={node.id}
      src={resolveThemeUrl(node.url, ctx.colorScheme)}
      alt={node.alt ?? ""}
      style={{
        display: "block",
        maxWidth: "100%",
        height: node.height !== undefined ? `${node.height}px` : undefined,
        borderRadius: node.cornerRadius !== undefined ? `${node.cornerRadius}px` : undefined,
      }}
    />
  );
}

const BUTTON_STYLE_BASE: Record<ButtonNode["style"], { background?: string; color: string; border: string }> = {
  primary: { background: "#111111", color: "#ffffff", border: "none" },
  secondary: { background: "#eeeeee", color: "#111111", border: "none" },
  plain: { background: "transparent", color: "#111111", border: "none" },
};

function renderButton(node: ButtonNode, ctx: RenderCtx): ReactElement | null {
  // The funnel runner suppresses restore entirely when there's nowhere to
  // route it — unlike close/url, an inert-but-visible restore button would
  // be actively misleading (it implies restore is possible).
  if (node.action.kind === "restore" && !ctx.onRestore) {
    return renderFallbackOrNull(node, ctx);
  }
  const label = resolveLabel(ctx, node.labelKey);
  if (label === null) return renderFallbackOrNull(node, ctx);
  const visual = BUTTON_STYLE_BASE[node.style];
  const handleClick = () => {
    if (node.action.kind === "close") ctx.onClose?.();
    if (node.action.kind === "url") ctx.onUrl?.(node.action.url);
    if (node.action.kind === "restore") ctx.onRestore?.();
  };
  return (
    <button
      type="button"
      data-rov-node={node.id}
      onClick={handleClick}
      style={{
        cursor: "pointer",
        padding: "10px 16px",
        borderRadius: "8px",
        fontSize: "14px",
        fontWeight: 600,
        ...visual,
      }}
    >
      {label}
    </button>
  );
}

function cellWrapperStyle(
  isSelected: boolean,
  colorScheme: "light" | "dark",
): CSSProperties {
  return {
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: isSelected
      ? `2px solid ${SELECTED_CELL_BORDER[colorScheme]}`
      : `1px solid ${UNSELECTED_CELL_BORDER[colorScheme]}`,
    background: "transparent",
    textAlign: "left",
  };
}

// Scheme-aware because the built-in cell is renderer-owned chrome, not
// config: the selected border used to be a hardcoded near-black, which on a
// dark background vanished while the lighter UNSELECTED borders stood out —
// the selection affordance read inverted. Light values are unchanged.
const SELECTED_CELL_BORDER: Record<"light" | "dark", string> = {
  light: "#111111",
  dark: "#F8FAFC",
};
const UNSELECTED_CELL_BORDER: Record<"light" | "dark", string> = {
  light: "#cccccc",
  dark: "#3F3F46",
};

function renderPackageList(node: PackageListNode, ctx: RenderCtx): ReactElement {
  const packageIds = effectivePackageIds(node.packageIds, ctx.offering);
  return (
    <div
      data-rov-node={node.id}
      role="group"
      style={{
        display: "flex",
        flexDirection: node.cellLayout === "row" ? "row" : "column",
        gap: "8px",
      }}
    >
      {packageIds.map((packageId, index) => {
        const isSelected = packageId === ctx.selectedPackageId;

        // With a cellTemplate: render the template subtree once per package,
        // INSIDE the same pressable cell wrapper (aria-pressed/selection/click
        // unchanged) — cell-scoped `ctx.selectedPackage` is what makes
        // `{{price}}` etc. inside the template resolve to THIS cell's
        // package rather than the globally selected one.
        if (node.cellTemplate) {
          const cellCtx: RenderCtx = {
            ...ctx,
            insideCellTemplate: true,
            cellPackageId: packageId,
            selectedPackage: resolvePackageView(ctx.offering, ctx.priceView, packageId),
          };
          return (
            <button
              type="button"
              key={index}
              data-rov-package={packageId}
              aria-pressed={isSelected}
              onClick={() => ctx.onSelectPackage(packageId)}
              style={cellWrapperStyle(isSelected, ctx.colorScheme)}
            >
              {renderNode(node.cellTemplate, cellCtx)}
            </button>
          );
        }

        // No cellTemplate -> built-in cell (name + price), unchanged from
        // before overrides/cellTemplate existed.
        const view = resolvePackageView(ctx.offering, ctx.priceView, packageId);
        return (
          <button
            type="button"
            key={index}
            data-rov-package={packageId}
            aria-pressed={isSelected}
            onClick={() => ctx.onSelectPackage(packageId)}
            style={cellWrapperStyle(isSelected, ctx.colorScheme)}
          >
            <span
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: resolveTextColor(undefined, ctx.colorScheme),
              }}
            >
              {view?.packageName ?? packageId}
            </span>
            {view?.price ? (
              <span
                style={{ fontSize: "12px", color: resolveTextColor(undefined, ctx.colorScheme) }}
              >
                {view.price}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function renderPurchaseButton(node: PurchaseButtonNode, ctx: RenderCtx): ReactElement | null {
  // Trial-aware CTA: the shared evaluator (render-fixtures `trialLabel`
  // contract) picks trialLabelKey only when the SELECTED package's view
  // carries a non-empty introPeriod — never reimplement this branch here.
  const label = resolveLabel(ctx, resolveCtaLabelKey(node, ctx.selectedPackage));
  if (label === null) return renderFallbackOrNull(node, ctx);
  const selectedId = ctx.selectedPackageId;
  const handleClick = () => {
    if (selectedId) ctx.onPurchase(selectedId);
  };
  return (
    <button
      type="button"
      data-rov-node={node.id}
      disabled={!selectedId}
      onClick={handleClick}
      style={{
        cursor: selectedId ? "pointer" : "not-allowed",
        padding: "12px 20px",
        borderRadius: "8px",
        fontSize: "16px",
        fontWeight: 700,
        background: "#111111",
        color: "#ffffff",
        border: "none",
        opacity: selectedId ? 1 : 0.5,
      }}
    >
      {label}
    </button>
  );
}

/**
 * An UNSIZED spacer is the flexible one: it takes whatever main-axis space is
 * left over, which is how a paywall pushes its CTA to the bottom of the
 * viewport (spec §2.1). This is the three-platform contract, not a web
 * choice — SwiftUI emits a bare `Spacer()` and Android a `weight = 1f` for
 * exactly this case, and the shared fixture's own name for it is "spacer
 * flexible". `flex-basis` stays `auto`, which for an empty box is 0, so
 * several unsized spacers split the leftover equally like their native
 * counterparts.
 */
const FLEXIBLE_SPACER_FLEX_GROW = 1;
/** A SIZED spacer is exactly its size on all three platforms: it neither
 *  grows into leftover space nor shrinks when there is none. */
const FIXED_SPACER_FLEX_GROW = 0;
const SPACER_FLEX_SHRINK = 0;

function renderSpacer(node: SpacerNode, ctx: RenderCtx): ReactElement {
  void ctx;
  const sized = node.size !== undefined;
  const size = sized ? `${node.size}px` : undefined;
  return (
    <div
      data-rov-node={node.id}
      style={{
        width: size,
        height: size,
        flexGrow: sized ? FIXED_SPACER_FLEX_GROW : FLEXIBLE_SPACER_FLEX_GROW,
        flexShrink: SPACER_FLEX_SHRINK,
      }}
    />
  );
}

function renderDivider(node: DividerNode, ctx: RenderCtx): ReactElement {
  const thickness = node.thickness ?? DIVIDER_DEFAULT_THICKNESS;
  const inset = node.inset ?? DIVIDER_DEFAULT_INSET;
  // A hairline rule, not body text: an uncoloured divider falls back to
  // DIVIDER_DEFAULT_COLOR (the shared cross-platform default), never the
  // TEXT ink default — that previously drew an opaque near-black bar.
  const color =
    resolveThemeColor(node.color, ctx.colorScheme) ?? resolveThemeColor(DIVIDER_DEFAULT_COLOR, ctx.colorScheme);
  return (
    <div
      data-rov-node={node.id}
      style={{
        // Flex `align-items: stretch` is the only reason a divider fills
        // cross-axis width today; a non-stretch stack align (start/center/end)
        // or a horizontal stack collapses it to zero width without this.
        width: "100%",
        height: `${thickness}px`,
        marginLeft: `${inset}px`,
        marginRight: `${inset}px`,
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

/** `node.name` is a free string (see IconNode) — an unknown name resolves to
 * `undefined` in ICON_COMPONENT and renders NOTHING AT ALL, never a thrown
 * error. That fail-open behavior is the contract, not a fallback path.
 *
 * "Nothing at all" means `null`, not an empty wrapper span: `renderNode`'s
 * null return is this renderer's single "this node drew nothing" signal, and
 * a carousel reads it to decide whether a page exists (see `carouselPages`).
 * An empty-but-present span would make an unknown icon a real, swipeable,
 * blank page with a dot beside it. Matches Android's `buildIcon`, which
 * returns `null` the moment `drawableResFor` misses.
 *
 * `color` is intentionally NOT defaulted here (unlike divider/text): an
 * uncoloured icon inherits the ambient text colour via CSS `currentColor` —
 * `resolveThemeColor` returns `undefined` when the node has no `color`, and
 * Lucide icons treat an undefined `color` prop as `currentColor`. An icon in
 * a feature row should match the colour of the text beside it, mirroring
 * SwiftUI's `nil` -> `.foregroundColor` behaviour. */
function renderIcon(node: IconNode, ctx: RenderCtx): ReactElement | null {
  const Cmp = ICON_COMPONENT[node.name];
  if (!Cmp) return null;
  const size = node.size ?? ICON_DEFAULT_SIZE;
  return (
    <span data-rov-node={node.id} style={{ display: "inline-flex", flexShrink: 0 }}>
      <Cmp size={size} color={resolveThemeColor(node.color, ctx.colorScheme)} />
    </span>
  );
}

const ROW_GAP = "8px";
// Named per the same convention as ROW_GAP above — Kotlin's NodeViewFactory.kt
// already names its row-carrying-node layout constants (FEATURE_LIST_ROW_
// SPACING_DP, TIMELINE_MARK_GAP_DP, etc.); these mirror that on web instead of
// inlining "12px"/"4px"/"2px" literals.
const TIMELINE_MARK_GAP = "12px";
const TIMELINE_CONNECTOR_WIDTH = "2px";
const SOCIAL_PROOF_ROW_GAP = "4px";
const SOCIAL_PROOF_STAR_GAP = "2px";

/** A feature row's mark: the row's own `icon` if given; otherwise the
 * excluded mark when `included` is explicitly false, else the included
 * default. Resolved through the same `ICON_COMPONENT` lookup as the `icon`
 * node — an unrecognised name fails open (renders nothing), never throws.
 * The resolved name itself is exposed via `data-rov-icon` — the only way
 * from outside the component to tell which mark was chosen, since fail-open
 * means an unknown name and a known one can otherwise both render nothing
 * or both render a glyph. */
function renderFeatureList(node: FeatureListNode, ctx: RenderCtx): ReactElement {
  // `iconColor` is intentionally NOT defaulted (mirrors renderIcon): absent
  // means the mark inherits the row's own text colour via CSS `currentColor`,
  // set once on the row container rather than repeated per node.
  const iconColor = resolveThemeColor(node.iconColor, ctx.colorScheme);
  const rowTextColor = resolveTextColor(undefined, ctx.colorScheme);
  return (
    <div data-rov-node={node.id} style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
      {node.rows.map((row, index) => {
        const included = row.included ?? FEATURE_ROW_DEFAULT_INCLUDED;
        const iconName = row.icon ?? (included ? FEATURE_ROW_DEFAULT_ICON : FEATURE_ROW_EXCLUDED_ICON);
        const Cmp = ICON_COMPONENT[iconName];
        const label = resolveLabel(ctx, row.labelKey);
        return (
          <div
            key={index}
            data-rov-row
            style={{ display: "flex", alignItems: "center", gap: ROW_GAP, color: rowTextColor }}
          >
            <span data-rov-icon={iconName} style={{ display: "inline-flex", flexShrink: 0 }}>
              {Cmp ? <Cmp size={ICON_DEFAULT_SIZE} color={iconColor} /> : null}
            </span>
            {label !== null ? <span>{label}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** The connector between steps and each row's caption follow the divider
 * pattern: an absent `connectorColor` falls back to the shared cross-platform
 * default, never a renderer-invented value. A row's own mark has no
 * configurable colour (TimelineRow carries none) so it always inherits, same
 * as the feature list's icon does when uncoloured. */
function renderTimeline(node: TimelineNode, ctx: RenderCtx): ReactElement {
  const connectorColor =
    resolveThemeColor(node.connectorColor, ctx.colorScheme) ??
    resolveThemeColor(TIMELINE_CONNECTOR_DEFAULT_COLOR, ctx.colorScheme);
  const rowTextColor = resolveTextColor(undefined, ctx.colorScheme);
  return (
    <div data-rov-node={node.id} style={{ display: "flex", flexDirection: "column" }}>
      {node.rows.map((row, index) => {
        const Cmp = ICON_COMPONENT[row.icon ?? TIMELINE_ROW_DEFAULT_ICON];
        const label = resolveLabel(ctx, row.labelKey);
        const isLast = index === node.rows.length - 1;
        // Guarded the SAME way as `label` two lines below: on the RESOLVED
        // text, not merely on `captionKey !== undefined`. A present-but-
        // unresolvable caption key (e.g. missing from every locale) used to
        // still emit an empty `<span data-rov-caption>`, occupying a line
        // box for nothing.
        const caption = row.captionKey !== undefined ? resolveLabel(ctx, row.captionKey) : null;
        return (
          <div key={index} data-rov-row style={{ display: "flex", gap: TIMELINE_MARK_GAP }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{ display: "inline-flex", flexShrink: 0, color: rowTextColor }}>
                {Cmp ? <Cmp size={ICON_DEFAULT_SIZE} /> : null}
              </span>
              {!isLast ? (
                <div style={{ width: TIMELINE_CONNECTOR_WIDTH, flexGrow: 1, backgroundColor: connectorColor }} />
              ) : null}
            </div>
            <div style={{ display: "flex", flexDirection: "column", color: rowTextColor }}>
              {label !== null ? <span>{label}</span> : null}
              {caption !== null ? <span data-rov-caption style={ROLE_STYLE.caption}>{caption}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** `rating` absent renders no stars at all — not zero filled ones — so a
 * paywall author who hasn't set a rating doesn't ship an empty row of
 * outlines. When present, always draws `SOCIAL_PROOF_MAX_RATING` stars, the
 * first `floor(rating)` filled — a 4.5 rating fills 4 stars, not 5: showing
 * a fractional rating identically to the next whole one overstates it, the
 * wrong direction for social proof. `starColor` absent falls back to the
 * shared cross-platform default, same pattern as the timeline connector. */
function renderSocialProof(node: SocialProofNode, ctx: RenderCtx): ReactElement {
  const label = resolveLabel(ctx, node.labelKey);
  const starColor =
    resolveThemeColor(node.starColor, ctx.colorScheme) ??
    resolveThemeColor(SOCIAL_PROOF_STAR_DEFAULT_COLOR, ctx.colorScheme);
  const filledCount = node.rating !== undefined ? Math.floor(node.rating) : 0;
  return (
    <div data-rov-node={node.id} style={{ display: "flex", flexDirection: "column", gap: SOCIAL_PROOF_ROW_GAP }}>
      {node.rating !== undefined ? (
        <div style={{ display: "flex", gap: SOCIAL_PROOF_STAR_GAP }}>
          {Array.from({ length: SOCIAL_PROOF_MAX_RATING }, (_, index) => (
            <span key={index} data-rov-star style={{ display: "inline-flex" }}>
              <Star
                size={ICON_DEFAULT_SIZE}
                color={starColor}
                fill={index < filledCount ? starColor : "none"}
              />
            </span>
          ))}
        </div>
      ) : null}
      {label !== null ? <span style={{ color: resolveTextColor(undefined, ctx.colorScheme) }}>{label}</span> : null}
    </div>
  );
}

/** A stickyFooter reached through the ORDINARY dispatcher — anywhere other
 * than a direct root child — renders like a stack: in-flow, no pinning
 * chrome. `PaywallRenderer` is what gives a root-level instance its pinned
 * behaviour (it renders this same node through `renderNode` too, then wraps
 * the result); this function only ever produces the plain, unpinned shape.
 * That mismatch for a misplaced footer is deliberate — the validator's
 * `STICKY_FOOTER_NOT_AT_ROOT` warning is what tells the author. */
function renderStickyFooter(node: StickyFooterNode, ctx: RenderCtx): ReactElement {
  const background =
    resolveThemeColor(node.background, ctx.colorScheme) ??
    resolveThemeColor(STICKY_FOOTER_DEFAULT_BACKGROUND, ctx.colorScheme);
  return (
    <div data-rov-node={node.id} style={{ display: "flex", flexDirection: "column", background }}>
      {node.children.map((child, index) => (
        <Fragment key={index}>{renderNode(child, ctx)}</Fragment>
      ))}
    </div>
  );
}

const COUNTDOWN_PAD_WIDTH = 2;
const COUNTDOWN_MS_PER_SECOND = 1000;
const COUNTDOWN_SECONDS_PER_MINUTE = 60;
const COUNTDOWN_SECONDS_PER_HOUR = 3600;

/** `hh:mm:ss`, dropping the hours segment entirely once it's zero — a
 * countdown under an hour shows `mm:ss`, never a leading `00:`.
 *
 * Rounds the remaining second UP (`ceil`), matching the SwiftUI and Android
 * renderers by value: with 59.4 s left the promotion has not yet ended, so
 * `01:00` is honest and `00:59` is a second the buyer never gets. Only an
 * exhausted countdown (`remainingMs <= 0`, clamped by the caller) shows
 * `00:00`. Since the remaining time is essentially never an integral number
 * of milliseconds in production, floor-vs-ceil is a visible, permanent
 * one-second disagreement, not an edge case. */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / COUNTDOWN_MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / COUNTDOWN_SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % COUNTDOWN_SECONDS_PER_HOUR) / COUNTDOWN_SECONDS_PER_MINUTE);
  const seconds = totalSeconds % COUNTDOWN_SECONDS_PER_MINUTE;
  const pad = (n: number) => String(n).padStart(COUNTDOWN_PAD_WIDTH, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The countdown's deadline in epoch ms: `endsAt` directly, or
 * `durationSeconds` anchored to `ctx.firstShownAt`.
 *
 * `endsAt` arrives as a decoded WIRE value, not something the authoring
 * schema has just validated, so an unparsable string is a real possibility
 * here: it yields `NaN`, `NaN <= 0` is false, and the raw arithmetic would
 * paint `NaN:NaN` onto the paywall. Both native renderers return nil for an
 * unparsable instant and route to `fallback`; returning null here does the
 * same, honouring the standing "never show garbage" contract.
 *
 * WITHOUT a `firstShownAt` the `durationSeconds` anchor falls back to this
 * instance's own mount time (captured once via `useState`'s lazy
 * initializer). That fallback is a deliberate downgrade, not equivalent
 * behaviour: a countdown anchored to mount restarts on every remount, which
 * is not a deadline — which is why the funnel runner supplies a persisted
 * anchor (`resolvePersistedFirstShownAt`) the way the SDKs do.
 *
 * Null when neither `endsAt` nor `durationSeconds` is set;
 * `COUNTDOWN_NO_DEADLINE` already flags that at validate time, so this is a
 * defensive fail-open, not the primary guard.
 */
function useCountdownDeadline(node: CountdownNode, ctx: RenderCtx): number | null {
  const [mountedAt] = useState(() => ctx.now.getTime());
  return countdownDeadlineMs(node, ctx.firstShownAt?.getTime() ?? mountedAt);
}

/** The pure half of `useCountdownDeadline`: everything above minus the mount-
 * time anchor, which is the only part that needs a hook. Split out so
 * `countdownHasDeadline` can ask the SAME branch structure whether a deadline
 * exists at all, from outside a component — one set of null branches, not two
 * that can drift. */
function countdownDeadlineMs(node: CountdownNode, firstShownAtMs: number): number | null {
  if (node.endsAt !== undefined) {
    const endsAtMs = new Date(node.endsAt).getTime();
    return Number.isNaN(endsAtMs) ? null : endsAtMs;
  }
  if (node.durationSeconds !== undefined) {
    return firstShownAtMs + node.durationSeconds * COUNTDOWN_MS_PER_SECOND;
  }
  return null;
}

/** Any anchor at all answers "is there a deadline?": `countdownDeadlineMs`
 * returns null on the `endsAt`-unparsable and neither-field branches, both of
 * which ignore the anchor entirely, and returns non-null on the
 * `durationSeconds` branch for EVERY anchor. The epoch is used to make that
 * independence explicit rather than smuggling in a plausible-looking clock
 * read that would suggest the answer depends on it. */
const COUNTDOWN_ANCHOR_PROBE_MS = 0;

/** Whether this countdown can resolve a deadline at all — the anchor-free
 * question `renderNode` has to answer BEFORE mounting the component, since a
 * countdown with no deadline draws nothing and a carousel must not give it a
 * page (mirrors Android's `buildCountdown` returning null). */
function countdownHasDeadline(node: CountdownNode): boolean {
  return countdownDeadlineMs(node, COUNTDOWN_ANCHOR_PROBE_MS) !== null;
}

/**
 * A real component (not a plain render function like its siblings above) —
 * it owns hook state that must live and die with THIS node's own position in
 * the tree, not with whatever call order the dispatcher happens to visit
 * siblings in.
 *
 * The WALL CLOCK is the source of truth for the displayed value, exactly as
 * on iOS (`Date()`) and Android (`System.currentTimeMillis()`); the interval
 * is a repaint trigger and nothing more. Deriving the value from how many
 * intervals had fired instead (the shape this replaced) drifts under load,
 * stalls in a background tab, and — because `ctx.now` is re-evaluated on
 * every parent render while the tick count survives reconciliation — jumps
 * forward by the whole elapsed time the moment anything re-renders the tree,
 * which a package tap does.
 *
 * `ctx.now` survives as a one-off OFFSET captured at mount, which is what
 * keeps an injected `now` deterministic (first frame renders exactly the
 * injected instant) without letting a later render move the clock.
 */
function Countdown({ node, ctx }: { node: CountdownNode; ctx: RenderCtx }): ReactElement | null {
  // Signed distance from the real clock to the instant the host asked us to
  // treat as "now". Zero in production (`props.now` defaults to `new Date()`);
  // non-zero only when a host/test pins an instant.
  const [injectedClockOffsetMs] = useState(() => ctx.now.getTime() - Date.now());
  // Repaint trigger only — never read. The value below comes from the clock.
  const [, requestRepaint] = useState(0);
  // Callback ref rather than useRef: the observer effect inside `useNodeVisible`
  // must re-run when the element actually appears, and a ref object's mutation
  // does not re-run it.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  // Both halves of the spec §5 stop-off-screen rule — hidden tab AND scrolled
  // out of view — in the one hook every time-driven node shares.
  const visible = useNodeVisible(element);

  const deadline = useCountdownDeadline(node, ctx);
  const remainingMs = deadline === null ? null : deadline - (Date.now() + injectedClockOffsetMs);
  // Nothing left to repaint once the deadline has passed: `freeze` holds at
  // 00:00 for good and `hide` has removed the node. Keeping the interval
  // alive past that is a wakeup a second, forever.
  const expired = remainingMs !== null && remainingMs <= 0;
  const ticking = deadline !== null && !expired && visible;

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => requestRepaint((n) => n + 1), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
    // Re-running on `ticking` is what implements BOTH halves of the spec's
    // stop-off-screen rule: false tears the interval down, true builds a new
    // one — so it resumes without a remount.
  }, [ticking]);

  // Unreachable in practice — `renderNode` runs `countdownHasDeadline` before
  // it ever mounts this component, and the two share `countdownDeadlineMs`'s
  // branches. Kept as the null-narrowing this render needs anyway, and as the
  // same fail-to-fallback contract every other node type carries.
  if (deadline === null || remainingMs === null) return renderFallbackOrNull(node, ctx);

  const onExpiry = node.onExpiry ?? COUNTDOWN_DEFAULT_ON_EXPIRY;
  if (expired && onExpiry === "hide") return null;

  const label = node.labelKey !== undefined ? resolveLabel(ctx, node.labelKey) : null;
  return (
    // `resolveTextColor`, exactly like every other text-bearing node on this
    // renderer: an absent `color` is "inherit the ambient ink", and on the
    // WEB the ambient ink is the host document's, not the paywall's — the
    // renderer paints its own background and therefore owns its own default
    // ink. Substituting the same default its sibling text uses is what makes
    // the RESOLVED colour match; honouring "no colour instruction" literally
    // here would leave the countdown near-black on a dark paywall while the
    // text beside it is near-white. The natives are consistent by doing the
    // opposite, because their ambient ink IS the paywall's theme.
    <div ref={setElement} data-rov-node={node.id} style={{ color: resolveTextColor(node.color, ctx.colorScheme) }}>
      {label !== null ? <span>{label} </span> : null}
      <span>{formatCountdown(Math.max(remainingMs, 0))}</span>
    </div>
  );
}

/**
 * The page nearest the track's current scroll position, clamped to
 * `[0, pageCount - 1]`. Used both to highlight the active dot and, on
 * auto-advance, to know which page comes next — the scroll position (or,
 * absent real layout, the last position this component itself set) is the
 * one source of truth; nothing here keeps a separate running count of
 * elapsed ticks. `clientWidth` is 0 in jsdom (no layout engine), so the `|| 1`
 * fallback exists for tests, not production — in a real browser `clientWidth`
 * is always the track's real rendered width.
 */
function pageFromScrollLeft(track: HTMLElement, pageCount: number): number {
  const pageWidth = track.clientWidth || 1;
  const raw = Math.round(track.scrollLeft / pageWidth);
  return Math.min(Math.max(raw, 0), Math.max(pageCount - 1, 0));
}

/**
 * A carousel's renderable pages: every child that actually draws something,
 * in order. `renderNode` returning null IS the "drew nothing" signal — the
 * same one Android's `build(): View?` returns and `buildCarousel` filters on
 * with `mapNotNull` — so this needs no per-node-type knowledge and cannot
 * drift from what the individual renderers decide. Elements are built here,
 * in the PARENT's render pass, which is where React builds children anyway;
 * `Carousel` receives them ready-made.
 */
function carouselPages(node: CarouselNode, ctx: RenderCtx): ReactElement[] {
  const pages: ReactElement[] = [];
  for (const child of node.children) {
    const page = renderNode(child, ctx);
    if (page !== null) pages.push(page);
  }
  return pages;
}

/**
 * A carousel's pages, paged with CSS scroll-snap (spec §3.1) — the track
 * opts into `scroll-snap-type: x mandatory`, each page into
 * `scroll-snap-align: center`, and the BROWSER owns the animation; this
 * component never computes a scroll offset by hand except to programmatic-
 * scroll on auto-advance, and to read back "which page is current" for the
 * dots from `track.scrollLeft`.
 *
 * Auto-advance is wired through the exact same stop/resume lifecycle as
 * `Countdown` (spec §5, reused rather than reinvented) — literally the same
 * code, `useNodeVisible`: a `visibilitychange` listener plus an
 * `IntersectionObserver`, both halves. `ticking` folds in
 * `stoppedAtEnd`, which is what makes a `loop: false` carousel stop
 * PERMANENTLY on the last page rather than idling and re-checking forever —
 * once true it never flips back. `loop: true` instead wraps to page 0 and
 * keeps ticking.
 *
 * The effect depends on `currentPage`, which is what implements "a user
 * swipe restarts the interval rather than racing it" for free: `onScroll`
 * (fired by a real drag, or by this component's own programmatic advance)
 * updates `currentPage`, tearing the running `setInterval` down and standing
 * up a fresh one — so the NEXT auto-advance is always a full interval away
 * from whichever scroll — human or automatic — happened most recently, never
 * from some earlier schedule the swipe didn't know about. Rule 4 (spec §5):
 * the tick is a repaint trigger that reads `currentPage` fresh from state
 * and computes exactly one step from it, never a count of its own that could
 * drift or double-fire.
 *
 * A page that renders NOTHING is dropped, not rendered blank (spec §3, C3):
 * the cross-platform contract this wave settled on is Android's behaviour —
 * a blank page plus a phantom dot is indefensible from the reader's side,
 * since they swipe to an empty screen and the dots lie about how much
 * content exists, and that lie is identical whether the page was hidden by a
 * `visibility` rule or simply had nothing to draw (an unknown node type with
 * no `fallback`, a restore button with no handler, an unknown icon name, a
 * countdown with no deadline, a nested empty carousel). `carouselPages`
 * decides that once, up front, by the one signal that already answers it —
 * `renderNode` returning null — and every downstream count (page slots, dots,
 * the loop/stop math) is derived from that filtered list, never from
 * `node.children.length`. So an empty middle page shortens the carousel
 * instead of leaving a gap, and "every page empty" collapses to the empty
 * case (`fallback`, else nothing) exactly like an authored-empty carousel.
 *
 * The filtering happens in `renderNode` rather than here because the empty
 * carousel must resolve to `fallback` WITHOUT this component mounting — a
 * component that returns null after its hooks still counts as a rendered
 * page to ITS parent carousel, which is precisely the nesting case above.
 */
function Carousel({ node, ctx, pages }: { node: CarouselNode; ctx: RenderCtx; pages: ReactElement[] }): ReactElement {
  const pageCount = pages.length;
  const showsIndicator = node.showsIndicator ?? CAROUSEL_DEFAULT_SHOWS_INDICATOR;
  const loop = node.loop ?? CAROUSEL_DEFAULT_LOOP;
  // Absent `autoAdvanceSeconds` means OFF, deliberately not a default
  // interval — a paywall that starts moving on its own without the author
  // asking is a surprise (spec §4).
  const autoAdvanceMs = node.autoAdvanceSeconds !== undefined ? node.autoAdvanceSeconds * COUNTDOWN_MS_PER_SECOND : null;

  const [currentPage, setCurrentPage] = useState(0);
  const [stoppedAtEnd, setStoppedAtEnd] = useState(false);
  // Callback refs, not useRef: the observer effect inside `useNodeVisible`
  // must re-run when the wrapper actually appears, and the scroll effect needs
  // the real track element to set `scrollLeft` on — a ref object's mutation
  // does not re-run either effect (same reasoning as `Countdown`'s `element`).
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  // The same hook the countdown uses, so a carousel scrolled out of view stops
  // advancing instead of paging on into nothing. `visible` is a PAUSE, never a
  // stop: it gates `ticking` without touching `stoppedAtEnd`, so a carousel
  // hidden mid-run resumes exactly where it left off — reaching the last page
  // is the only thing that latches.
  const visible = useNodeVisible(element);

  const ticking = autoAdvanceMs !== null && !stoppedAtEnd && visible && pageCount > 1;

  useEffect(() => {
    if (!ticking || track === null) return;
    const id = setInterval(() => {
      const next = currentPage + 1;
      if (next < pageCount) {
        // M1: an instant jump, not `scrollTo({ behavior: "smooth" })` — left
        // this way deliberately, not for lack of a one-liner. `onScroll`
        // (`handleScroll` below) re-derives `currentPage` from `scrollLeft`
        // on every scroll event, and a smooth scroll fires many of those
        // while it animates through intermediate positions. Each one would
        // flip `currentPage` mid-transition, which re-keys this very effect
        // and restarts the interval — racing the fixed-interval schedule
        // this component works hard elsewhere to keep single-source. Both
        // natives animate for free because their page transition and their
        // "current page" signal are the same platform primitive; web's are
        // two separate mechanisms wired together, so the two do not compose
        // for free here. Left instant; a real animation needs the scroll
        // handler to distinguish a programmatic scroll from a manual one
        // first.
        track.scrollLeft = next * (track.clientWidth || 1);
        setCurrentPage(next);
      } else if (loop) {
        track.scrollLeft = 0;
        setCurrentPage(0);
      } else {
        // Reaching the end with loop off: stop for good. Not a rewind, not
        // a continued re-check against a clamped index — `stoppedAtEnd`
        // flips `ticking` false and stays false.
        setStoppedAtEnd(true);
      }
    }, autoAdvanceMs!);
    return () => clearInterval(id);
  }, [ticking, autoAdvanceMs, loop, pageCount, track, currentPage]);

  const handleScroll = () => {
    if (track === null) return;
    setCurrentPage(pageFromScrollLeft(track, pageCount));
  };

  // A substituted default here, deliberately (I1): an absent
  // `indicatorColor` inherits the PAYWALL's ink, not the host page's. The
  // web root (`renderer.tsx`) never sets an ambient `color`, so a bare
  // `currentColor` pass-through would resolve against whatever the
  // EMBEDDING document happens to have — `resolveTextColor` is the same
  // substitution `Countdown` makes for the same reason, and it resolves to
  // the byte-identical ink Android's `resolvedInkTintColorInt` uses
  // (#0F172A light / #F8FAFC dark), so all three platforms agree at the
  // resolved value, not just in which branch runs.
  //
  // Deliberately NOT fixed by setting an ambient `color` on the paywall
  // root instead: that would also change what every OTHER `currentColor`
  // consumer inherits (`renderIcon`'s lucide icons have the identical
  // latent pass-through problem) — a wider blast radius this wave does not
  // take on. Scoping the fix to this one call site keeps it intentional.
  const indicatorColor = resolveTextColor(node.indicatorColor, ctx.colorScheme);

  return (
    <div ref={setElement} data-rov-node={node.id} style={{ display: "flex", flexDirection: "column" }}>
      <div
        ref={setTrack}
        data-rov-carousel-track=""
        onScroll={handleScroll}
        style={{
          display: "flex",
          flexDirection: "row",
          overflowX: "auto",
          scrollSnapType: CAROUSEL_TRACK_SCROLL_SNAP_TYPE,
        }}
      >
        {pages.map((page, index) => (
          <div
            key={index}
            data-rov-carousel-page=""
            style={{ flex: `0 0 ${CAROUSEL_PAGE_FLEX_BASIS}`, scrollSnapAlign: CAROUSEL_PAGE_SCROLL_SNAP_ALIGN }}
          >
            {page}
          </div>
        ))}
      </div>
      {/* I2: a single renderable page draws no indicator, matching both
          natives (iOS `.automatic`, Android `pageCount > 1`) — web was the
          outlier drawing one lone dot. */}
      {showsIndicator && pageCount > 1 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            gap: `${CAROUSEL_DOT_GAP_PX}px`,
          }}
        >
          {pages.map((_, index) => (
            <span
              key={index}
              data-rov-carousel-dot=""
              style={carouselDotStyle(index === currentPage, indicatorColor)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What `Video`'s visibility effect should do to the element right now.
 *
 * Three states, not two, and the third (`LEAVE_ALONE`) is the point: it is
 * what keeps a NON-autoplay video the reader started by hand (or deliberately
 * paused) from being started or re-paused by every visibility report. Pausing
 * on going off-screen is unconditional regardless of `autoplay` — that half
 * of the rule holds for a clip the reader started as much as for one that
 * started itself. Named states rather than a boolean so a call site cannot
 * collapse "should I resume" and "should I leave it" into the same branch by
 * accident. Mirrors iOS's `VideoPlaybackCommand` (`RovenuePaywallView.swift`)
 * exactly — this wave brings web's contract in line with it.
 */
const VIDEO_PLAYBACK_COMMAND = {
  PLAY: "play",
  PAUSE: "pause",
  LEAVE_ALONE: "leaveAlone",
} as const;
type VideoPlaybackCommand = (typeof VIDEO_PLAYBACK_COMMAND)[keyof typeof VIDEO_PLAYBACK_COMMAND];

/**
 * The single playback rule a `video` obeys, a pure free function so it can be
 * unit-tested without mounting a `<video>` element or stubbing
 * `IntersectionObserver` — the same reason iOS's sibling rule
 * (`videoPlaybackCommand` in `RovenuePaywallView.swift`) is a pure function
 * rather than logic inlined in the view's effect.
 *
 * `autoplay` is the author's standing instruction and is honoured: a node
 * that said `autoplay: false` is never STARTED by scrolling into view — only
 * a reader-initiated `play()` (via `showsControls`) starts it, and once
 * playing it still obeys the unconditional off-screen pause below.
 */
export function videoPlaybackCommand(visible: boolean, autoplay: boolean): VideoPlaybackCommand {
  if (!visible) return VIDEO_PLAYBACK_COMMAND.PAUSE;
  return autoplay ? VIDEO_PLAYBACK_COMMAND.PLAY : VIDEO_PLAYBACK_COMMAND.LEAVE_ALONE;
}

/**
 * The base a RELATIVE media source is parsed against, and nothing else: it
 * is never fetched and never reaches the element or the host's player, both
 * of which always receive the authored string unchanged. A relative source
 * (`"clip.mp4"`) is legitimate on web — the browser resolves it against the
 * hosting document — so "is this a URL at all?" cannot be answered by
 * `new URL(src)` alone, which rejects every relative string. Parsing against
 * a fixed, deliberately unroutable base answers exactly the question asked
 * without depending on `document`, which is absent under SSR. `.invalid` is
 * the reserved never-resolvable TLD (RFC 2606), so this can never
 * accidentally address a real host.
 */
const MEDIA_SOURCE_PARSE_BASE_URL = "https://source-probe.rovenue.invalid/";

/**
 * Whether a theme-resolved media source is a URL at all — the one question
 * both media node types ask, so they cannot answer it differently. A blank
 * (or whitespace-only) source is the case that matters most and it is not
 * exotic: `newNode("video")` and `newNode("lottie")` both create
 * `url: { light: "" }`, so every freshly added media node in the builder is
 * in exactly this state until a URL is pasted.
 */
function hasParsableSource(rawSource: string): boolean {
  const source = rawSource.trim();
  if (source === "") return false;
  try {
    // Constructed only to see whether it throws; the parsed result is
    // discarded, since the consumer is handed the authored string.
    new URL(source, MEDIA_SOURCE_PARSE_BASE_URL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a `video`'s theme-resolved source is a URL at all — the only half
 * of "will this draw?" that is knowable BEFORE the browser tries to load it,
 * and therefore the only half a carousel fixing its page and dot counts can
 * act on. Mirrors iOS's `videoHasParsableSource` (`RovenuePaywallView.swift`,
 * consumed by `nodeRendersContent`) and Android's (`NodeViewFactory.kt`,
 * consumed by `buildVideo`), asked at the same pre-mount moment on all three.
 *
 * Left unguarded, `<video src="">` re-requests the hosting document itself.
 *
 * What this deliberately does NOT cover: a source that parses and then fails
 * during load. That answer is asynchronous on every platform and arrives long
 * after the page list was built — see `Video`'s own doc comment.
 */
function videoHasParsableSource(node: VideoNode, ctx: RenderCtx): boolean {
  return hasParsableSource(resolveThemeUrl(node.url, ctx.colorScheme));
}

/**
 * A video plays or pauses via ITS OWN ELEMENT (`play()`/`pause()`), never by
 * remounting — a remount restarts playback from zero, a different and worse
 * behaviour than "resume where it left off", and it would diverge from both
 * the SwiftUI and Android-Views renderers that follow this one. `useNodeVisible`
 * is the exact same on/off-screen signal `Countdown` and `Carousel` already
 * consume (document visible AND intersecting the viewport) — this is the
 * third CONSUMER of that one shared signal, not a third copy of it: the
 * logic itself exists once, in `visibility.ts`, and every node type that
 * needs it calls the same hook.
 *
 * Whether this node draws anything splits into two halves, and only one of
 * them reaches this component. The PRE-MOUNT half — does the source parse at
 * all? — is `videoHasParsableSource` above, answered by `renderNode` before
 * this component exists, because a carousel counts its pages from what
 * `renderNode` returns and a component that mounts its hooks and then draws
 * nothing is still a page to its parent. The POST-MOUNT half — a source that
 * parses and then fails to load — is only knowable once the browser tries
 * (`onerror`, asynchronous), so it is answered from state here: `errored`
 * flips the render from the `<video>` element to `fallback`/null, the same
 * "fail to fallback, else nothing" contract every other node type follows.
 *
 * That second half is an ACCEPTED cross-platform limitation, identical on
 * iOS (`nodeRendersContent`'s `.video` arm says so explicitly) and Android:
 * a video that fails after mount does not shrink its carousel's page or dot
 * count. Closing it needs a page list that can shrink after mount on three
 * different paging primitives; the guard meanwhile is the author's
 * `fallback`.
 */
function Video({ node, ctx }: { node: VideoNode; ctx: RenderCtx }): ReactElement | null {
  // Callback ref, not useRef: same reasoning as `Countdown`'s `element` — the
  // observer effect inside `useNodeVisible` must re-run once the element
  // actually exists.
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [errored, setErrored] = useState(false);
  const visible = useNodeVisible(element);
  const autoplay = node.autoplay ?? VIDEO_DEFAULT_AUTOPLAY;

  useEffect(() => {
    if (element === null) return;
    const command = videoPlaybackCommand(visible, autoplay);
    if (command === VIDEO_PLAYBACK_COMMAND.PLAY) {
      // play() returns a promise that can reject (autoplay blocked, source
      // not ready yet); swallowed deliberately — there is no fallback UI for
      // "autoplay was refused" distinct from the element just sitting there
      // paused, and an unhandled rejection here would fail tests for a
      // condition this component has no way to react to differently. jsdom's
      // own `play()` returns `undefined` rather than a promise, hence the
      // guard rather than an unconditional `.catch`.
      const playResult = element.play();
      if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
    } else if (command === VIDEO_PLAYBACK_COMMAND.PAUSE) {
      element.pause();
    }
    // command === LEAVE_ALONE: deliberately a no-op. A non-autoplay video the
    // reader hasn't started (or has deliberately paused) must not be resumed
    // by visibility alone — see `videoPlaybackCommand`'s doc comment.
  }, [visible, element, autoplay]);

  if (errored) return renderFallbackOrNull(node, ctx);

  return (
    <video
      ref={setElement}
      data-rov-node={node.id}
      src={resolveThemeUrl(node.url, ctx.colorScheme)}
      poster={node.posterUrl !== undefined ? resolveThemeUrl(node.posterUrl, ctx.colorScheme) : undefined}
      autoPlay={autoplay}
      loop={node.loop ?? VIDEO_DEFAULT_LOOP}
      muted={node.muted ?? VIDEO_DEFAULT_MUTED}
      controls={node.showsControls ?? VIDEO_DEFAULT_SHOWS_CONTROLS}
      onError={() => setErrored(true)}
      style={videoStyle(node.aspectRatio)}
    />
  );
}

/**
 * The host's registered Lottie player. This package stays dependency-free of
 * any actual Lottie runtime (no `lottie-web`/`lottie-react` in its own
 * `package.json`) — the host app registers whichever player it already
 * ships, once, at startup. `null` unregisters. The five prop names below are
 * the cross-platform contract: Swift and Kotlin carry the identical five
 * fields to their own native players.
 */
export type LottieRenderer = (props: {
  url: string;
  loop: boolean;
  autoplay: boolean;
  speed: number;
  playing: boolean;
}) => ReactElement | null;

// Module-level by design (the host registers this once, well before any
// paywall mounts) — which also means it LEAKS ACROSS TESTS. Every test that
// calls this must reset it to `null` in an `afterEach`.
let lottieRenderer: LottieRenderer | null = null;

/** Register (or, with `null`, unregister) the host's Lottie player. */
export function registerLottieRenderer(render: LottieRenderer | null): void {
  lottieRenderer = render;
}

/**
 * Whether a `lottie` node can draw anything at all, WITHOUT invoking the
 * host's player — asking is not allowed to cause the host's side effect of
 * building one.
 *
 * Unlike a video's load failure this is fully decidable up front — both
 * halves of it are: registration is process state already in hand, and the
 * URL is in hand too. That is why `renderNode` consults this BEFORE mounting
 * `Lottie`, so an undrawable lottie inside a carousel costs no page and no
 * phantom dot. Mirrors iOS's `lottieCanRender`
 * (`RovenuePaywallLottie.swift`), which asks the same two questions.
 *
 * The URL half was a three-platform divergence and is now decided: a lottie
 * whose source does not parse CANNOT RENDER, and takes the same route an
 * unregistered one takes — `fallback`, else nothing. A registered host player
 * must never be handed `""` (the state `newNode("lottie")` creates) and left
 * to discover the problem itself, and `video` already answers exactly this
 * question, in exactly this place, on all three platforms.
 */
function lottieCanRender(node: LottieNode, ctx: RenderCtx): boolean {
  return lottieRenderer !== null && hasParsableSource(resolveThemeUrl(node.url, ctx.colorScheme));
}

/**
 * With no renderer registered — or a URL that does not parse — this node
 * renders `fallback` else nothing: the existing machinery every node type
 * already has, not a new failure mode. That answer is reached before this
 * component ever mounts (`lottieCanRender`, consulted in `renderNode`); the
 * guard repeated below is what narrows the module-level `lottieRenderer` to
 * non-null for the call that follows, and keeps the component correct if it
 * is ever mounted directly.
 *
 * `playing` rides the same `useNodeVisible` signal `Video` and `Carousel`
 * use, so a host player that honours it pauses off-screen for free.
 */
function Lottie({ node, ctx }: { node: LottieNode; ctx: RenderCtx }): ReactElement | null {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const visible = useNodeVisible(element);
  const source = resolveThemeUrl(node.url, ctx.colorScheme);

  if (lottieRenderer === null || !hasParsableSource(source)) return renderFallbackOrNull(node, ctx);

  // Called in the render pass rather than from an effect, deliberately. The
  // props include `playing`, which IS the visibility signal, and the
  // `rendered === null` answer below decides `fallback` — moving the call
  // into an effect would push that decision after mount (weakening the
  // pre-mount guarantee `lottieCanRender` exists for) and would need a state
  // round-trip and an extra commit to get the element back on screen. Unlike
  // Android's `LottieNodeView`, whose host builds a real `View` per call,
  // the web host returns a React element — an inert descriptor — so React's
  // own reconciliation, not a call count, decides whether the player is
  // actually rebuilt.
  const rendered = lottieRenderer({
    // The AUTHORED string, never the probe's parse of it — `hasParsableSource`
    // only answers a question, it does not rewrite the source.
    url: source,
    loop: node.loop ?? LOTTIE_DEFAULT_LOOP,
    autoplay: node.autoplay ?? LOTTIE_DEFAULT_AUTOPLAY,
    speed: node.speed ?? LOTTIE_DEFAULT_SPEED,
    playing: visible,
  });
  if (rendered === null) return renderFallbackOrNull(node, ctx);

  return (
    <div ref={setElement} data-rov-node={node.id}>
      {rendered}
    </div>
  );
}

/** Recursive dispatcher: known node type -> its component; unknown type or a thrown error -> `fallback` if present, else nothing. Never throws.
 *
 * Every node passes through `applyOverrides` here, BEFORE any style/text
 * resolution happens in the per-type renderers below — `resolved` (not the
 * original `node`) is what gets dispatched. `applyOverrides` only ever
 * touches a node's own overridable VISUAL props (see `OVERRIDABLE_PROP_KEYS`
 * in shared), so `resolved.type` always equals `node.type` and the switch
 * below narrows exactly as it did before overrides existed. */
export function renderNode(node: PaywallNode, ctx: RenderCtx): ReactElement | null {
  // Hidden means the author said "not here", which is NOT the same as
  // "could not decode" — so a hidden node does not render its `fallback`.
  // Doing so would put content on exactly the platform it was excluded
  // from. Returning here also takes the node's children with it.
  //
  // Placed before applyOverrides defensively, NOT because the ordering is
  // what protects anything today: `visibility` is absent from
  // OVERRIDABLE_PROP_KEYS, so `resolved.visibility` always equals
  // `node.visibility` and moving this line below applyOverrides changes
  // nothing observable — verified by mutation, which is why no test guards
  // it. That allow-list is the real guarantee that an override cannot
  // resurrect a hidden node; this ordering only keeps the gate correct if
  // someone ever widens it.
  if (!isNodeVisible(node.visibility, ctx)) return null;
  const resolved = applyOverrides(node, activeOverrideConditions(ctx));
  try {
    switch (resolved.type) {
      case "stack":
        return renderStack(resolved, ctx);
      case "text":
        return renderText(resolved, ctx);
      case "image":
        return renderImage(resolved, ctx);
      case "button":
        return renderButton(resolved, ctx);
      case "packageList":
        return renderPackageList(resolved, ctx);
      case "purchaseButton":
        return renderPurchaseButton(resolved, ctx);
      case "spacer":
        return renderSpacer(resolved, ctx);
      case "divider":
        return renderDivider(resolved, ctx);
      case "icon":
        return renderIcon(resolved, ctx);
      case "featureList":
        return renderFeatureList(resolved, ctx);
      case "timeline":
        return renderTimeline(resolved, ctx);
      case "socialProof":
        return renderSocialProof(resolved, ctx);
      case "stickyFooter":
        return renderStickyFooter(resolved, ctx);
      // Every stateful node type answers "do I draw anything?" HERE, before
      // its component exists, so that a null answer becomes `renderNode`
      // returning null — the one signal a parent carousel reads to decide a
      // page exists. A component that mounts its hooks and then returns null
      // is, to its parent, still a page.
      case "countdown":
        if (!countdownHasDeadline(resolved)) return renderFallbackOrNull(resolved, ctx);
        return <Countdown node={resolved} ctx={ctx} />;
      case "carousel": {
        const pages = carouselPages(resolved, ctx);
        if (pages.length === 0) return renderFallbackOrNull(resolved, ctx);
        return <Carousel node={resolved} ctx={ctx} pages={pages} />;
      }
      // The two media nodes answer the same question HERE too, for the same
      // reason — a carousel fixes its page and dot counts from what this
      // function returns, and a component that mounts and then draws nothing
      // is still a page to its parent. Both natives ask exactly these two
      // questions at exactly this moment (iOS `nodeRendersContent`, Android
      // `buildVideo`/`buildLottie`).
      //
      // What is asked is only the half that is knowable synchronously: does
      // the source parse (asked of BOTH media types, the same way), and is a
      // lottie player registered. A video whose source parses and then fails
      // DURING LOAD is asynchronous on every platform and is an accepted
      // limitation, not an oversight — see `Video`'s doc comment, and the
      // validator's VIDEO_IN_CAROUSEL_NO_FALLBACK, which is what warns the
      // author about it.
      case "video":
        if (!videoHasParsableSource(resolved, ctx)) return renderFallbackOrNull(resolved, ctx);
        return <Video node={resolved} ctx={ctx} />;
      case "lottie":
        if (!lottieCanRender(resolved, ctx)) return renderFallbackOrNull(resolved, ctx);
        return <Lottie node={resolved} ctx={ctx} />;
      default:
        return renderFallbackOrNull(resolved, ctx);
    }
  } catch {
    return renderFallbackOrNull(resolved, ctx);
  }
}
