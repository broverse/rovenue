import { useMemo } from "react";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { PaywallRenderer, type RendererOffering } from "@rovenue/paywall-renderer";
import { placeholderPriceView } from "./canvas-helpers";

// =============================================================
// A gallery card's preview: the template's REAL tree, through the real
// renderer, scaled down.
//
// This replaces the abstract silhouette (`start-model.ts`), which was the
// right call for two presets and stops informing at eighteen — four
// minimal templates produce four indistinguishable stacks of bars, and a
// silhouette cannot show copy, so nothing on the card says what makes one
// template different from its neighbour.
//
// A template has no project offering to bind to, so this reuses the path
// the builder canvas already has for exactly that situation: a synthetic
// offering plus `placeholderPriceView`'s clearly-preview-only prices
// (`canvas-helpers.ts`). No new rendering mode is needed — `PaywallRenderer`
// is an ordinary React component, and the canvas already proves it scales
// under a CSS transform.
// =============================================================

/**
 * Three packages, so a `packageList` renders as a list rather than a single
 * row, and `placeholderPriceView` cycles through all three of its price
 * presets instead of repeating one.
 */
export const TEMPLATE_PREVIEW_OFFERING: RendererOffering = {
  identifier: "template-preview",
  packages: [
    { packageIdentifier: "monthly", displayName: "Monthly" },
    { packageIdentifier: "annual", displayName: "Annual" },
    { packageIdentifier: "weekly", displayName: "Weekly" },
  ],
};

/** Viewport the tree renders at before scaling — a 390pt-class phone, the
 *  same width class the builder canvas previews. */
export const TEMPLATE_PREVIEW_WIDTH = 390;
export const TEMPLATE_PREVIEW_HEIGHT = 780;

/**
 * Pinned "now" for the preview clock. A countdown template anchored to
 * mount time would re-render a slightly different card on every open and
 * make the gallery's snapshots non-deterministic; the card only needs to
 * show that a countdown is THERE.
 */
const PREVIEW_NOW = new Date("2026-01-01T00:00:00Z");

const noop = () => {};

type Props = {
  config: BuilderConfig;
  /** Card width / TEMPLATE_PREVIEW_WIDTH. */
  scale: number;
  colorScheme: "light" | "dark";
  locale?: string;
};

export function TemplatePreview({ config, scale, colorScheme, locale }: Props) {
  const priceView = useMemo(() => placeholderPriceView(TEMPLATE_PREVIEW_OFFERING), []);

  return (
    <div
      // The card is a picture, not a control: the whole preview is inert so a
      // click lands on the card's own button rather than on a link inside the
      // rendered paywall.
      style={{
        width: TEMPLATE_PREVIEW_WIDTH * scale,
        height: TEMPLATE_PREVIEW_HEIGHT * scale,
        overflow: "hidden",
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <div
        style={{
          width: TEMPLATE_PREVIEW_WIDTH,
          height: TEMPLATE_PREVIEW_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <PaywallRenderer
          config={config}
          offering={TEMPLATE_PREVIEW_OFFERING}
          locale={locale ?? config.defaultLocale}
          colorScheme={colorScheme}
          priceView={priceView}
          now={PREVIEW_NOW}
          // Every action handler is supplied even though none does anything:
          // the renderer HIDES a restore control when no `onRestore` is given
          // (an inert-but-visible restore button implies restore is possible),
          // so omitting them would drop the footer's Restore link from the
          // card and preview a footer the author will never see.
          onPurchase={noop}
          onClose={noop}
          onRestore={noop}
          onUrl={noop}
        />
      </div>
    </div>
  );
}
