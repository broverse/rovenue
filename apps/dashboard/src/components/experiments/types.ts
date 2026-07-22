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

/** A single arm of an experiment. */
export type Variant = {
  id: string;
  label: string;
  description: string;
  /** 0..1 share of traffic. */
  allocation: number;
  users: number;
  conversions: number;
  /**
   * Precisely-attributed conversions (raw_revenue_events.experimentKey/
   * variantId — the purchase's own presentedContext, no exposure-join
   * heuristic). Only meaningful for PAYWALL-type experiments; undefined
   * elsewhere, in which case the UI falls back gracefully.
   */
  attributedConversions?: number;
  /** 0..1 conversion rate. */
  rate: number;
  /** ARPU in dollars. */
  arpu: number;
  mrr: number;
  /** Lift vs control in percent (signed). 0 for control. */
  lift: number;
  ciLow: number;
  ciHigh: number;
  isControl: boolean;
  /** Token from the design palette: `default`, `primary`, `violet`. */
  colorToken: VariantColorToken;
};

export type VariantColorToken = "default" | "primary" | "violet";

export type TimelineEntry = {
  whenKey: string;
  whenValues?: Readonly<Record<string, string | number>>;
  titleKey: string;
  subKey: string;
  subValues?: Readonly<Record<string, string | number>>;
  /** Dot tint — uses CSS variables. */
  tone: "primary" | "success" | "warning" | "muted";
};

export type FunnelStage = {
  stageKey: string;
  subKey: string;
  ctrl: number;
  a: number;
  b: number;
};

export type ExperimentDetail = {
  metricNameKey: string;
  metricDescriptionKey: string;
  owner: string;
  segments: ReadonlyArray<string>;
  allocationKey: string;
  variants: ReadonlyArray<Variant>;
  timeline: ReadonlyArray<TimelineEntry>;
  funnel: ReadonlyArray<FunnelStage>;
};

export type CumulativePoint = {
  day: number;
  ctrl: number;
  a: number;
  b: number;
};
