import { describe, expect, it } from "vitest";

import { analyzeBayesian, type AnalyzeBayesianInput } from "./experiment-bayes";
import {
  CREDIBLE_LEVEL,
  DEGENERATE_VARIANCE_RELATIVE_TOLERANCE,
  MINIMUM_CONVERTERS_FOR_VALUE_MODEL,
  MINIMUM_USERS_FOR_POSTERIOR,
} from "./experiment-constants";

// =============================================================
// Closed-form oracle — Evan Miller's exact Beta(a,b) comparison
// =============================================================
//
// Test-only. Independent of `experiment-bayes.ts`'s Monte Carlo sampler,
// so a match between the two is real evidence the sampler is correct
// rather than the test re-deriving the module's own arithmetic.

function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

// Lanczos approximation — good to ~15 significant digits, independent of
// any gamma/beta implementation inside the shipped module.
function lnGamma(x: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const xx = x - 1;
  let a = coefficients[0]!;
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) {
    a += coefficients[i]! / (xx + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

// P(B > A) for Beta(aA,bA), Beta(aB,bB) with integer parameters.
// Evan Miller's closed form; test-only oracle, never shipped code.
function exactProbBBeatsA(aA: number, bA: number, aB: number, bB: number): number {
  let total = 0;
  for (let i = 0; i < aB; i += 1) {
    total += Math.exp(
      lnBeta(aA + i, bA + bB) - Math.log(bB + i) - lnBeta(1 + i, bB) - lnBeta(aA, bA),
    );
  }
  return total;
}

const ORACLE_TOLERANCE = 0.01;

function conversionInput(
  overrides: Partial<AnalyzeBayesianInput> = {},
): AnalyzeBayesianInput {
  return {
    experimentId: "exp_test_oracle",
    metricType: "CONVERSION",
    variants: [
      { key: "control", users: 1000, converters: 50 },
      { key: "treatment", users: 1000, converters: 65 },
    ],
    ...overrides,
  };
}

describe("analyzeBayesian — determinism", () => {
  it("returns deep-equal output for the same input computed twice", () => {
    const input = conversionInput();
    const first = analyzeBayesian(input);
    const second = analyzeBayesian(structuredClone(input));
    expect(second).toEqual(first);
  });
});

describe("analyzeBayesian — closed-form oracle", () => {
  it("matches the exact two-variant Beta probability within tolerance", () => {
    // Prior is Beta(1,1); posterior params are prior + (converters, non-converters).
    const control = { users: 2000, converters: 100 }; // 5%
    const treatment = { users: 2000, converters: 130 }; // 6.5%

    const aA = 1 + control.converters;
    const bA = 1 + (control.users - control.converters);
    const aB = 1 + treatment.converters;
    const bB = 1 + (treatment.users - treatment.converters);

    const expected = exactProbBBeatsA(aA, bA, aB, bB);

    const result = analyzeBayesian({
      experimentId: "exp_oracle_match",
      metricType: "CONVERSION",
      variants: [
        { key: "control", ...control },
        { key: "treatment", ...treatment },
      ],
    });

    const treatmentPosterior = result.variants.find((v) => v.key === "treatment")!;
    expect(treatmentPosterior.probabilityBest).not.toBeNull();
    expect(
      Math.abs(treatmentPosterior.probabilityBest! - expected),
    ).toBeLessThan(ORACLE_TOLERANCE);
  });
});

describe("analyzeBayesian — zero-user variant", () => {
  it("gives a variant with no observed users NO posterior at all", () => {
    // Beta(1,1) with no data is a perfectly valid UNIFORM posterior: mean
    // ≈ 0.5, and against a control converting at 5% it wins
    // `probabilityBest` outright. Reported as a number it becomes
    // "Confidence 99%" in the hero and enables the manual Ship-winner
    // button for an arm with zero observations. `null` is the honest
    // answer.
    expect(MINIMUM_USERS_FOR_POSTERIOR).toBeGreaterThan(0);

    const result = analyzeBayesian({
      experimentId: "exp_zero_users",
      metricType: "CONVERSION",
      variants: [
        { key: "control", users: 1000, converters: 50 },
        { key: "empty", users: 0, converters: 0 },
      ],
    });

    const empty = result.variants.find((v) => v.key === "empty")!;
    expect(empty.sufficientData).toBe(false);
    expect(empty.mean).toBeNull();
    expect(empty.credibleInterval).toBeNull();
    expect(empty.probabilityBest).toBeNull();
    expect(empty.expectedLoss).toBeNull();

    // The arm that DOES have data is still fitted, and never NaN.
    const control = result.variants.find((v) => v.key === "control")!;
    expect(control.sufficientData).toBe(true);
    expect(Number.isNaN(control.mean!)).toBe(false);
    expect(Number.isNaN(control.credibleInterval![0])).toBe(false);
    expect(Number.isNaN(control.credibleInterval![1])).toBe(false);
    expect(Number.isNaN(control.probabilityBest!)).toBe(false);
    expect(Number.isNaN(control.expectedLoss!)).toBe(false);
  });
});

describe("analyzeBayesian — insufficient converters for the value model", () => {
  it("yields a null value factor rather than a fabricated one", () => {
    expect(MINIMUM_CONVERTERS_FOR_VALUE_MODEL).toBe(2);

    const result = analyzeBayesian({
      experimentId: "exp_sparse_value",
      metricType: "ARPU",
      variants: [
        {
          key: "control",
          users: 500,
          converters: 1, // below MINIMUM_CONVERTERS_FOR_VALUE_MODEL
          sumLogValue: Math.log(9.99),
          sumLogValueSquared: Math.log(9.99) ** 2,
        },
        {
          key: "treatment",
          users: 500,
          converters: 40,
          // Mean log-value log(9.99) with a sample variance of 0.2 — a real
          // spread of price points. NOT 40 converters all at exactly 9.99:
          // that is a zero-variance cohort, which is a separate case with
          // its own test below, not "enough data to fit".
          sumLogValue: 40 * Math.log(9.99),
          sumLogValueSquared: 40 * Math.log(9.99) ** 2 + 39 * 0.2,
        },
      ],
    });

    const sparse = result.variants.find((v) => v.key === "control")!;
    expect(sparse.sufficientData).toBe(false);
    expect(sparse.mean).toBeNull();
    expect(sparse.credibleInterval).toBeNull();
    expect(sparse.probabilityBest).toBeNull();
    expect(sparse.expectedLoss).toBeNull();

    const rich = result.variants.find((v) => v.key === "treatment")!;
    expect(rich.sufficientData).toBe(true);
    expect(rich.mean).not.toBeNull();
    expect(Number.isNaN(rich.mean!)).toBe(false);
  });

  it("fits a DEGENERATE but valid point mass when every converter paid the SAME price", () => {
    // One product at one price, inside a 7-day maturation window in which
    // essentially every converter has exactly one purchase, is the MODAL
    // configuration for this product — not an edge case. Every mature
    // converter then nets an identical amount, so the true log-value
    // variance is exactly zero.
    //
    // Zero variance is INFORMATION, not missing data: the per-converter
    // value is known exactly. With all n observations equal to mu0 the
    // scaled-inverse-chi-square posterior on sigma^2 collapses to a point
    // mass at 0, so E[value | convert] = exp(mu0) and all the remaining
    // uncertainty sits in the conversion factor. Reporting
    // `sufficientData: false` here would make Task 5 render "not enough
    // data" for a paywall with 2 000 converters.
    const n = 2000;
    const users = 20_000;
    const price = 19.99;
    const logPrice = Math.log(price);
    const result = analyzeBayesian({
      experimentId: "exp_single_price",
      metricType: "ARPU",
      variants: [
        {
          key: "control",
          users,
          converters: n,
          sumLogValue: n * logPrice,
          sumLogValueSquared: n * logPrice ** 2,
        },
        {
          key: "treatment",
          users,
          converters: n,
          sumLogValue: n * logPrice,
          sumLogValueSquared: n * logPrice ** 2,
        },
      ],
    });

    // Beta(1 + converters, 1 + non-converters) posterior mean, times the
    // exactly-known price. Derived here from the conjugate update, not read
    // back off the module.
    const expectedMean = ((1 + n) / (2 + users)) * price;

    for (const v of result.variants) {
      expect(v.sufficientData).toBe(true);
      expect(v.mean).not.toBeNull();
      expect(Number.isFinite(v.mean!)).toBe(true);
      expect(v.mean!).toBeCloseTo(expectedMean, 2);

      // Still a real posterior: the interval brackets the mean and the
      // expected loss is usable, because the conversion factor is where
      // the uncertainty legitimately lives.
      expect(v.credibleInterval).not.toBeNull();
      expect(v.credibleInterval![0]).toBeLessThan(v.mean!);
      expect(v.credibleInterval![1]).toBeGreaterThan(v.mean!);
      expect(v.expectedLoss).not.toBeNull();
      expect(Number.isFinite(v.expectedLoss!)).toBe(true);
      expect(v.expectedLoss!).toBeGreaterThan(0);
      expect(Number.isFinite(v.probabilityBest!)).toBe(true);
    }
  });

  it("treats a variance negative only by rounding noise as degenerate, not impossible", () => {
    // Sits just INSIDE the tolerance band: this is what floating-point
    // cancellation actually produces for an equal-valued cohort.
    const n = 10;
    const meanLog = 3;
    const sumLogValue = n * meanLog;
    const tolerance =
      DEGENERATE_VARIANCE_RELATIVE_TOLERANCE * meanLog * meanLog;
    const targetVar = -tolerance / 2;
    const sumLogValueSquared =
      (sumLogValue * sumLogValue) / n + targetVar * (n - 1);

    const result = analyzeBayesian({
      experimentId: "exp_rounding_noise_variance",
      metricType: "ARPU",
      variants: [
        { key: "control", users: 500, converters: n, sumLogValue, sumLogValueSquared },
        { key: "treatment", users: 500, converters: n, sumLogValue, sumLogValueSquared },
      ],
    });

    for (const v of result.variants) {
      expect(v.sufficientData).toBe(true);
      expect(Number.isFinite(v.mean!)).toBe(true);
    }
  });

  it("yields a null value factor when the variance is negative BEYOND tolerance", () => {
    // A variance cannot be negative. Beyond rounding noise it means the
    // sufficient statistics are inconsistent, and nothing can honestly be
    // fitted from them — distinct from the degenerate case above, which is
    // a real answer.
    const n = 10;
    const sumLogValue = n * 3;
    // Sum(x)^2/n is 90; 85 puts the sample variance at -0.5555.
    const sumLogValueSquared = 85;
    const result = analyzeBayesian({
      experimentId: "exp_impossible_variance",
      metricType: "ARPU",
      variants: [
        { key: "control", users: 500, converters: n, sumLogValue, sumLogValueSquared },
        {
          key: "treatment",
          users: 500,
          converters: 40,
          sumLogValue: 40 * Math.log(9.99),
          sumLogValueSquared: 40 * Math.log(9.99) ** 2 + 39 * 0.2,
        },
      ],
    });

    const impossible = result.variants.find((v) => v.key === "control")!;
    expect(impossible.sufficientData).toBe(false);
    expect(impossible.mean).toBeNull();
    expect(impossible.credibleInterval).toBeNull();
    expect(impossible.probabilityBest).toBeNull();
    expect(impossible.expectedLoss).toBeNull();
  });

  it("yields a null value factor when the log-value variance is not finite", () => {
    const result = analyzeBayesian({
      experimentId: "exp_nonfinite_variance",
      metricType: "ARPU",
      variants: [
        {
          key: "control",
          users: 500,
          converters: 5,
          sumLogValue: Number.NaN,
          sumLogValueSquared: Number.NaN,
        },
        {
          key: "treatment",
          users: 500,
          converters: 40,
          sumLogValue: 40 * Math.log(9.99),
          sumLogValueSquared: 40 * Math.log(9.99) ** 2,
        },
      ],
    });

    const broken = result.variants.find((v) => v.key === "control")!;
    expect(broken.sufficientData).toBe(false);
    expect(broken.mean).toBeNull();
  });
});

describe("analyzeBayesian — expected loss ordering", () => {
  it("gives the dominant variant near-zero expected loss and the dominated one a real loss", () => {
    const result = analyzeBayesian({
      experimentId: "exp_dominance",
      metricType: "CONVERSION",
      variants: [
        { key: "control", users: 5000, converters: 100 }, // 2%
        { key: "treatment", users: 5000, converters: 750 }, // 15%, clearly dominant
      ],
    });

    const control = result.variants.find((v) => v.key === "control")!;
    const treatment = result.variants.find((v) => v.key === "treatment")!;

    expect(treatment.expectedLoss).not.toBeNull();
    expect(control.expectedLoss).not.toBeNull();
    expect(treatment.expectedLoss!).toBeLessThan(0.001);
    expect(control.expectedLoss!).toBeGreaterThan(0.01);
    expect(treatment.probabilityBest!).toBeGreaterThan(0.99);
  });
});

describe("analyzeBayesian — credible interval", () => {
  it("reports an equal-tailed interval at CREDIBLE_LEVEL that brackets the mean", () => {
    const result = analyzeBayesian(conversionInput());
    for (const variant of result.variants) {
      expect(variant.credibleInterval).not.toBeNull();
      const [low, high] = variant.credibleInterval!;
      expect(low).toBeLessThanOrEqual(variant.mean!);
      expect(high).toBeGreaterThanOrEqual(variant.mean!);
      expect(CREDIBLE_LEVEL).toBe(0.95);
    }
  });
});
