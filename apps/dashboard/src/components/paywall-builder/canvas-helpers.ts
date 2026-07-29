import type {
  DashboardOfferingRow,
  OfferingResolvedPrices,
  ResolvedStoreEntry,
  ResolvedStorePrice,
} from "@rovenue/shared";
import type { PackageView, PaywallNode, StackNode } from "@rovenue/shared/paywall";
import type { RendererOffering } from "@rovenue/paywall-renderer";
import { formatMinorAmount, periodNoun } from "./inspector/binding-prices";

// =============================================================
// Pure helpers for the paywall builder canvas: mapping a dashboard
// offering row into the renderer's minimal `RendererOffering`
// contract, fabricating a preview-only priceView (the canvas has no
// SDK/store price feed), and translating a selected node's on-screen
// rect into the canvas scroll container's local coordinate space for
// the selection ring.
// =============================================================

/**
 * Maps a `DashboardOfferingRow` into the renderer's `RendererOffering`
 * shape. `displayNameById` resolves a package's `productId` to the
 * linked product's display name (falls back to the package identifier
 * when the product hasn't loaded / isn't found — always renders SOMETHING).
 */
export function toRendererOffering(
  offering: DashboardOfferingRow | null | undefined,
  displayNameById: ReadonlyMap<string, string>,
): RendererOffering | null {
  if (!offering) return null;
  return {
    identifier: offering.identifier,
    packages: offering.packages.map((p) => ({
      packageIdentifier: p.identifier,
      displayName: displayNameById.get(p.productId) ?? p.identifier,
      metadata: p.metadata,
    })),
  };
}

const PLACEHOLDER_PRICES: ReadonlyArray<{
  price: string;
  pricePerPeriod: string;
  period: string;
}> = [
  { price: "$9.99", pricePerPeriod: "$9.99/mo", period: "1 month" },
  { price: "$59.99", pricePerPeriod: "$5.00/mo", period: "1 year" },
  { price: "$2.99", pricePerPeriod: "$2.99/wk", period: "1 week" },
];

/**
 * Deterministic, clearly-preview-only `$9.99`-style placeholder priceView
 * for every package in `offering`, cycling through a short list of presets
 * so a multi-package packageList doesn't render identical prices in every
 * cell. NOT real pricing — the dashboard canvas has no store/SDK price feed.
 */
export function placeholderPriceView(offering: RendererOffering | null): Record<string, PackageView> {
  if (!offering) return {};
  const out: Record<string, PackageView> = {};
  offering.packages.forEach((pkg, i) => {
    const preset = PLACEHOLDER_PRICES[i % PLACEHOLDER_PRICES.length]!;
    out[pkg.packageIdentifier] = {
      packageName: pkg.displayName,
      price: preset.price,
      pricePerPeriod: preset.pricePerPeriod,
      period: preset.period,
    };
  });
  return out;
}

/** ISO period → how many of it fit in a year; the basis for all derived per-period figures. */
export const PER_YEAR_MULTIPLIER: Readonly<Record<string, number>> = {
  P1D: 365,
  P1W: 52,
  P1M: 12,
  P3M: 4,
  P6M: 2,
  P1Y: 1,
};

const MONTHS_PER_YEAR = 12;
const WEEKS_PER_YEAR = 52;
// Per-day derives from per-week / 7, matching PackageViewMapping.kt/.swift.
const DAYS_PER_WEEK = 7;
const PERCENT = 100;

/**
 * The canvas simulates a device, so it reads the device's own store first:
 * an iOS frame shows the App Store price, an Android frame the Play price,
 * with the other store and Stripe as fallbacks.
 */
const CANVAS_STORE_PREFERENCE: Readonly<
  Record<"ios" | "android", ReadonlyArray<"apple" | "google" | "stripe">>
> = {
  ios: ["apple", "google", "stripe"],
  android: ["google", "apple", "stripe"],
};

export type CanvasPriceCoverage = "none" | "partial" | "full";

function pickStoreEntry(
  stores: { apple?: ResolvedStoreEntry; google?: ResolvedStoreEntry; stripe?: ResolvedStoreEntry },
  platform: "ios" | "android",
): ResolvedStorePrice | null {
  for (const store of CANVAS_STORE_PREFERENCE[platform]) {
    const entry = stores[store];
    if (entry && entry.status === "ok") return entry;
  }
  return null;
}

/**
 * Real store prices for the canvas preview. Packages with a resolved
 * ("ok") entry for the preferred store chain get a full `PackageView` —
 * price, period noun, derived per-day/week/month/year figures and the
 * cross-package relativeDiscount, all mirroring the SDK renderers'
 * PackageViewMapping formulas so the canvas matches devices. Unresolved
 * packages keep their `placeholderPriceView` preset (same cycle index).
 */
