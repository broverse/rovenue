import { createHash } from "node:crypto";

import {
  CONVERSION_PRIOR_ALPHA,
  CONVERSION_PRIOR_BETA,
  CREDIBLE_LEVEL,
  MINIMUM_CONVERTERS_FOR_VALUE_MODEL,
  POSTERIOR_DRAWS,
} from "./experiment-constants";

// =============================================================
// Bayesian posterior module — pure functions, deterministic sampler
// =============================================================
//
// No wiring lives here (Task 4 wires `analyzeBayesian` into the decision
// engine). Everything below is a pure function of its arguments.
//
// RANDOMNESS: the module has NO reachable path to global randomness — none
// of the JS/Node ambient entropy or wall-clock sources (the global Math
// object's random method, WebCrypto's random-values getter, either Date
// accessor for the current instant, or constructing `Date` with no
// argument) appear anywhere below. The Monte Carlo sampler is
// seeded deterministically from the caller-supplied `experimentId` (via a
// SHA-256 digest, the same deterministic-hash primitive
// `@rovenue/shared/experiments/bucketing.ts` uses for bucket assignment —
// `createHash` is a pure function of its input, not a randomness source)
// feeding a mulberry32 PRNG. The same input to `analyzeBayesian` always
// produces the same output, forever, on any machine — that determinism is
// covered by a dedicated test and is load-bearing: a decision engine that
// re-ships a different verdict on every rerun of the same experiment is
// worse than no decision engine.
//
// SAMPLER STACK
//   - PRNG:        mulberry32 (32-bit state, one multiply-heavy mix per
//                  call). Chosen over xorshift128 for the smaller state
//                  (a single uint32 seed derived straight from the
//                  digest) and because its statistical quality is more
//                  than sufficient for Monte Carlo integration at
//                  POSTERIOR_DRAWS scale — this is not a cryptographic or
//                  simulation-grade RNG, and doesn't need to be.
//   - Normal:      Box-Muller transform (two uniforms in, one normal
//                  out; the paired cosine/sine partner is discarded for
//                  simplicity, which costs nothing at this draw count).
//   - Gamma:       Marsaglia-Tsang for shape >= 1, with the standard
//                  boost transform (Gamma(a) = Gamma(a+1) * U^(1/a)) for
//                  shape < 1.
//   - Beta:        X / (X + Y) for independent Gamma(alpha), Gamma(beta).
//   - Chi-square:  chi2(df) = Gamma(df/2, scale=2).
//
// MODELING CHOICES
//   - CONVERSION posteriors are Beta(prior + converters, prior + non-
//     converters) — the standard conjugate update.
//   - ARPU / PROCEEDS_PER_USER decompose per draw as
//     (conversion-rate draw) * (per-converter value draw), fit
//     independently and multiplied per draw — never by multiplying their
//     posterior means, which does not equal the mean of the product for
//     correlated quantities drawn from the same experiment.
//   - The per-converter value model is a Normal-Inverse-Gamma / Jeffreys
//     posterior fit to log(value) among converters only. A variant whose
//     converter count is below MINIMUM_CONVERTERS_FOR_VALUE_MODEL, or
//     whose log-value sample variance is not finite, gets `sufficientData:
//     false` and every derived field `null` for that metric — never a
//     fabricated point estimate standing in for a posterior that could
//     not be fit.
//   - `probabilityBest` / `expectedLoss` compare a variant only against
//     the OTHER variants that also have sufficient data for the metric
//     being analyzed; a variant lacking data is excluded from the
//     comparison entirely rather than silently coercing its missing
//     value to a default.

// =============================================================
// Deterministic PRNG
// =============================================================

type Rng = () => number;

/** Derives a 32-bit seed from an experiment id. `createHash` is a pure,
 *  deterministic function of its input — not a source of entropy — so
 *  this does not count as "global randomness". */
function seedFromExperimentId(experimentId: string): number {
  const digest = createHash("sha256").update(experimentId).digest();
  return digest.readUInt32BE(0);
}

/** mulberry32 — see module comment for why this PRNG was chosen. Returns
 *  a function producing floats uniformly distributed in [0, 1). */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================
// Distribution sampling primitives
// =============================================================

/** Standard normal draw via the Box-Muller transform. `Number.EPSILON`
 *  floors the first uniform so `Math.log` never sees exactly 0. */
function drawStandardNormal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape, scale) via Marsaglia-Tsang (shape >= 1), with the
 *  standard boost transform for shape < 1. */
