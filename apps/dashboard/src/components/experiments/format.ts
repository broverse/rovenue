import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  ExperimentDecisionGate,
  ExperimentListItem,
  ExperimentRecommendation,
  ExperimentResultsResponse,
} from "@rovenue/shared";
import type {
  ExperimentGroup,
  ExperimentStatus,
  ExperimentSummary,
  ResultVariantRow,
  VariantColorToken,
} from "./types";

// =============================================================
// API → UI mapping
// =============================================================
//
// Backend stores its own enum (DRAFT/RUNNING/PAUSED/COMPLETED).
// We mirror it as lowercase so the list/hero/dot can branch on a
// single string without re-importing the API enum.
function uiStatus(s: DashboardExperimentStatus): ExperimentStatus {
  if (s === "DRAFT") return "draft";
  if (s === "COMPLETED") return "completed";
  if (s === "PAUSED") return "paused";
  return "running";
}

// The dashboard tags experiments with a `group` chip purely for
// visual grouping. The backend doesn't carry that signal, so we
// derive a reasonable default from the experiment type until the
// dashboard exposes a real group field.
function groupFromType(t: DashboardExperimentType): ExperimentGroup {
  if (t === "PAYWALL") return "paywall";
  if (t === "FLAG") return "engagement";
  if (t === "OFFERING") return "monetization";
  return "onboarding";
}

/**
 * Column-visibility predicate for the variants table's "Attributed"
 * column: PAYWALL-type experiments are the only ones whose purchases
 * carry `presentedContext` (raw_revenue_events.experimentKey/variantId,
 * CH migration 0019), so precise attribution only exists for them —
 * OFFERING/FLAG experiment types keep the post-exposure heuristic
 * `conversions` column as today.
 *
 * `group` (not the raw API `type`) is the signal available on this page:
 * `mapApiExperiment` derives it via `groupFromType`, and PAYWALL is the
 * only backend type that maps to the `"paywall"` group.
 */
