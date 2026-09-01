import { drizzle } from "@rovenue/db";
import type { Store } from "@rovenue/db";
import type {
  ExperimentDecisionGate,
  ExperimentPrimaryMetric,
  ExperimentRecommendation,
  ExperimentResultsResponse,
  ExperimentResultsVariant,
} from "@rovenue/shared";

import {
  analyzeBayesian,
  type BayesianVariantInput,
  type VariantPosterior,
} from "../lib/experiment-bayes";
import {
  CROSSOVER_SUPPRESSION_RATE,
  DAYS_PER_WEEK,
  EXPECTED_LOSS_THRESHOLD,
  MINIMUM_WEEKLY_CYCLES,
  REFUND_GUARDRAIL_MARGIN,
} from "../lib/experiment-constants";
import {
  analyzeConversion,
  checkSRM,
  estimateSampleSize,
} from "../lib/experiment-stats";
import {
  computeNetRevenue,
  computeProceeds,
  resolveCommissionRate,
} from "./metrics/proceeds";
import {
  runAnalyticsQuery,
  type ExperimentStoreRevenueRow,
  type ExperimentVariantRow,
} from "./analytics-router";

// =============================================================
// Experiment results service — the single results path
// =============================================================
//
// This is the ONLY results implementation. The assignment-table path that
// used to live in `experiment-engine.ts` (`getExperimentResults`) is gone;
// both the dashboard route and the SDK route call in here, so the two can
// never report divergent numbers for one experiment.
//
// -------------------------------------------------------------
// TWO DENOMINATORS, AND THEY ARE NOT INTERCHANGEABLE
// -------------------------------------------------------------
//
// `ExperimentVariantRow` carries both, deliberately:
//
//   unique_users / conversions   un-windowed exposure-join figures. USED
//                                ONLY FOR SRM (and passed through for
//                                back-compat). They include subscribers
//                                whose maturation window has not elapsed
//                                and subscribers contaminated by exposure
//                                to more than one variant.
//   mature_users / converters    windowed, crossover-excluded and
//                                net-positive-revenue figures. THE metric
//                                denominator/numerator — the conversion
//                                rate and every posterior below.
//
// SRM must keep the un-windowed pair precisely because it is checking the
// randomiser's split, which happens at exposure time and knows nothing
// about maturation. Using the windowed pair for the metric is what removes
// the exposure-age bias: a subscriber exposed yesterday has had one day to
// convert and would otherwise dilute whichever arm happened to be running
// hottest most recently.
//
// -------------------------------------------------------------
// THE STOPPING RULE
// -------------------------------------------------------------
//
// A leader is shippable only when ALL of:
//   1. its expected loss, as a FRACTION of the control's posterior mean,
//      is below EXPECTED_LOSS_THRESHOLD (the threshold is defined
//      relative, so it means the same thing for a conversion rate and for
//      ARPU),
//   2. every arm has reached the estimated required sample size,
//   3. at least MINIMUM_WEEKLY_CYCLES whole weeks have elapsed since the
//      experiment started, and
//   4. no integrity check or guardrail has fired.
//
// Clause 3 is not implied by clause 2: a high-traffic app clears any
// sample threshold inside a single weekday, and shipping on one weekday's
// user mix is the classic novelty / day-of-week trap.
//
// Clause 4's three checks — SRM, crossover contamination, and the refund
// guardrail — SUPPRESS rather than annotate. When one fires,
// `leadingVariantId` is withheld entirely: a recommendation rendered next
// to a warning gets shipped anyway.
//
// What expected loss buys: it bounds expected regret UNDER THE MODEL'S
// PRIOR. It is not a Type-I error rate, and this service does not claim
// continuous monitoring is "safe" in a frequentist sense. `conversion`
// below is the fixed-horizon frequentist cross-check and is valid only at
// the planned sample size.

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days an experiment must run before any recommendation. */
const MINIMUM_RUNTIME_DAYS = MINIMUM_WEEKLY_CYCLES * DAYS_PER_WEEK;

type ExperimentStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";

export type ExperimentResults = ExperimentResultsResponse;

