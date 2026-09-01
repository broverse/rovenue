import {
  cumulativeStdNormalProbability,
  mean,
  sampleVariance,
} from "simple-statistics";

// =============================================================
// Experiment statistics — fixed-horizon frequentist module
// =============================================================
//
// All tests assume large-N designs (the typical mobile A/B case,
// where cohorts sit in the thousands). For smaller N, p-values
// from the Welch's t-test and SRM helpers are approximations —
// see the notes on each function.
//
// FIXED-HORIZON, NOT A CONTINUOUS MONITOR: every p-value in this file is
// valid at the sample size the experiment was planned for
// (`estimateSampleSize`'s output) and only there. Calling
// `analyzeConversion` / `analyzeRevenue` repeatedly as data accrues and
// stopping the first time `isSignificant` flips true (peeking) inflates
// the false-positive rate well past `alpha` — these functions do not
// guard against that; the caller is responsible for waiting for the
// planned horizon (and `MINIMUM_WEEKLY_CYCLES`) before treating a result
// as final. `experiment-bayes.ts`'s posterior/expected-loss framing does
// not have this failure mode, which is why the decision engine prefers it.
//
// >2 VARIANTS: `analyzeConversion` / `analyzeRevenue` are two-sample
// tests. For an experiment with more than one non-control variant, the
// decision engine calls them pairwise against control only — never
// variant-vs-variant — and applies no multiplicity correction (no
// Bonferroni/Holm adjustment to `alpha` across the pairwise tests). More
// comparisons at the same nominal alpha raise the experiment-wise false-
// positive rate above the per-test one.

// =============================================================
// Conversion — Z-test for two proportions
// =============================================================

export type ConfidenceLabel = "99%" | "95%" | "90%" | "not significant";

export interface ConversionAnalysis {
  controlRate: number;
  variantRate: number;
  absoluteLift: number;
  relativeLift: number;
  zScore: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
  confidenceLabel: ConfidenceLabel;
}

function toConfidenceLabel(pValue: number): ConfidenceLabel {
  if (pValue < 0.01) return "99%";
  if (pValue < 0.05) return "95%";
  if (pValue < 0.1) return "90%";
  return "not significant";
}

export function analyzeConversion(
  control: { users: number; conversions: number },
  variant: { users: number; conversions: number },
  alpha = 0.05,
): ConversionAnalysis {
  if (control.users <= 0 || variant.users <= 0) {
    throw new Error("analyzeConversion: both groups must have users");
  }

  const p1 = control.conversions / control.users;
  const p2 = variant.conversions / variant.users;
  const pooled =
    (control.conversions + variant.conversions) /
    (control.users + variant.users);
  const se = Math.sqrt(
    pooled * (1 - pooled) * (1 / control.users + 1 / variant.users),
  );
  const zScore = se === 0 ? 0 : (p2 - p1) / se;
  const pValue = 2 * (1 - cumulativeStdNormalProbability(Math.abs(zScore)));

  return {
    controlRate: p1,
    variantRate: p2,
    absoluteLift: p2 - p1,
    relativeLift: p1 === 0 ? 0 : (p2 - p1) / p1,
    zScore,
    pValue,
    isSignificant: pValue < alpha,
    confidenceLevel: 1 - alpha,
    confidenceLabel: toConfidenceLabel(pValue),
  };
}

// =============================================================
// Revenue — Welch's t-test with normal-approx p-value
// =============================================================

export interface RevenueAnalysis {
  controlMean: number;
  variantMean: number;
  lift: number;
  tStatistic: number;
  pValue: number;
  isSignificant: boolean;
}

export function analyzeRevenue(
  controlRevenues: number[],
  variantRevenues: number[],
  alpha = 0.05,
): RevenueAnalysis {
  if (controlRevenues.length < 2 || variantRevenues.length < 2) {
    throw new Error("analyzeRevenue: need at least 2 samples per group");
  }

  return welch(
    {
      n: controlRevenues.length,
      mean: mean(controlRevenues),
      variance: sampleVariance(controlRevenues),
    },
    {
      n: variantRevenues.length,
      mean: mean(variantRevenues),
      variance: sampleVariance(variantRevenues),
    },
    alpha,
  );
}

/**
 * Welch's t-test from SUFFICIENT STATISTICS — `(n, Sum(x), Sum(x^2))` per
 * group — rather than from a per-observation array.
 *
 * Identical test, identical output, computed through the same `welch`
 * core as `analyzeRevenue`; the only difference is where the mean and
 * variance come from. It exists because the ClickHouse reader returns
 * aggregates, not per-subscriber rows, and Welch needs nothing more than
 * an n, a mean and a sample variance per group — so the spec's
 * assumption-free cross-check on raw per-subscriber revenue is computable
 * without shipping a row per subscriber over the wire.
 *
 * `analyzeRevenue`'s signature and behaviour are deliberately unchanged.
 */
export interface RevenueSufficientStats {
  /** Observations in the group — here, mature subscribers (not
   *  converters): the quantity is revenue per USER. */
  n: number;
  /** Sum of the per-subscriber values. May be negative if refunds
   *  dominate. */
  sum: number;
  /** Sum of the per-subscriber values squared. */
  sumSq: number;
}

export function analyzeRevenueFromAggregates(
  control: RevenueSufficientStats,
  variant: RevenueSufficientStats,
  alpha = 0.05,
): RevenueAnalysis {
  if (control.n < 2 || variant.n < 2) {
    throw new Error(
      "analyzeRevenueFromAggregates: need at least 2 observations per group",
    );
  }
  return welch(
    toMeanAndVariance(control),
    toMeanAndVariance(variant),
    alpha,
  );
}

