import { localizedKeysOf, type PaywallNode } from "@rovenue/shared/paywall";
import {
  Layers,
  Type,
  Image as ImageIcon,
  MousePointerClick,
  Package,
  ShoppingCart,
  MoveVertical,
  Minus,
  Sparkles,
  ListChecks,
  GitCommitVertical,
  Star,
  PanelBottom,
  Timer,
  GalleryHorizontal,
  Video,
  FileJson,
  type LucideIcon,
} from "lucide-react";

// =============================================================
// Static metadata for the 17 paywall node types, shared by the
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
  "divider",
  "icon",
  "featureList",
  "timeline",
  "socialProof",
  "stickyFooter",
  "countdown",
  "carousel",
  "video",
  "lottie",
];

export const NODE_ICON: Record<PaywallNode["type"], LucideIcon> = {
  stack: Layers,
  text: Type,
  image: ImageIcon,
  button: MousePointerClick,
  packageList: Package,
  purchaseButton: ShoppingCart,
  spacer: MoveVertical,
  divider: Minus,
  icon: Sparkles,
  featureList: ListChecks,
  timeline: GitCommitVertical,
  socialProof: Star,
  stickyFooter: PanelBottom,
  countdown: Timer,
  carousel: GalleryHorizontal,
  video: Video,
  lottie: FileJson,
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
  divider: "Divider",
  icon: "Icon",
  featureList: "Feature list",
  timeline: "Timeline",
  socialProof: "Social proof",
  stickyFooter: "Sticky footer",
  countdown: "Countdown",
  carousel: "Carousel",
  video: "Video",
  lottie: "Lottie",
};

/**
 * The localization key a node's copy lives under, or null for types that
 * carry none. Derived from the shared LOCALIZED_KEYS table rather than a
 * local list — this used to be a third hand-maintained copy of it.
 * The layer tree shows one key, so this takes the first.
 */
export function nodeLocKey(node: PaywallNode): string | null {
  return localizedKeysOf(node)[0] ?? null;
}
