import type { VisibilityPlatform } from "@rovenue/shared/paywall";
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
  /** Where this paywall is being rendered. Absent means unknown, which
   * makes every node `visibility` rule fail open. */
  platform?: VisibilityPlatform | null;
  /** Host app version, for a node's min/max bounds. Absent fails open. */
  appVersion?: string | null;

  config: BuilderConfig;
  offering: RendererOffering | null;
  locale?: string;
  colorScheme: "light" | "dark";
  /**
   * The "current" instant the renderer treats as now — drives the countdown
   * node's remaining-time calculation. Defaults to `new Date()`. A renderer
   * whose output depends on the wall clock is otherwise untestable; the same
   * injection point lets the dashboard's canvas preview pin a fixed instant.
   */
  now?: Date;
  /**
   * The instant this paywall was FIRST shown to this user, anchoring a
   * `durationSeconds` countdown's deadline (`endsAt` countdowns ignore this
   * entirely — they carry their own absolute deadline). The renderer itself
   * is presentational and owns no storage, so the HOST looks the instant up
   * and supplies it: the native SDKs from `UserDefaults`/`SharedPreferences`,
   * web hosts from `resolvePersistedFirstShownAt` (this package's
   * `localStorage` helper, same key as the natives).
   *
   * Absent, the countdown anchors to mount time — which restarts its
   * deadline on every remount. That is the right answer for an AUTHORING
   * preview (a persisted anchor would leave the builder canvas showing a
   * permanently expired countdown) and the wrong one for a buyer-facing
   * surface, because a timer that restarts on every open is not a deadline
   * and users notice.
   */
  firstShownAt?: Date;
  /**
   * Package -> {{variable}} substitution values, keyed by packageIdentifier.
   * Price fields aren't derivable from the minimal `RendererOffering`
   * contract alone (this package has no SDK/network access); the consumer
   * supplies formatted price strings here (dashboard preview passes
   * placeholder views, web consumers pass real store-formatted prices).
   */
  priceView?: Record<string, PackageView>;
  /**
   * Package -> intro-offer eligibility, keyed by packageIdentifier. Drives
   * `overrides` with `when.kind === "introEligible"`. A package absent from
   * this map is treated as NOT eligible — same as the prop being omitted
   * entirely (eligibility is opt-in, never assumed).
   */
  eligibility?: Record<string, boolean>;
  onPurchase: (packageIdentifier: string) => void;
  onClose?: () => void;
  onRestore?: () => void;
  onUrl?: (url: string) => void;
};
