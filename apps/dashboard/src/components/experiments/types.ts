export type ExperimentStatus =
  | "running"
  | "completed"
  | "stopped"
  | "draft"
  | "paused";

export type ExperimentScope = "running" | "completed" | "draft" | "all";

export type ExperimentGroup =
  | "pricing"
  | "trial"
  | "paywall"
  | "onboarding"
  | "engagement"
  | "monetization";

export type ExperimentSummary = {
  /** Database id (cuid2) — used for all backend-bound calls + routing. */
  id: string;
  /** Slug shown to humans (e.g. `paywall_test`). Stable in the SDK lookup. */
  key: string;
  status: ExperimentStatus;
  description: string;
  metric: string;
  /** ISO start date or null for drafts. */
  started: string | null;
  /** Days since start; 0 for drafts. */
  days: number;
  /** Pre-formatted age label, e.g. "12d running" or "Completed Apr 9". */
  ageLabelKey: string;
  ageLabelValues?: Readonly<Record<string, string | number>>;
  variantCount: number;
  assigned: number;
  /** 0..1 confidence value. */
  confidence: number;
  /** "win" / "loss" / "" — drives the confidence bar tint. */
  outcome: "win" | "loss" | "";
  group: ExperimentGroup;
  /** Estimated lift in percent (signed). */
  lift: number;
  /** Variant id of the shipped winner, "control" if control prevailed. */
  winner: string | null;
  /**
   * Variant id currently leading on the primary metric (pre-ship), used
   * by the "ship winner" banner. `null` until the results endpoint
   * hydrates it — the banner stays hidden rather than naming a guess.
   */
  leadingVariant: string | null;
};

export type VariantColorToken = "default" | "primary" | "violet";

/**
 * One variant's row for the live results table / funnel — built from
 * `ExperimentResultsResponse.variants[]` (see `mapResultsVariants` in
 * `format.ts`). `attributedConversions` is `null` when the experiment
 * type doesn't carry PAYWALL `presentedContext` (see
 * `isPaywallExperimentGroup`) — genuinely not tracked for that type,
 * never a fabricated zero.
 */
export type ResultVariantRow = {
  variantId: string;
  exposures: number;
  uniqueUsers: number;
  attributedConversions: number | null;
  colorToken: VariantColorToken;
  isControl: boolean;
};

/**
 * Minimal slice `AllocationCard` needs to draw the traffic pie —
 * derived from the experiment's own variant definitions (`weight`),
 * not the results endpoint.
 */
export type AllocationSlice = {
  id: string;
  /** 0..1 share of traffic. */
  allocation: number;
  colorToken: VariantColorToken;
};
