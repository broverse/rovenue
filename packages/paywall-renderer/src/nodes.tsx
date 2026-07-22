import { Fragment, type ReactElement } from "react";
import {
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
import type { RendererOffering, RendererPackage } from "./types";
import { resolveThemeColor, resolveThemeUrl, stackContainerStyle, Z_OVERLAY_CHILD_STYLE } from "./styles";

// =============================================================
// Static node rendering. Pure presentational: no network, no SDK,
// no CSS framework (inline styles only). Interactivity — click to
// select a package, firing a purchase, re-resolving {{variables}}
// against the newly-selected package — is the NEXT task; `RenderCtx`
// already carries `selectedPackage`/`onPurchase` so that task can
// wire state (e.g. useState in PaywallRenderer feeding a new
// selectedPackageId down) without restructuring these components.
// =============================================================

export type RenderCtx = {
  config: BuilderConfig;
  offering: RendererOffering | null;
  locale: string;
  colorScheme: "light" | "dark";
  /** The package whose values back {{variables}} in text/button labels — today always the packageList's defaultSelected (or its first id); Task 3 wires this to live selection state. */
  selectedPackageId: string | null;
  selectedPackage: PackageView | null;
  onPurchase: (packageIdentifier: string) => void;
  onClose?: () => void;
  onRestore?: () => void;
  onUrl?: (url: string) => void;
};

/**
 * Best-effort mapping from a RendererPackage (the loose, SDK-free
 * offering shape this package accepts) to the `{{variable}}`
 * substitution values `resolveVariables` understands. Price fields
 * aren't part of the minimal RendererOffering contract — they ride
 * in `metadata` when the host app supplies them (e.g. formatted
 * StoreProduct pricing). Missing fields resolve to "" rather than
 * throwing or leaving `undefined` on the object.
 */
export function packageToView(pkg: RendererPackage): PackageView {
  const meta =
    pkg.metadata && typeof pkg.metadata === "object" ? (pkg.metadata as Record<string, unknown>) : {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    packageName: pkg.displayName,
    price: str(meta.price),
    pricePerPeriod: str(meta.pricePerPeriod),
    period: str(meta.period),
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
      {node.children.map((child) =>
        node.axis === "z" ? (
          <div key={child.id} style={Z_OVERLAY_CHILD_STYLE}>
            {renderNode(child, ctx)}
          </div>
        ) : (
          <Fragment key={child.id}>{renderNode(child, ctx)}</Fragment>
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
        color: resolveThemeColor(node.color, ctx.colorScheme),
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

function renderPackageList(node: PackageListNode, ctx: RenderCtx): ReactElement {
  const packageById = new Map((ctx.offering?.packages ?? []).map((p) => [p.packageIdentifier, p] as const));
  const selectedId = node.defaultSelected ?? node.packageIds[0] ?? null;
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
      {node.packageIds.map((packageId) => {
        const pkg = packageById.get(packageId);
        const view = pkg ? packageToView(pkg) : null;
        const isSelected = packageId === selectedId;
        return (
          <button
            type="button"
            key={packageId}
            data-rov-package={packageId}
            aria-pressed={isSelected}
            style={{
              cursor: "default",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              padding: "10px 12px",
              borderRadius: "8px",
              border: isSelected ? "2px solid #111111" : "1px solid #cccccc",
              background: "transparent",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: "14px", fontWeight: 600 }}>{view?.packageName ?? packageId}</span>
            {view?.price ? <span style={{ fontSize: "12px" }}>{view.price}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function renderPurchaseButton(node: PurchaseButtonNode, ctx: RenderCtx): ReactElement | null {
  const label = resolveLabel(ctx, node.labelKey);
  if (label === null) return renderFallbackOrNull(node, ctx);
  return (
    <button
      type="button"
      data-rov-node={node.id}
      disabled={!ctx.selectedPackageId}
      style={{
        cursor: ctx.selectedPackageId ? "pointer" : "not-allowed",
        padding: "12px 20px",
        borderRadius: "8px",
        fontSize: "16px",
        fontWeight: 700,
        background: "#111111",
        color: "#ffffff",
        border: "none",
        opacity: ctx.selectedPackageId ? 1 : 0.5,
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

/** Recursive dispatcher: known node type -> its component; unknown type or a thrown error -> `fallback` if present, else nothing. Never throws. */
export function renderNode(node: PaywallNode, ctx: RenderCtx): ReactElement | null {
  try {
    switch (node.type) {
      case "stack":
        return renderStack(node, ctx);
      case "text":
        return renderText(node, ctx);
      case "image":
        return renderImage(node, ctx);
      case "button":
        return renderButton(node, ctx);
      case "packageList":
        return renderPackageList(node, ctx);
      case "purchaseButton":
        return renderPurchaseButton(node, ctx);
      case "spacer":
        return renderSpacer(node, ctx);
      default:
        return renderFallbackOrNull(node, ctx);
    }
  } catch {
    return renderFallbackOrNull(node, ctx);
  }
}