/** The subset of the `experiments` row this service reads. */
interface ExperimentRecord {
  id: string;
  key: string;
  projectId: string;
  status: string;
  primaryMetric: string;
  /** `numeric(5,4)` — Drizzle's numeric mode hands this back as a STRING. */
  minimumDetectableEffect: string | number;
  startedAt: Date | null;
  variants: unknown;
}

interface DeclaredVariant {
  id: string;
  weight: number;
}

/** Everything the decision rule needs about one variant, assembled from
 *  the CH row plus the posterior. */
interface VariantAgg {
  variantId: string;
  exposures: number;
  uniqueUsers: number;
  attributedConversions: number;
  matureUsers: number;
  converters: number;
  conversionRate: number | null;
  revenueUsd: number;
  refundsUsd: number;
  refundRate: number | null;
  excludedImmature: number;
  excludedCrossover: number;
}

export async function computeExperimentResults(
  experimentId: string,
  projectId: string,
): Promise<ExperimentResults> {
  const experiment = (await drizzle.experimentRepo.findExperimentById(
    drizzle.db,
    experimentId,
  )) as ExperimentRecord | null;
  if (!experiment || experiment.projectId !== projectId) {
    throw new Error("experiment not found");
  }

  const rows = await runAnalyticsQuery({
    kind: "experiment_results",
    experimentId,
    experimentKey: experiment.key,
    projectId,
  });

  const primaryMetric = experiment.primaryMetric as ExperimentPrimaryMetric;
  const declared = readDeclaredVariants(experiment.variants);
  const aggregates = rows.map(toAggregate);

  // -----------------------------------------------------------
  // Value scaling for PROCEEDS_PER_USER
  // -----------------------------------------------------------
  //
  // The reader's log-value aggregates are over NET revenue. Proceeds are
  // net revenue times (1 − commission rate), and the rate is per store,
  // so the scale factor is resolved per (variant, store) and combined into
  // one per-variant factor. A store with no configured rate makes the
  // metric unknown for the WHOLE experiment — reported as unknown rather
  // than silently substituting that store's gross revenue, which is the
  // same honesty rule `ProceedsCard` renders.
  const proceeds =
    primaryMetric === "PROCEEDS_PER_USER"
      ? await resolveProceedsFactors(experimentId, projectId)
      : { known: true, factorByVariant: new Map<string, number>() };

  // -----------------------------------------------------------
  // Posteriors (Bayesian, on the primary metric)
  // -----------------------------------------------------------
  const posteriors = aggregates.length
    ? analyzeBayesian({
        experimentId,
        metricType: primaryMetric,
        variants: aggregates.map((a) =>
          toBayesianInput(
            a,
            rowFor(rows, a.variantId),
            primaryMetric,
            proceeds,
          ),
        ),
      }).variants
    : [];
  const posteriorByVariant = new Map<string, VariantPosterior>(
    posteriors.map((p) => [p.key, p]),
  );

  const variants: ExperimentResultsVariant[] = aggregates.map((a) => {
    const p = sanitisePosterior(posteriorByVariant.get(a.variantId));
    return {
      variantId: a.variantId,
      exposures: a.exposures,
      uniqueUsers: a.uniqueUsers,
      attributedConversions: a.attributedConversions,
      matureUsers: a.matureUsers,
      converters: a.converters,
      conversionRate: a.conversionRate,
      revenueUsd: a.revenueUsd,
      refundsUsd: a.refundsUsd,
      refundRate: a.refundRate,
      excludedImmature: a.excludedImmature,
      excludedCrossover: a.excludedCrossover,
      posteriorMean: p?.mean ?? null,
      credibleIntervalLow: p?.credibleInterval?.[0] ?? null,
      credibleIntervalHigh: p?.credibleInterval?.[1] ?? null,
      probabilityBest: p?.probabilityBest ?? null,
      expectedLoss: p?.expectedLoss ?? null,
      sufficientData: p?.sufficientData ?? false,
    };
  });

  // -----------------------------------------------------------
  // Integrity: SRM over the EXPOSED-user split, crossover rate
  // -----------------------------------------------------------
  const srm =
    aggregates.length >= 2
      ? checkSRM(expectedObservedSplit(aggregates, declared))
      : null;
  const crossoverRate = computeCrossoverRate(aggregates);

  // -----------------------------------------------------------
  // Frequentist cross-check (fixed-horizon; never the decision)
  // -----------------------------------------------------------
  const control = resolveControl(aggregates, declared);
  const conversion = buildPairwiseConversion(aggregates, control);

  // -----------------------------------------------------------
  // Sample size — the experiment's OWN minimum detectable effect
  // -----------------------------------------------------------
  const sampleSize = estimateRequiredSample(experiment, control, aggregates);

  const runtimeDays =
    experiment.startedAt === null
      ? null
      : Math.floor(
          (Date.now() - experiment.startedAt.getTime()) / MILLISECONDS_PER_DAY,
        );

  const recommendation = decide({
    variants,
    control,
    srmMismatch: srm?.isMismatch ?? false,
    crossoverRate,
    sampleReached: sampleSize?.reached ?? false,
    runtimeDays,
    proceedsKnown: proceeds.known,
  });

  return {
    experimentId,
    status: experiment.status as ExperimentStatus,
    primaryMetric,
    variants,
    conversion,
    // Welch's t-test needs a per-subscriber revenue series, which the
    // aggregate reader deliberately does not ship (it returns sufficient
    // statistics, not per-row arrays). Left null rather than fitted to a
    // stand-in series that would look like a cross-check and not be one.
    revenue: null,
    integrity: { srm, crossoverRate },
    sampleSize,
    runtimeDays,
    recommendation,
  };
}

