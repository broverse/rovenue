import type { CSSProperties } from "react";
import type { NodeSize, StackNode, ThemeColor } from "@rovenue/shared/paywall";

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

/** Resolve a `{light, dark?}` image URL pair against the active colorScheme. Missing dark -> light. */
export function resolveThemeUrl(
  url: { light: string; dark?: string },
  colorScheme: "light" | "dark",
): string {
  if (colorScheme === "dark") return url.dark ?? url.light;
  return url.light;
}

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
  node: Pick<StackNode, "axis" | "spacing" | "align" | "padding" | "size" | "background" | "cornerRadius">,
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
