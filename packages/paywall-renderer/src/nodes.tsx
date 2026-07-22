import { Fragment, type CSSProperties, type ReactElement } from "react";
import {
  applyOverrides,
  resolveText,
  resolveVariables,
  type BuilderConfig,
  type ButtonNode,
  type ImageNode,
  type PackageListNode,
  type PackageView,
  type PaywallNode,
  type PurchaseButtonNode,
  type SpacerNode,
  type StackNode,
  type TextNode,
} from "@rovenue/shared/paywall";
import type { RendererOffering } from "./types";
import {
  resolveTextColor,
  resolveThemeUrl,
  stackContainerStyle,
  Z_OVERLAY_CHILD_STYLE,
} from "./styles";

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

/** Recursive dispatcher: known node type -> its component; unknown type or a thrown error -> `fallback` if present, else nothing. Never throws.
 *
 * Every node passes through `applyOverrides` here, BEFORE any style/text
 * resolution happens in the per-type renderers below — `resolved` (not the
 * original `node`) is what gets dispatched. `applyOverrides` only ever
 * touches a node's own overridable VISUAL props (see `OVERRIDABLE_PROP_KEYS`
 * in shared), so `resolved.type` always equals `node.type` and the switch
 * below narrows exactly as it did before overrides existed. */
export function renderNode(node: PaywallNode, ctx: RenderCtx): ReactElement | null {
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
      default:
        return renderFallbackOrNull(resolved, ctx);
    }
  } catch {
    return renderFallbackOrNull(resolved, ctx);
  }
}