// =============================================================
// Row → aggregate
// =============================================================

function toAggregate(r: ExperimentVariantRow): VariantAgg {
  const matureUsers = Number(r.mature_users);
  const converters = Number(r.converters);
  const revenueUsd = Number(r.revenue_usd);
  const refundsUsd = Number(r.refunds_usd);
  return {
    variantId: r.variant_id,
    exposures: Number(r.exposures),
    uniqueUsers: Number(r.unique_users),
    attributedConversions: Number(r.attributed_conversions),
    matureUsers,
    converters,
    // `null`, never 0 — "no mature users yet" and "nobody converted" are
    // different answers and must not render as the same number.
    conversionRate: matureUsers > 0 ? converters / matureUsers : null,
    revenueUsd,
    refundsUsd,
    refundRate: revenueUsd > 0 ? refundsUsd / revenueUsd : null,
    excludedImmature: Number(r.excluded_immature),
    excludedCrossover: Number(r.excluded_crossover),
  };
}

function rowFor(
  rows: ExperimentVariantRow[],
  variantId: string,
): ExperimentVariantRow {
  return rows.find((r) => r.variant_id === variantId)!;
}

/**
 * A posterior whose fields are not all finite is not a posterior. This is
 * defence in depth at the integration point, not a substitute for the
 * fit's own guards: a NaN that reached `decide` would compare `false`
 * against every threshold, so the expected-loss gate would PASS on a
 * variant whose posterior was never fitted and the engine would recommend
 * shipping it. Degrading to `sufficientData: false` routes it to the
 * `NO_LEADER` path instead, which is the honest answer.
 */
function sanitisePosterior(
  p: VariantPosterior | undefined,
): VariantPosterior | undefined {
  if (!p || !p.sufficientData) return p;
  const finite = (n: number | null): boolean => n === null || Number.isFinite(n);
  const ok =
    finite(p.mean) &&
    finite(p.probabilityBest) &&
    finite(p.expectedLoss) &&
    (p.credibleInterval === null ||
      (Number.isFinite(p.credibleInterval[0]) &&
        Number.isFinite(p.credibleInterval[1])));
  if (ok) return p;
  return {
    key: p.key,
    mean: null,
    credibleInterval: null,
    probabilityBest: null,
    expectedLoss: null,
    sufficientData: false,
  };
}

// =============================================================
// Declared variants (weights + control resolution)
// =============================================================

function readDeclaredVariants(value: unknown): DeclaredVariant[] {
  if (!Array.isArray(value)) return [];
  const out: DeclaredVariant[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const { id, weight } = v as { id?: unknown; weight?: unknown };
    if (typeof id !== "string") continue;
    out.push({
      id,
      weight: typeof weight === "number" && Number.isFinite(weight) ? weight : 0,
    });
  }
  return out;
}

