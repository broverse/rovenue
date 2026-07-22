export type {
  BuilderConfig,
  PaywallNode,
  StackNode,
  TextNode,
  ImageNode,
  ButtonNode,
  PackageListNode,
  PurchaseButtonNode,
  SpacerNode,
  ThemeColor,
  NodeSize,
} from "@rovenue/shared/paywall";
export type { BuilderIssue } from "@rovenue/shared/paywall";

/** Canvas preview device frame — mirrors funnel-builder's canvasDevice literal union. */
export type CanvasDevice = "phone" | "tablet" | "desktop";

/** Which of a node's `ThemeColor` variants the canvas is currently previewing. */
export type ColorScheme = "light" | "dark";
