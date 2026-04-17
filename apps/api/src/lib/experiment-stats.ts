import {
  cumulativeStdNormalProbability,
  mean,
  sampleVariance,
} from "simple-statistics";

// =============================================================
// Experiment statistics
// =============================================================
//
// All tests assume large-N designs (the typical mobile A/B case,
// where cohorts sit in the thousands). For smaller N, p-values
// from the Welch's t-test and SRM helpers are approximations —
// see the notes on each function.

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

  const meanC = mean(controlRevenues);
  const meanV = mean(variantRevenues);
  const varC = sampleVariance(controlRevenues);
  const varV = sampleVariance(variantRevenues);
  const nC = controlRevenues.length;
  const nV = variantRevenues.length;

  const se = Math.sqrt(varC / nC + varV / nV);
  const tStatistic = se === 0 ? 0 : (meanV - meanC) / se;
  // Normal approximation to Student's t CDF — accurate for Welch's
  // with n ≥ 30 per group. For smaller cohorts treat the p-value as
  // a conservative lower bound.
  const pValue =
    2 * (1 - cumulativeStdNormalProbability(Math.abs(tStatistic)));

  return {
    controlMean: meanC,
    variantMean: meanV,
    lift: meanC === 0 ? 0 : (meanV - meanC) / meanC,
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
// Funnel drop-off
// =============================================================

export interface FunnelStepResult {
  step: string;
  count: number;
  /** Fraction retained from the previous step (step 0 is 1). */
  rate: number;
  /** Fraction lost from the previous step (step 0 is 0). */
  dropOff: number;
  /** Fraction retained from step 0. */
  overallRate: number;
}

export function analyzeFunnel(
  steps: Array<{ name: string; count: number }>,
): FunnelStepResult[] {
  if (steps.length === 0) return [];

  const start = steps[0]!.count;
  return steps.map((step, i) => {
    if (i === 0) {
      return {
        step: step.name,
        count: step.count,
        rate: 1,
        dropOff: 0,
        overallRate: 1,
      };
    }

    const prior = steps[i - 1]!.count;
    const rate = prior === 0 ? 0 : step.count / prior;
    const overallRate = start === 0 ? 0 : step.count / start;
    return {
      step: step.name,
      count: step.count,
      rate,
      dropOff: 1 - rate,
      overallRate,
    };
  });
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