/**
 * Control is the FIRST DECLARED variant that actually has exposures — the
 * repo's convention (the new-experiment form seeds `control` as the first
 * variant id). Falls back to the first row when the experiment's declared
 * variants can't be read, so a malformed `variants` blob degrades to "the
 * first arm ClickHouse returned" rather than throwing.
 */
function resolveControl(
  aggregates: VariantAgg[],
  declared: DeclaredVariant[],
): VariantAgg | null {
  for (const d of declared) {
    const match = aggregates.find((a) => a.variantId === d.id);
    if (match) return match;
  }
  return aggregates[0] ?? null;
}

/**
 * SRM's expected counts come from the experiment's DECLARED weights when
 * they are usable, and fall back to an even split otherwise. Using an even
 * split for a deliberately uneven rollout (a 90/10 ramp, say) would fire
 * SRM on every read and permanently suppress the recommendation.
 */
function expectedObservedSplit(
  aggregates: VariantAgg[],
  declared: DeclaredVariant[],
): Array<{ expected: number; observed: number }> {
  const totalExposed = aggregates.reduce((s, a) => s + a.uniqueUsers, 0);
  const weightById = new Map(declared.map((d) => [d.id, d.weight]));
  const weights = aggregates.map((a) => weightById.get(a.variantId) ?? 0);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const usable = weightSum > 0 && weights.every((w) => w > 0);

  return aggregates.map((a, i) => ({
    expected: usable
      ? (totalExposed * weights[i]!) / weightSum
      : totalExposed / aggregates.length,
    observed: a.uniqueUsers,
  }));
}

function computeCrossoverRate(aggregates: VariantAgg[]): number | null {
  // Every exposed subscriber lands in exactly one of three buckets, so
  // their sum is the true exposed population (Task 3's integrity property).
  let exposed = 0;
  let crossover = 0;
  for (const a of aggregates) {
    exposed += a.matureUsers + a.excludedImmature + a.excludedCrossover;
    crossover += a.excludedCrossover;
  }
  return exposed > 0 ? crossover / exposed : null;
}

// =============================================================
// Bayesian input assembly
// =============================================================

interface ProceedsScaling {
  known: boolean;
  factorByVariant: Map<string, number>;
}

/**
 * Rescales the log-value sufficient statistics by a constant factor `f`.
 * Multiplying every converter's value by `f` shifts each log by `ln f`, so
 * the two sums transform in closed form — no per-subscriber array needed:
 *   Σ log(f·v)   = Σ log v + n·ln f
 *   Σ log(f·v)²  = Σ log v² + 2·ln f·Σ log v + n·(ln f)²
 */
function scaleLogAggregates(
  n: number,
  sumLog: number,
  sumLogSq: number,
  factor: number,
): { sumLogValue: number; sumLogValueSquared: number } {
  const lnF = Math.log(factor);
  return {
    sumLogValue: sumLog + n * lnF,
    sumLogValueSquared: sumLogSq + 2 * lnF * sumLog + n * lnF * lnF,
  };
}

function toBayesianInput(
  a: VariantAgg,
  row: ExperimentVariantRow,
  metric: ExperimentPrimaryMetric,
  proceeds: ProceedsScaling,
): BayesianVariantInput {
  const base: BayesianVariantInput = {
    key: a.variantId,
    users: a.matureUsers,
    converters: a.converters,
  };
  if (metric === "CONVERSION") return base;

  const sumLog = Number(row.sum_log_value);
  const sumLogSq = Number(row.sum_log_value_sq);

  if (metric === "ARPU") {
    return { ...base, sumLogValue: sumLog, sumLogValueSquared: sumLogSq };
  }

  // PROCEEDS_PER_USER. A missing factor (no configured rate anywhere, or a
  // variant with no net revenue to derive one from) is passed to the
  // posterior module as NaN, whose value fit returns `null` and whose
  // variant is reported `sufficientData: false` — the module's own
  // honesty path, rather than a fabricated point estimate here.
  const factor = proceeds.known
    ? proceeds.factorByVariant.get(a.variantId)
    : undefined;
  if (factor === undefined || !(factor > 0)) {
    return {
      ...base,
      sumLogValue: Number.NaN,
      sumLogValueSquared: Number.NaN,
    };
  }
  return { ...base, ...scaleLogAggregates(a.converters, sumLog, sumLogSq, factor) };
}