export function resolvedPriceView(
  offering: RendererOffering | null,
  resolved: OfferingResolvedPrices | undefined,
  platform: "ios" | "android",
): { view: Record<string, PackageView>; coverage: CanvasPriceCoverage } {
  const view = placeholderPriceView(offering);
  if (!offering || !resolved) return { view, coverage: "none" };

  const infoById = new Map(resolved.packages.map((p) => [p.packageIdentifier, p]));

  // First pass: per-year equivalents, the relativeDiscount comparison set.
  const perYearMinorById = new Map<string, number>();
  const pickedById = new Map<string, ResolvedStorePrice>();
  for (const pkg of offering.packages) {
    const info = infoById.get(pkg.packageIdentifier);
    if (!info) continue;
    const entry = pickStoreEntry(info.stores, platform);
    if (!entry) continue;
    pickedById.set(pkg.packageIdentifier, entry);
    const multiplier = entry.period === null ? undefined : PER_YEAR_MULTIPLIER[entry.period];
    if (multiplier !== undefined) {
      perYearMinorById.set(pkg.packageIdentifier, entry.amountMinor * multiplier);
    }
  }
  const comparable = [...perYearMinorById.values()];
  const maxPerYear = comparable.length ? Math.max(...comparable) : 0;
  const discountComputable = comparable.length >= 2 && maxPerYear > 0;

  for (const pkg of offering.packages) {
    const entry = pickedById.get(pkg.packageIdentifier);
    if (!entry) continue;

    const price = formatMinorAmount(entry.amountMinor, entry.currency);
    const noun = periodNoun(entry.period);
    const packageView: PackageView = {
      packageName: pkg.displayName,
      price,
      pricePerPeriod: noun ? `${price}/${noun}` : price,
      period: noun,
    };

    const perYearMinor = perYearMinorById.get(pkg.packageIdentifier);
    if (perYearMinor !== undefined) {
      packageView.pricePerYear = formatMinorAmount(perYearMinor, entry.currency);
      packageView.pricePerMonth = formatMinorAmount(perYearMinor / MONTHS_PER_YEAR, entry.currency);
      packageView.pricePerWeek = formatMinorAmount(perYearMinor / WEEKS_PER_YEAR, entry.currency);
      packageView.pricePerDay = formatMinorAmount(perYearMinor / WEEKS_PER_YEAR / DAYS_PER_WEEK, entry.currency);
      if (discountComputable) {
        packageView.relativeDiscount = `${Math.round((1 - perYearMinor / maxPerYear) * PERCENT)}%`;
      }
    }

    if (typeof entry.trialDays === "number" && entry.trialDays > 0) {
      packageView.introPeriod = `${entry.trialDays} days`;
    }

    view[pkg.packageIdentifier] = packageView;
  }

  const resolvedCount = pickedById.size;
  const coverage: CanvasPriceCoverage =
    offering.packages.length > 0 && resolvedCount === offering.packages.length
      ? "full"
      : resolvedCount > 0
        ? "partial"
        : "none";
  return { view, coverage };
}

/**
 * Every package in `offering` mapped to the same `previewEligible` flag —
 * the canvas's `eligibility` input for `PaywallRenderer` (drives
 * `overrides` with `when.kind === "introEligible"`). The builder preview
 * has no real per-user entitlement/eligibility signal, so it's a single
 * top-bar toggle applied uniformly rather than per-package.
 */
export function buildEligibilityMap(
  offering: RendererOffering | null,
  previewEligible: boolean,
): Record<string, boolean> {
  if (!offering) return {};
  const out: Record<string, boolean> = {};
  for (const pkg of offering.packages) {
    out[pkg.packageIdentifier] = previewEligible;
  }
  return out;
}

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Translates the selected node's viewport rect into the scroll container's
 * local coordinate space (subtract the container's own viewport offset,
 * add its current scroll offset) so an absolutely-positioned ring inside
 * that container lands exactly over the node, scroll position included.
 */
export function computeSelectionRect(
  container: { left: number; top: number },
  scroll: { left: number; top: number },
  target: Rect,
): Rect {
  return {
    left: target.left - container.left + scroll.left,
    top: target.top - container.top + scroll.top,
    width: target.width,
    height: target.height,
  };
}

// =============================================================
// Canvas selection chrome — corner-drag resize (design-tool precision
// idiom). Only a `StackNode` carries `size?: { width?: NodeSize;
// height?: NodeSize }` in the schema (`packages/shared/src/paywall/
// schema.ts`); every other node type has no resizable box at all, so
// this is the single gate `canvas.tsx` uses to decide whether to render
// corner handles for the current selection.
// =============================================================

/** True for the one node type whose schema carries a `size` box — the
 * gate for whether the canvas renders corner resize handles at all. */
export function isResizableNode(node: PaywallNode): node is StackNode {
  return node.type === "stack";
}

/** Which corner of the selection box a resize handle/drag started from. */
export type ResizeCorner = "tl" | "tr" | "bl" | "br";

/** A `size` dimension can never be dragged smaller than this, in node px —
 * small enough to stay practically invisible-adjacent, large enough that
 * the corner handle itself (see `RESIZE_HANDLE_SIZE_PX` in canvas.tsx)
 * never has to sit outside the box it's resizing. */
export const RESIZE_MIN_SIZE_PX = 8;

/**
 * Pure corner-drag resize math. `rect` is the node's selection box in
 * canvas-CHROME coordinates (already zoom-scaled + scroll-adjusted — the
 * same space `computeSelectionRect` produces and the selection outline
 * renders in), captured once at the start of the drag; `pointer` is the
 * live pointer position in that SAME chrome space. The corner OPPOSITE
 * `corner` anchors the resize — exactly like every design tool's corner
 * handle — so the new width/height is just the chrome-space distance from
 * that fixed anchor point to the live pointer, divided by `zoom` to get
 * back to node px (the box on screen is zoom-scaled, node px isn't).
 * Result is rounded to the nearest integer and clamped to
 * `RESIZE_MIN_SIZE_PX`.
 */
export function computeResizedSize(
  corner: ResizeCorner,
  pointer: { x: number; y: number },
  rect: Rect,
  zoom: number,
): { width: number; height: number } {
  const anchorX = corner === "tl" || corner === "bl" ? rect.left + rect.width : rect.left;
  const anchorY = corner === "tl" || corner === "tr" ? rect.top + rect.height : rect.top;
  const widthChrome = Math.abs(pointer.x - anchorX);
  const heightChrome = Math.abs(pointer.y - anchorY);
  const width = Math.max(RESIZE_MIN_SIZE_PX, Math.round(widthChrome / zoom));
  const height = Math.max(RESIZE_MIN_SIZE_PX, Math.round(heightChrome / zoom));
  return { width, height };
}