export function isPaywallExperimentGroup(group: ExperimentGroup): boolean {
  return group === "paywall";
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

function shortMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface AgeLabel {
  ageLabelKey: string;
  ageLabelValues?: Readonly<Record<string, string | number>>;
}

function ageLabel(
  status: ExperimentStatus,
  startedAt: string | null,
  completedAt: string | null,
): AgeLabel {
  if (status === "draft") {
    return { ageLabelKey: "experiments.list.age.draft" };
  }
  if (status === "completed" && completedAt) {
    return {
      ageLabelKey: "experiments.list.age.completedOn",
      ageLabelValues: { date: shortMonthDay(completedAt) },
    };
  }
  // running / paused — count days since startedAt
  return {
    ageLabelKey: "experiments.list.age.runningDays",
    ageLabelValues: { days: daysSince(startedAt) },
  };
}

/**
 * The decision-derived slice of `ExperimentSummary` — `confidence`,
 * `leadingVariant`, `shipRecommended` — computed from the live results
 * endpoint. Pulled out of `mapApiExperiment` so there is exactly one
 * place that can produce these three fields, and exactly one neutral
 * default (`NO_DECISION_YET`) for "results aren't hydrated yet" that
 * every caller shares instead of each re-inventing its own zero/null.
 */
type DecisionFields = Pick<
  ExperimentSummary,
  "confidence" | "leadingVariant" | "shipRecommended" | "lift"
>;

// `lift: 0` already means "no known lift" throughout this module (see
// `mapApiExperiment`'s un-hydrated default) — `experiments-list.tsx` hides
// the lift pill entirely at 0, so reusing it here for "not computed" is
// consistent with the rest of the file, not a new fabricated flat value.
const NO_DECISION_YET: DecisionFields = {
  confidence: null,
  leadingVariant: null,
  shipRecommended: false,
  lift: 0,
};

function decisionFieldsFromResults(
  results: ExperimentResultsResponse | null | undefined,
): DecisionFields {
  if (!results) return NO_DECISION_YET;
  const { recommendation } = results;
  const leader = recommendation.leadingVariantId
    ? results.variants.find(
        (v) => v.variantId === recommendation.leadingVariantId,
      )
    : undefined;
  const control = results.variants.find((v) => v.variantId === "control");
  const lift =
    leader?.posteriorMean != null && control?.posteriorMean
      ? ((leader.posteriorMean - control.posteriorMean) /
          control.posteriorMean) *
        100
      : 0;
  return {
    // `probabilityBest` is the leader's own posterior probability of
    // being best — the only number honestly called "confidence" here.
    confidence: leader?.probabilityBest ?? null,
    leadingVariant: recommendation.leadingVariantId,
    shipRecommended: recommendation.shipRecommended,
    lift,
  };
}

/**
 * Maps an `ExperimentListItem` from the API to the richer
 * `ExperimentSummary` shape the dashboard's list + hero render
 * against. `results` is optional because most callers (the experiments
 * list, the sidebar) only have the list item — for those, the decision
 * fields come back `null`/`false` from `NO_DECISION_YET` rather than a
 * fabricated zero. The one call site that has fetched live results
 * (`ExperimentDetailPanel`) passes them so the hero and "ship winner"
 * banner see the real decision instead of a permanently-hidden one.
 */
export function mapApiExperiment(
  item: ExperimentListItem,
  results?: ExperimentResultsResponse | null,
): ExperimentSummary {
  const status = uiStatus(item.status);
  const metric = item.metrics?.[0] ?? "";
  const description = item.description ?? "";
  const age = ageLabel(status, item.startedAt, item.completedAt);
  const decision = decisionFieldsFromResults(results);

  return {
    id: item.id,
    key: item.key,
    status,
    description,
    metric,
    started: item.startedAt,
    days: daysSince(item.startedAt),
    ageLabelKey: age.ageLabelKey,
    ...(age.ageLabelValues ? { ageLabelValues: age.ageLabelValues } : {}),
    variantCount: item.variants.length,
    assigned: 0,
    outcome: "",
    group: groupFromType(item.type),
    winner: item.winnerVariantId,
    // confidence, leadingVariant, shipRecommended, lift
    ...decision,
  };
}


/**
 * Maps a variant color token to its CSS color value. The accent token
 * resolves to the dashboard's accent variable so it auto-tints when the
 * accent hue is changed.
 */
export const variantColor = (token: VariantColorToken): string => {
  if (token === "primary") return "var(--color-rv-accent-500)";
  if (token === "violet") return "var(--color-rv-violet)";
  return "var(--color-rv-mute-500)";
};

// =============================================================
// Live results (/dashboard/experiments/:id/results) → view-model
// =============================================================
//
// The results endpoint degrades to `variants: []` whenever ClickHouse
// is unconfigured OR the experiment genuinely has zero exposures yet
// (see apps/api/src/services/experiment-results.ts — the CH query only
// ever returns a row for a variant that had at least one exposure
// event). That single fact is what lets the mapping below stay honest:
// there is no "populate every configured variant, zero-fill the rest"
// step anywhere, so the UI can never mistake "no data" for "a real 0%
// result".

const VARIANT_COLOR_CYCLE: ReadonlyArray<VariantColorToken> = [
  "default",
  "primary",
  "violet",
];

function colorForIndex(i: number): VariantColorToken {
  return VARIANT_COLOR_CYCLE[i % VARIANT_COLOR_CYCLE.length]!;
}

/**
 * Maps the live results payload to per-variant table/funnel rows.
 * `attributedConversions` is only surfaced when `showAttributed` (the
 * PAYWALL-gated column from D-12) — other experiment types never
 * carried that signal, so gating doubles as row-shaping: components
 * never receive a real-looking 0 for data that was never tracked.
 */
export function mapResultsVariants(
  results: Pick<ExperimentResultsResponse, "variants"> | null | undefined,
  showAttributed: boolean,
): ResultVariantRow[] {
  const rows = results?.variants ?? [];
  return rows.map((v, i) => ({
    variantId: v.variantId,
    exposures: v.exposures,
    uniqueUsers: v.uniqueUsers,
    attributedConversions: showAttributed ? v.attributedConversions : null,
    colorToken: colorForIndex(i),
    // Best-effort: the wire type carries no explicit "is control" flag,
    // but `control` is the conventional id (see new-experiment's
    // variantId placeholder) — purely cosmetic (badge suffix), never
    // used to pick which numbers to show.
    isControl: v.variantId === "control",
    sufficientData: v.sufficientData,
    posteriorMean: v.posteriorMean,
    credibleIntervalLow: v.credibleIntervalLow,
    credibleIntervalHigh: v.credibleIntervalHigh,
    probabilityBest: v.probabilityBest,
    expectedLoss: v.expectedLoss,
  }));
}

// =============================================================
// The decision verdict — "not enough data" vs "no difference"
// =============================================================
//
// `recommendation.blockedBy` is ordered by evaluation (see
// `ExperimentDecisionGate` in packages/shared/src/dashboard.ts), so
// `blockedBy[0]` is the primary reason there is no recommendation. The
// three buckets below turn that single gate into the one thing a reader
// actually needs to know: is the experiment still collecting evidence,
// or has it collected enough to say the variants don't differ, or is
// something wrong with the data itself. `EXPECTED_LOSS` is the only gate
// left once the data-volume and integrity buckets are excluded, and it
// means exactly "we looked, and it's too close to call" — the opposite
// of "we haven't looked long enough".

const DATA_VOLUME_GATES: ReadonlySet<ExperimentDecisionGate> = new Set([
  "SAMPLE_SIZE",
  "RUNTIME",
  "NO_LEADER",
]);

const INTEGRITY_GATES: ReadonlySet<ExperimentDecisionGate> = new Set([
  "SRM",
  "CROSSOVER",
  "REFUND_GUARDRAIL",
  "PROCEEDS_RATE_UNCONFIGURED",
]);

export type ExperimentDecisionState =
  | "ship"
  | "insufficientData"
  | "noDifference"
  | "integrityBlocked";

/**
 * Classifies a recommendation into the four verdict states the analysis
 * card renders with distinct copy and treatment. Never called on a
 * `null` results payload — the card has its own "no live results" branch
 * for that, so this only ever sees a real, evaluated recommendation.
 */
export function decisionState(
  recommendation: ExperimentRecommendation,
): ExperimentDecisionState {
  if (recommendation.shipRecommended) return "ship";
  const primary = recommendation.blockedBy[0];
  if (primary && INTEGRITY_GATES.has(primary)) return "integrityBlocked";
  if (primary && DATA_VOLUME_GATES.has(primary)) return "insufficientData";
  // Nothing left but EXPECTED_LOSS (or an empty list on a recommendation
  // that is somehow not shipRecommended — treated the same way: enough
  // data and runtime, still not confident enough to call a winner).
  return "noDifference";
}

/**
 * True once the results endpoint has at least one variant row — the
 * "no exposures yet" (or "ClickHouse unconfigured") case is an empty
 * array, never zero-value rows, so this is the single honest gate for
 * every live card on the detail panel.
 */
export function hasLiveResultsData(
  results: Pick<ExperimentResultsResponse, "variants"> | null | undefined,
): boolean {
  return (results?.variants.length ?? 0) > 0;
}

export type FunnelSeriesStage = {
  key: "exposures" | "uniqueUsers" | "attributed";
  labelKey: string;
  values: ReadonlyArray<{
    variantId: string;
    value: number;
    colorToken: VariantColorToken;
  }>;
};

/**
 * Builds the funnel's stages from live variant rows: exposures →
 * exposed users always, plus an attributed-conversions stage only when
 * `showAttributed` — there is no viewed/CTA/trial per-step breakdown in
 * the results payload, so the funnel reflects exactly the three counts
 * the API actually returns rather than inventing intermediate steps.
 */
export function buildFunnelStages(
  variants: ReadonlyArray<ResultVariantRow>,
  showAttributed: boolean,
): FunnelSeriesStage[] {
  const stages: FunnelSeriesStage[] = [
    {
      key: "exposures",
      labelKey: "experiments.funnel.stages.exposures.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.exposures,
        colorToken: v.colorToken,
      })),
    },
    {
      key: "uniqueUsers",
      labelKey: "experiments.funnel.stages.uniqueUsers.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.uniqueUsers,
        colorToken: v.colorToken,
      })),
    },
  ];
  if (showAttributed) {
    stages.push({
      key: "attributed",
      labelKey: "experiments.funnel.stages.attributed.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.attributedConversions ?? 0,
        colorToken: v.colorToken,
      })),
    });
  }
  return stages;
}