/**
 * Per-variant proceeds scale factor: proceeds ÷ net revenue, with the
 * commission rate resolved PER STORE and applied before combining. If any
 * store contributing revenue to this experiment has no configured rate,
 * `known` is false and PROCEEDS_PER_USER is unknown for the whole
 * experiment — never partially estimated, which would present a blend of
 * a real estimate and an undefined one as a single authoritative number.
 */
async function resolveProceedsFactors(
  experimentId: string,
  projectId: string,
): Promise<ProceedsScaling> {
  const storeRows = await runAnalyticsQuery({
    kind: "experiment_revenue_by_store",
    experimentId,
    projectId,
  });

  const stores = [...new Set(storeRows.map((r) => r.store))];
  const rateByStore = new Map<string, number | null>();
  for (const store of stores) {
    rateByStore.set(
      store,
      await resolveCommissionRate(drizzle.db, projectId, store as Store),
    );
  }
  if ([...rateByStore.values()].some((rate) => rate === null)) {
    return { known: false, factorByVariant: new Map() };
  }

  const netByVariant = new Map<string, number>();
  const proceedsByVariant = new Map<string, number>();
  for (const r of storeRows as ExperimentStoreRevenueRow[]) {
    const net = computeNetRevenue(Number(r.revenue_usd), Number(r.refunds_usd));
    const rate = rateByStore.get(r.store)!;
    netByVariant.set(r.variant_id, (netByVariant.get(r.variant_id) ?? 0) + net);
    proceedsByVariant.set(
      r.variant_id,
      (proceedsByVariant.get(r.variant_id) ?? 0) + computeProceeds(net, rate),
    );
  }

  const factorByVariant = new Map<string, number>();
  for (const [variantId, net] of netByVariant) {
    if (net > 0) {
      factorByVariant.set(variantId, proceedsByVariant.get(variantId)! / net);
    }
  }
  return { known: true, factorByVariant };
}

// =============================================================
// Frequentist cross-check + sample size
// =============================================================

function buildPairwiseConversion(
  aggregates: VariantAgg[],
  control: VariantAgg | null,
): ExperimentResultsResponse["conversion"] {
  if (aggregates.length !== 2 || control === null) return null;
  const treatment = aggregates.find((a) => a.variantId !== control.variantId);
  if (!treatment) return null;
  if (control.matureUsers <= 0 || treatment.matureUsers <= 0) return null;
  // Windowed figures on both sides — see the module header. The rate this
  // reports therefore differs from the pre-decision-engine endpoint, which
  // used the un-windowed exposure join; that is a deliberate correction.
  return analyzeConversion(
    { users: control.matureUsers, conversions: control.converters },
    { users: treatment.matureUsers, conversions: treatment.converters },
  );
}

/**
 * `minimumDetectableEffect` is `numeric(5,4)` and Drizzle's numeric mode
 * returns it as a STRING ("0.1000"). Converting it here — one `Number()`
 * at the service boundary plus a validity assertion — is the house
 * pattern (`resolveCommissionRate`, services/metrics/proceeds.ts). It
 * matters: inside `estimateSampleSize`, `1 + "0.1000"` would be string
 * concatenation, reading a 10% MDE as 1010% and collapsing the required
 * sample to nearly nothing. `estimateSampleSize` now throws on a
 * non-number, so this is belt and braces, not the only guard.
 */
function readMinimumDetectableEffect(experiment: ExperimentRecord): number {
  const mde = Number(experiment.minimumDetectableEffect);
  if (!Number.isFinite(mde) || mde <= 0) {
    throw new Error(
      `experiment ${experiment.id}: minimumDetectableEffect must be a positive number, got ${String(experiment.minimumDetectableEffect)}`,
    );
  }
  return mde;
}

function estimateRequiredSample(
  experiment: ExperimentRecord,
  control: VariantAgg | null,
  aggregates: VariantAgg[],
): ExperimentResultsResponse["sampleSize"] {
  const baselineRate = control?.conversionRate ?? null;
  // `estimateSampleSize` requires a baseline strictly inside (0, 1). A
  // control that has not converted anyone yet gives no baseline to power
  // against — reported as "no estimate", which fails the sample gate,
  // rather than back-filled with an invented default rate.
  if (baselineRate === null || baselineRate <= 0 || baselineRate >= 1) {
    return null;
  }
  const required = estimateSampleSize(
    baselineRate,
    readMinimumDetectableEffect(experiment),
  );
  return {
    required,
    reached: aggregates.every((a) => a.matureUsers >= required),
  };
}