interface GroupMoments {
  n: number;
  mean: number;
  variance: number;
}

/** Sample mean and variance from `(n, Sum(x), Sum(x^2))`. The variance is
 *  floored at 0: `Sum(x^2) - Sum(x)^2/n` cancels catastrophically when
 *  every observation is equal — a real case here, since a single-price
 *  paywall's mature subscribers take one of two values and can degenerate
 *  to one — and can land a hair below zero, which is not a variance. */
function toMeanAndVariance(stats: RevenueSufficientStats): GroupMoments {
  const { n, sum, sumSq } = stats;
  return {
    n,
    mean: sum / n,
    variance: Math.max(0, (sumSq - (sum * sum) / n) / (n - 1)),
  };
}

/** The shared Welch core. Both entry points above route through here, so
 *  the aggregate-input variant cannot drift from the array-input one. */
function welch(
  control: GroupMoments,
  variant: GroupMoments,
  alpha: number,
): RevenueAnalysis {
  const se = Math.sqrt(control.variance / control.n + variant.variance / variant.n);
  const tStatistic = se === 0 ? 0 : (variant.mean - control.mean) / se;
  // Normal approximation to Student's t CDF — accurate for Welch's
  // with n >= 30 per group. For smaller cohorts treat the p-value as
  // a conservative lower bound.
  const pValue =
    2 * (1 - cumulativeStdNormalProbability(Math.abs(tStatistic)));

  return {
    controlMean: control.mean,
    variantMean: variant.mean,
    lift: control.mean === 0 ? 0 : (variant.mean - control.mean) / control.mean,
    tStatistic,
    pValue,
    isSignificant: pValue < alpha,
  };
}

// =============================================================
// Sample size planner
// =============================================================
//
// Standard formula for comparing two proportions:
//   n = (Z_{α/2} + Z_{β})² · (p1(1-p1) + p2(1-p2)) / (p2 - p1)²
// where `mdE` is the relative lift over the baseline.

export function estimateSampleSize(
  baselineRate: number,
  minimumDetectableEffect: number,
  power = 0.8,
  alpha = 0.05,
): number {
  // Drizzle's numeric column mode returns `experiments.minimumDetectableEffect`
  // (numeric(5,4)) as a STRING (e.g. "0.1000"). `1 + "0.1000"` is string
  // concatenation ("10.1000"), not addition — an MDE of 10% would be
  // silently read as 1010%, collapsing the required sample size to near
  // nothing. The `<= 0` check below does not catch this: `"0.1000" <= 0`
  // coerces the string back to a number for the comparison, so it passes.
  // This is a guard, not a coercion — converting a numeric-mode string to
  // a number belongs at the service boundary (see `resolveCommissionRate`,
  // apps/api/src/services/metrics/proceeds.ts), not here.
  if (typeof baselineRate !== "number" || !Number.isFinite(baselineRate)) {
    throw new Error(
      `estimateSampleSize: baselineRate must be a finite number, got ${typeof baselineRate}`,
    );
  }
  if (
    typeof minimumDetectableEffect !== "number" ||
    !Number.isFinite(minimumDetectableEffect)
  ) {
    throw new Error(
      `estimateSampleSize: minimumDetectableEffect must be a finite number, got ${typeof minimumDetectableEffect}`,
    );
  }
  if (baselineRate <= 0 || baselineRate >= 1) {
    throw new Error("estimateSampleSize: baselineRate must be in (0, 1)");
  }
  if (minimumDetectableEffect <= 0) {
    throw new Error("estimateSampleSize: minimumDetectableEffect must be > 0");
  }

  const p1 = baselineRate;
  const p2 = Math.min(0.9999, baselineRate * (1 + minimumDetectableEffect));
  const zAlpha = inverseStdNormal(1 - alpha / 2);
  const zBeta = inverseStdNormal(power);

  const numerator =
    (zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2));
  const denominator = (p2 - p1) ** 2;
  return Math.ceil(numerator / denominator);
}

// =============================================================
// SRM — chi-square goodness of fit with Wilson-Hilferty p-value
// =============================================================

export interface SRMResult {
  chi2: number;
  df: number;
  pValue: number;
  isMismatch: boolean;
  message: string;
}

export function checkSRM(
  variants: Array<{ expected: number; observed: number }>,
  alpha = 0.01,
): SRMResult {
  if (variants.length < 2) {
    throw new Error("checkSRM: need at least 2 variants");
  }

  let chi2 = 0;
  for (const v of variants) {
    if (v.expected <= 0) continue;
    chi2 += ((v.observed - v.expected) ** 2) / v.expected;
  }

  const df = variants.length - 1;
  // Wilson-Hilferty approximation to χ² → standard normal. Accurate
  // enough for SRM detection, which is a sanity check not a formal
  // paper result.
  const z =
    (Math.cbrt(chi2 / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  const pValue = Math.max(0, 1 - cumulativeStdNormalProbability(z));
  const isMismatch = pValue < alpha;

  return {
    chi2,
    df,
    pValue,
    isMismatch,
    message: isMismatch
      ? `Sample Ratio Mismatch detected (p=${pValue.toExponential(2)})`
      : `No SRM detected (p=${pValue.toFixed(4)})`,
  };
}

// =============================================================
// Inverse standard normal CDF via binary search
// =============================================================
//
// Used by estimateSampleSize — simple-statistics exports the
// forward CDF (`cumulativeStdNormalProbability`) but not the
// inverse. Binary search is fine: 50 iterations across [-10, 10]
// converge to ~16-digit precision, and this runs only during
// sample size planning (never on the request hot path).

function inverseStdNormal(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    if (cumulativeStdNormalProbability(mid) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}
