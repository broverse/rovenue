import type { BuilderConfig, PackageView } from "@rovenue/shared/paywall";

// =============================================================
// Renderer-facing types. `RendererOffering` is a deliberately
// loose SUBSET of the real /v1/placements `offering.packages`
// shape (see apps/api/src/lib/offering-hydration.ts) — this
// package has no SDK/network access and must accept whatever
// extra fields the host app's offering object carries (price,
// store metadata, etc.) without needing to know about them.
// =============================================================

export type RendererPackage = {
  packageIdentifier: string;
  displayName: string;
  metadata?: unknown;
  storeIds?: Record<string, string>;
};

export type RendererOffering = {
  identifier: string;
  packages: RendererPackage[];
};

export type PaywallRendererProps = {
  config: BuilderConfig;
  offering: RendererOffering | null;
  locale?: string;
  colorScheme: "light" | "dark";
  /**
   * Package -> {{variable}} substitution values, keyed by packageIdentifier.
   * Price fields aren't derivable from the minimal `RendererOffering`
   * contract alone (this package has no SDK/network access); the consumer
   * supplies formatted price strings here (dashboard preview passes
   * placeholder views, web consumers pass real store-formatted prices).
   */
  priceView?: Record<string, PackageView>;
  onPurchase: (packageIdentifier: string) => void;
  onClose?: () => void;
  onRestore?: () => void;
  onUrl?: (url: string) => void;
};