// =============================================================
// The decision
// =============================================================

interface DecisionInput {
  variants: ExperimentResultsVariant[];
  control: VariantAgg | null;
  srmMismatch: boolean;
  crossoverRate: number | null;
  sampleReached: boolean;
  runtimeDays: number | null;
  proceedsKnown: boolean;
}

function decide(input: DecisionInput): ExperimentRecommendation {
  const blockedBy: ExperimentDecisionGate[] = [];

  // ---- Suppression: integrity and guardrails ----
  // These withhold the leader outright. A mis-split experiment's leader is
  // not a leader, and a recommendation shown beside a warning gets shipped.
  if (input.srmMismatch) blockedBy.push("SRM");
  if (
    input.crossoverRate !== null &&
    input.crossoverRate > CROSSOVER_SUPPRESSION_RATE
  ) {
    blockedBy.push("CROSSOVER");
  }

  const leader = pickLeader(input.variants);
  const controlVariant =
    input.control === null
      ? null
      : (input.variants.find((v) => v.variantId === input.control!.variantId) ??
        null);

  if (violatesRefundGuardrail(leader, controlVariant)) {
    blockedBy.push("REFUND_GUARDRAIL");
  }
  const suppressed = blockedBy.length > 0;

  // ---- Sample and runtime ----
  if (!input.sampleReached) blockedBy.push("SAMPLE_SIZE");
  if (input.runtimeDays === null || input.runtimeDays < MINIMUM_RUNTIME_DAYS) {
    blockedBy.push("RUNTIME");
  }

  // ---- The metric itself ----
  // At most one of these fires: they are successive reasons the metric
  // could not produce a shippable leader, most specific first.
  const controlMean = controlVariant?.posteriorMean ?? null;
  if (!input.proceedsKnown) {
    blockedBy.push("PROCEEDS_RATE_UNCONFIGURED");
  } else if (leader === null || controlMean === null || controlMean <= 0) {
    blockedBy.push("NO_LEADER");
  } else if (
    leader.expectedLoss === null ||
    leader.expectedLoss / controlMean >= EXPECTED_LOSS_THRESHOLD
  ) {
    blockedBy.push("EXPECTED_LOSS");
  }

  return {
    leadingVariantId: suppressed ? null : (leader?.variantId ?? null),
    shipRecommended: blockedBy.length === 0,
    blockedBy,
  };
}

/** The variant with the highest `probabilityBest`. `null` unless at least
 *  two variants have a fitted posterior — with one arm there is nothing to
 *  be better than. */
function pickLeader(
  variants: ExperimentResultsVariant[],
): ExperimentResultsVariant | null {
  const eligible = variants.filter(
    (v) => v.sufficientData && v.probabilityBest !== null,
  );
  if (eligible.length < 2) return null;
  return eligible.reduce((best, v) =>
    v.probabilityBest! > best.probabilityBest! ? v : best,
  );
}

/**
 * The one guardrail metric (spec §4.6): a leader whose refund rate is
 * worse than control's by more than REFUND_GUARDRAIL_MARGIN — a RELATIVE
 * degradation — is not a leader. A variant that wins on conversion by
 * driving purchases users immediately reverse is the exact failure an
 * automated shipper must not commit, and it is invisible to every other
 * number on the page.
 *
 * Not evaluable (either side has no revenue to take a refund ratio of, or
 * the leader IS control) means the guardrail does not fire — it never
 * invents a comparison it cannot make.
 */
function violatesRefundGuardrail(
  leader: ExperimentResultsVariant | null,
  control: ExperimentResultsVariant | null,
): boolean {
  if (leader === null || control === null) return false;
  if (leader.variantId === control.variantId) return false;
  if (leader.refundRate === null || control.refundRate === null) return false;
  return leader.refundRate > control.refundRate * (1 + REFUND_GUARDRAIL_MARGIN);
}
