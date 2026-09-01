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
  /**
   * The leading variant's `probabilityBest` from the results endpoint
   * (0..1), or `null` when there is no live decision yet — no results,
   * or no leader identified. Never a fabricated `0`, which would read
   * as "confidently against" rather than "unknown".
   */
  confidence: number | null;
  /** "win" / "loss" / "" — drives the confidence bar tint. */
  outcome: "win" | "loss" | "";
  group: ExperimentGroup;
  /** Estimated lift in percent (signed). */
  lift: number;
  /** Variant id of the shipped winner, "control" if control prevailed. */
  winner: string | null;
  /**
   * `recommendation.leadingVariantId` from the results endpoint, used by
   * the "ship winner" banner to name a variant. `null` until results are
   * hydrated, or when a suppression gate withholds the leader entirely —
   * the banner stays hidden rather than naming a guess.
   */
  leadingVariant: string | null;
  /**
   * `recommendation.shipRecommended` from the results endpoint — `true`
   * only once every clause of the decision engine's stopping rule
   * passed. This is the ONLY value allowed to gate the "ship winner"
   * banner — never a bare confidence number, never a p-value. Defaults
   * to `false` (never a guess) until results are hydrated.
   */
  shipRecommended: boolean;
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
  /**
   * `false` when the posterior could not be fitted for this variant — the
   * five fields below are then all `null` on the wire (see
   * `ExperimentResultsVariant.sufficientData`). A row with `false` here
   * gets its own "not enough data yet" treatment rather than rendering
   * `null` as a dash next to numbers that look computed.
   */
  sufficientData: boolean;
  posteriorMean: number | null;
  credibleIntervalLow: number | null;
  credibleIntervalHigh: number | null;
  probabilityBest: number | null;
  expectedLoss: number | null;
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
