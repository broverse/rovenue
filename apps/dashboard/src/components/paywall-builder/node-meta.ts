import type { PaywallNode } from "@rovenue/shared/paywall";
import {
  Layers,
  Type,
  Image as ImageIcon,
  MousePointerClick,
  Package,
  ShoppingCart,
  MoveVertical,
  type LucideIcon,
} from "lucide-react";

// =============================================================
// Static metadata for the 7 paywall node types, shared by the
// layer tree (row icon/label) and the add-node popover (menu
// entries). Pure data + one pure helper (`nodeLocKey`) — kept
// framework-free so it's trivially unit-testable.
// =============================================================

export const NODE_TYPES: ReadonlyArray<PaywallNode["type"]> = [
  "stack",
  "text",
  "image",
  "button",
  "packageList",
  "purchaseButton",
  "spacer",
];

export const NODE_ICON: Record<PaywallNode["type"], LucideIcon> = {
  stack: Layers,
  text: Type,
  image: ImageIcon,
  button: MousePointerClick,
  packageList: Package,
  purchaseButton: ShoppingCart,
  spacer: MoveVertical,
};

/** English fallback label per node type — mirrored by the `paywalls.builder.nodeTypes.*` i18n keys. */
export const NODE_TYPE_LABEL: Record<PaywallNode["type"], string> = {
  stack: "Stack",
  text: "Text",
  image: "Image",
  button: "Button",
  packageList: "Package list",
  purchaseButton: "Purchase button",
  spacer: "Spacer",
};

/**
 * The localization key a node's user-visible copy lives under, or null for
 * node types that don't carry one (stack/image/packageList/spacer).
 */
export function nodeLocKey(node: PaywallNode): string | null {
  if (node.type === "text") return node.key;
  if (node.type === "button" || node.type === "purchaseButton") return node.labelKey;
  return null;
}
