import type { DashboardOfferingRow } from "@rovenue/shared";
import type { PackageView } from "@rovenue/shared/paywall";
import type { RendererOffering } from "@rovenue/paywall-renderer";

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
