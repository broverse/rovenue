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

/** Canvas preview device — a catalog id from `device-catalog.ts`. */
export type CanvasDevice = string;

/** Which of a node's `ThemeColor` variants the canvas is currently previewing. */
export type ColorScheme = "light" | "dark";