function drawGamma(rng: Rng, shape: number, scale: number): number {
  if (!(shape > 0)) {
    throw new Error(`drawGamma: shape must be > 0, got ${shape}`);
  }
  if (shape < 1) {
    const u = Math.max(rng(), Number.EPSILON);
    return drawGamma(rng, shape + 1, scale) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = drawStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) {
      return d * v * scale;
    }
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

/** Beta(alpha, beta) via two independent Gamma(., 1) draws. */
function drawBeta(rng: Rng, alpha: number, beta: number): number {
  const x = drawGamma(rng, alpha, 1);
  const y = drawGamma(rng, beta, 1);
  return x / (x + y);
}

/** Chi-square(df) = Gamma(df / 2, scale = 2). */
function drawChiSquare(rng: Rng, degreesOfFreedom: number): number {
  return drawGamma(rng, degreesOfFreedom / 2, 2);
}

// =============================================================
// Value factor — Normal-Inverse-Gamma / Jeffreys posterior on log(value)
// =============================================================

interface ValueFactorFit {
  n: number;
  meanLog: number;
  varLog: number;
}

/** Fits the log-value posterior from converter-only sufficient statistics.
 *  Returns `null` — never a fabricated point estimate — when there are
 *  too few converters to fit a variance, or the fitted variance is not
 *  finite. */
function fitValueFactor(
  converters: number,
  sumLogValue: number,
  sumLogValueSquared: number,
): ValueFactorFit | null {
  if (converters < MINIMUM_CONVERTERS_FOR_VALUE_MODEL) {
    return null;
  }
  const n = converters;
  const meanLog = sumLogValue / n;
  const varLog = (sumLogValueSquared - (sumLogValue * sumLogValue) / n) / (n - 1);
  // A variance must be >= 0, and `Number.isFinite` alone does not enforce
  // that here: the textbook Σx² − (Σx)²/n form catastrophically cancels
  // when every converter has the SAME value, and returns a tiny NEGATIVE
  // number instead of exactly 0. That case is not exotic in this product —
  // it is a paywall selling one product at one price, i.e. the common
  // case. Letting it through produced `sqrt` of a negative sigma², so
  // every posterior field for that variant came back NaN while
  // `sufficientData` still said `true`; downstream, `expectedLoss >=
  // threshold` is `false` for NaN, so the stopping rule would have
  // recommended shipping on a posterior that was never fitted. Rejecting a
  // non-positive variance routes it to the same honest `null` path as too
  // few converters.
  if (!Number.isFinite(varLog) || varLog <= 0) {
    return null;
  }
  return { n, meanLog, varLog };
}

/** One posterior draw of E[value] under the fitted log-normal model —
 *  see the formulas in the task brief's Step 6. */
function drawValueFactor(rng: Rng, fit: ValueFactorFit): number {
  const degreesOfFreedom = fit.n - 1;
  const chi2 = drawChiSquare(rng, degreesOfFreedom);
  const sigma2 = (degreesOfFreedom * fit.varLog) / chi2;
  const z = drawStandardNormal(rng);
  const mu = fit.meanLog + Math.sqrt(sigma2 / fit.n) * z;
  return Math.exp(mu + sigma2 / 2);
}

// =============================================================
// Public interface
// =============================================================

export type BayesianMetricType = "CONVERSION" | "ARPU" | "PROCEEDS_PER_USER";

export interface BayesianVariantInput {
  key: string;
  users: number;
  converters: number;
  /** Sum of log(value) over converters only. Required for ARPU /
   *  PROCEEDS_PER_USER; ignored for CONVERSION. */
  sumLogValue?: number;
  /** Sum of log(value)^2 over converters only. Required for ARPU /
   *  PROCEEDS_PER_USER; ignored for CONVERSION. */
  sumLogValueSquared?: number;
}

export interface AnalyzeBayesianInput {
  experimentId: string;
  metricType: BayesianMetricType;
  variants: BayesianVariantInput[];
}

export interface VariantPosterior {
  key: string;
  /** Posterior mean, or `null` when `sufficientData` is `false`. */
  mean: number | null;
  /** Equal-tailed interval at CREDIBLE_LEVEL, or `null`. */
  credibleInterval: [number, number] | null;
  /** Fraction of posterior draws in which this variant is the best among
   *  variants with sufficient data, or `null`. */
  probabilityBest: number | null;
  /** Mean, over posterior draws, of max(0, best-other-variant - this
   *  variant) in the metric's own units, or `null`. */
  expectedLoss: number | null;
  /** `false` for ARPU / PROCEEDS_PER_USER when this variant's converter
   *  count is below MINIMUM_CONVERTERS_FOR_VALUE_MODEL, or its log-value
   *  variance is not finite — see the module comment. Always `true` for
   *  CONVERSION. */
  sufficientData: boolean;
}

export interface BayesianAnalysis {
  metricType: BayesianMetricType;
  variants: VariantPosterior[];
}

/**
 * Bayesian posterior analysis for one experiment metric across variants.
 * Pure and deterministic: the same input always produces deep-equal
 * output (the sampler is seeded from `experimentId`, never from wall
 * clock time or a global RNG — see the module comment).
 */
export function analyzeBayesian(input: AnalyzeBayesianInput): BayesianAnalysis {
  const { experimentId, metricType, variants } = input;
  if (variants.length === 0) {
    throw new Error("analyzeBayesian: at least one variant is required");
  }
  for (const v of variants) {
    if (v.users < 0 || v.converters < 0 || v.converters > v.users) {
      throw new Error(
        `analyzeBayesian: invalid users/converters for variant "${v.key}" (users=${v.users}, converters=${v.converters})`,
      );
    }
  }

  const rng = mulberry32(seedFromExperimentId(experimentId));

  const valueFits: Array<ValueFactorFit | null> =
    metricType === "CONVERSION"
      ? variants.map(() => null)
      : variants.map((v) =>
          fitValueFactor(v.converters, v.sumLogValue ?? Number.NaN, v.sumLogValueSquared ?? Number.NaN),
        );

  const included: boolean[] = variants.map((_v, idx) =>
    metricType === "CONVERSION" ? true : valueFits[idx] !== null,
  );
  const includedIndices = included.reduce<number[]>((acc, isIncluded, idx) => {
    if (isIncluded) acc.push(idx);
    return acc;
  }, []);

  // draws[variantIdx][drawIdx] — only populated for included variants.
  const draws: Array<Float64Array | null> = variants.map((_v, idx) =>
    included[idx] ? new Float64Array(POSTERIOR_DRAWS) : null,
  );

  for (let drawIdx = 0; drawIdx < POSTERIOR_DRAWS; drawIdx += 1) {
    for (const idx of includedIndices) {
      const v = variants[idx]!;
      const alpha = CONVERSION_PRIOR_ALPHA + v.converters;
      const beta = CONVERSION_PRIOR_BETA + (v.users - v.converters);
      const conversionDraw = drawBeta(rng, alpha, beta);

      if (metricType === "CONVERSION") {
        draws[idx]![drawIdx] = conversionDraw;
      } else {
        const fit = valueFits[idx]!;
        const valueDraw = drawValueFactor(rng, fit);
        draws[idx]![drawIdx] = conversionDraw * valueDraw;
      }
    }
  }

  const bestCounts = new Array<number>(variants.length).fill(0);
  const lossSums = new Array<number>(variants.length).fill(0);

  for (let drawIdx = 0; drawIdx < POSTERIOR_DRAWS; drawIdx += 1) {
    let max1 = -Infinity;
    let idx1 = -1;
    let max2 = -Infinity;
    for (const idx of includedIndices) {
      const value = draws[idx]![drawIdx]!;
      if (value > max1) {
        max2 = max1;
        max1 = value;
        idx1 = idx;
      } else if (value > max2) {
        max2 = value;
      }
    }
    for (const idx of includedIndices) {
      if (idx === idx1) {
        bestCounts[idx] += 1;
      }
      if (includedIndices.length > 1) {
        const own = draws[idx]![drawIdx]!;
        const maxOther = idx === idx1 ? max2 : max1;
        lossSums[idx] += Math.max(0, maxOther - own);
      }
    }
  }

  const lowerTail = (1 - CREDIBLE_LEVEL) / 2;
  const upperTail = 1 - lowerTail;

  const results: VariantPosterior[] = variants.map((v, idx) => {
    if (!included[idx]) {
      return {
        key: v.key,
        mean: null,
        credibleInterval: null,
        probabilityBest: null,
        expectedLoss: null,
        sufficientData: false,
      };
    }

    const own = draws[idx]!;
    let sum = 0;
    for (let i = 0; i < own.length; i += 1) sum += own[i]!;
    const mean = sum / own.length;

    const sorted = Float64Array.from(own).sort();
    const lowerIdx = Math.min(sorted.length - 1, Math.floor(lowerTail * sorted.length));
    const upperIdx = Math.min(sorted.length - 1, Math.floor(upperTail * sorted.length));
    const credibleInterval: [number, number] = [sorted[lowerIdx]!, sorted[upperIdx]!];

    return {
      key: v.key,
      mean,
      credibleInterval,
      probabilityBest: bestCounts[idx]! / POSTERIOR_DRAWS,
      expectedLoss: includedIndices.length > 1 ? lossSums[idx]! / POSTERIOR_DRAWS : 0,
      sufficientData: true,
    };
  });

  return { metricType, variants: results };
}
