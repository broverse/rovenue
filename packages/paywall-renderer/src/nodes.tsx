import { Fragment, type CSSProperties, type ReactElement } from "react";
import {
  ArrowRight, Check, Clock, Cloud, Gift, Infinity as InfinityIcon,
  Lock, Shield, Sparkles, Star, X, Zap, type LucideIcon,
} from "lucide-react";
import {
  applyOverrides,
  iconRegistry,
  isNodeVisible,
  resolveText,
  resolveVariables,
  ICON_DEFAULT_SIZE,
  DIVIDER_DEFAULT_COLOR,
  DIVIDER_DEFAULT_INSET,
  DIVIDER_DEFAULT_THICKNESS,
  FEATURE_ROW_DEFAULT_ICON,
  FEATURE_ROW_DEFAULT_INCLUDED,
  FEATURE_ROW_EXCLUDED_ICON,
  SOCIAL_PROOF_MAX_RATING,
  SOCIAL_PROOF_STAR_DEFAULT_COLOR,
  TIMELINE_CONNECTOR_DEFAULT_COLOR,
  TIMELINE_ROW_DEFAULT_ICON,
  type BuilderConfig,
  type ButtonNode,
  type DividerNode,
  type FeatureListNode,
  type IconNode,
  type ImageNode,
  type PackageListNode,
  type PackageView,
  type PaywallNode,
  type PurchaseButtonNode,
  type SocialProofNode,
  type SpacerNode,
  type StackNode,
  type TextNode,
  type TimelineNode,
  type VisibilityPlatform,
} from "@rovenue/shared/paywall";
import type { RendererOffering } from "./types";
import {
  resolveTextColor,
  resolveThemeColor,
  resolveThemeUrl,
  stackContainerStyle,
  Z_OVERLAY_CHILD_STYLE,
} from "./styles";

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
  const label = resolveLabel(ctx, node.labelKey);
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

function renderSpacer(node: SpacerNode, ctx: RenderCtx): ReactElement {
  void ctx;
  const size = node.size !== undefined ? `${node.size}px` : undefined;
  return <div data-rov-node={node.id} style={{ width: size, height: size, flexShrink: 0 }} />;
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
 * `undefined` in ICON_COMPONENT and renders the empty wrapper span, never a
 * thrown error. That fail-open behavior is the contract, not a fallback path.
 *
 * `color` is intentionally NOT defaulted here (unlike divider/text): an
 * uncoloured icon inherits the ambient text colour via CSS `currentColor` —
 * `resolveThemeColor` returns `undefined` when the node has no `color`, and
 * Lucide icons treat an undefined `color` prop as `currentColor`. An icon in
 * a feature row should match the colour of the text beside it, mirroring
 * SwiftUI's `nil` -> `.foregroundColor` behaviour. */
function renderIcon(node: IconNode, ctx: RenderCtx): ReactElement {
  const Cmp = ICON_COMPONENT[node.name];
  const size = node.size ?? ICON_DEFAULT_SIZE;
  return (
    <span data-rov-node={node.id} style={{ display: "inline-flex", flexShrink: 0 }}>
      {Cmp ? <Cmp size={size} color={resolveThemeColor(node.color, ctx.colorScheme)} /> : null}
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
      default:
        return renderFallbackOrNull(resolved, ctx);
    }
  } catch {
    return renderFallbackOrNull(resolved, ctx);
  }
}
