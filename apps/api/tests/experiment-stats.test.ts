import { describe, expect, test } from "vitest";
import {
  analyzeConversion,
  analyzeRevenue,
  analyzeRevenueFromAggregates,
  checkSRM,
  estimateSampleSize,
  type ConfidenceLabel,
} from "../src/lib/experiment-stats";

// =============================================================
// analyzeConversion — Z-test for two proportions
// =============================================================

describe("analyzeConversion", () => {
  test("detects a significant lift (control 10%, variant 15%, n=1000)", () => {
    const result = analyzeConversion(
      { users: 1000, conversions: 100 },
      { users: 1000, conversions: 150 },
    );

    expect(result.controlRate).toBeCloseTo(0.1);
    expect(result.variantRate).toBeCloseTo(0.15);
    expect(result.absoluteLift).toBeCloseTo(0.05);
    expect(result.relativeLift).toBeCloseTo(0.5);
    expect(result.zScore).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.isSignificant).toBe(true);
    expect(result.confidenceLevel).toBeCloseTo(0.95);
    expect(result.confidenceLabel).toBe("99%");
  });

  test("returns pValue ~1 and not significant when rates are identical", () => {
    const result = analyzeConversion(
      { users: 1000, conversions: 100 },
      { users: 1000, conversions: 100 },
    );

    expect(result.zScore).toBe(0);
    expect(result.pValue).toBeCloseTo(1);
    expect(result.isSignificant).toBe(false);
    expect(result.confidenceLabel).toBe("not significant");
  });

  test("confidenceLabel returns 95% for p-value between 0.01 and 0.05", () => {
    const result = analyzeConversion(
      { users: 500, conversions: 50 },
      { users: 500, conversions: 75 },
    );

    expect(result.pValue).toBeLessThan(0.05);
    expect(result.pValue).toBeGreaterThan(0.01);
    expect(result.confidenceLabel).toBe("95%");
  });

  test("confidenceLabel returns 90% for p-value between 0.05 and 0.1", () => {
    const result = analyzeConversion(
      { users: 500, conversions: 50 },
      { users: 500, conversions: 67 },
    );

    expect(result.pValue).toBeLessThan(0.1);
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.confidenceLabel).toBe("90%");
  });

  test("tiny absolute lift under noise is not significant", () => {
    const result = analyzeConversion(
      { users: 200, conversions: 20 },
      { users: 200, conversions: 22 },
    );

    expect(result.isSignificant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  test("handles zero control rate without NaN", () => {
    const result = analyzeConversion(
      { users: 1000, conversions: 0 },
      { users: 1000, conversions: 50 },
    );

    expect(result.relativeLift).toBe(0);
    expect(result.absoluteLift).toBeCloseTo(0.05);
    expect(Number.isFinite(result.pValue)).toBe(true);
  });

  test("throws when either group has zero users", () => {
    expect(() =>
      analyzeConversion(
        { users: 0, conversions: 0 },
        { users: 100, conversions: 10 },
      ),
    ).toThrow();
  });
});

// =============================================================
// analyzeRevenue — Welch's t-test + normal-approx p-value
// =============================================================

describe("analyzeRevenue", () => {
  test("detects significant difference when variant mean is clearly higher", () => {
    const control = Array.from({ length: 100 }, () => 10 + Math.random());
    const variant = Array.from({ length: 100 }, () => 15 + Math.random());

    const result = analyzeRevenue(control, variant);

    expect(result.controlMean).toBeCloseTo(10.5, 0);
    expect(result.variantMean).toBeCloseTo(15.5, 0);
    expect(result.lift).toBeGreaterThan(0.4);
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.isSignificant).toBe(true);
  });

  test("identical samples are not significant", () => {
    const control = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const variant = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];

    const result = analyzeRevenue(control, variant);

    expect(result.lift).toBe(0);
    expect(result.isSignificant).toBe(false);
  });

  test("throws when either group has fewer than 2 samples", () => {
    expect(() => analyzeRevenue([10], [10, 20])).toThrow();
    expect(() => analyzeRevenue([10, 20], [])).toThrow();
  });
});

// =============================================================
// estimateSampleSize
// =============================================================

describe("estimateSampleSize", () => {
  test("returns a positive integer", () => {
    const n = estimateSampleSize(0.1, 0.2);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  test("smaller effect size → more samples needed", () => {
    const nLargeEffect = estimateSampleSize(0.1, 0.5);
    const nSmallEffect = estimateSampleSize(0.1, 0.1);
    expect(nSmallEffect).toBeGreaterThan(nLargeEffect);
  });

  test("higher power → more samples needed", () => {
    const nLow = estimateSampleSize(0.1, 0.2, 0.8);
    const nHigh = estimateSampleSize(0.1, 0.2, 0.95);
    expect(nHigh).toBeGreaterThan(nLow);
  });

  test("10% baseline + 20% MDE + 80% power ≈ 3,800 (±10%)", () => {
    // Industry ballpark — exact closed-form yields ~3,834.
    const n = estimateSampleSize(0.1, 0.2, 0.8, 0.05);
    expect(n).toBeGreaterThan(3_400);
    expect(n).toBeLessThan(4_200);
  });
});

// =============================================================
// checkSRM — chi-square goodness of fit
// =============================================================

describe("checkSRM", () => {
  test("perfect 50/50 split passes", () => {
    const result = checkSRM([
      { expected: 5000, observed: 5000 },
      { expected: 5000, observed: 5000 },
    ]);

    expect(result.chi2).toBeCloseTo(0);
    expect(result.pValue).toBeGreaterThan(0.01);
    expect(result.isMismatch).toBe(false);
  });

  test("moderate drift within noise is not flagged", () => {
    const result = checkSRM([
      { expected: 5000, observed: 5050 },
      { expected: 5000, observed: 4950 },
    ]);

    expect(result.isMismatch).toBe(false);
  });

  test("clear imbalance (6000/4000 vs 5000/5000) is flagged", () => {
    const result = checkSRM([
      { expected: 5000, observed: 6000 },
      { expected: 5000, observed: 4000 },
    ]);

    expect(result.chi2).toBeCloseTo(400);
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.isMismatch).toBe(true);
    expect(result.message).toMatch(/mismatch/i);
  });

  test("3-variant split handles df=2 correctly", () => {
    const result = checkSRM([
      { expected: 3400, observed: 3400 },
      { expected: 3300, observed: 3300 },
      { expected: 3300, observed: 3300 },
    ]);

    expect(result.isMismatch).toBe(false);
  });

  test("throws when fewer than 2 variants are provided", () => {
    expect(() => checkSRM([{ expected: 100, observed: 100 }])).toThrow();
  });
});

// =============================================================
// Edge cases
// =============================================================

describe("edge cases", () => {
  test("analyzeConversion: 0 conversions in both groups → pValue 1, not significant", () => {
    const result = analyzeConversion(
      { users: 500, conversions: 0 },
      { users: 500, conversions: 0 },
    );

    expect(result.controlRate).toBe(0);
    expect(result.variantRate).toBe(0);
    expect(result.pValue).toBeCloseTo(1);
    expect(result.isSignificant).toBe(false);
    expect(result.confidenceLabel).toBe("not significant");
  });

  test("analyzeConversion: 1 user per group → no NaN/Infinity", () => {
    const result = analyzeConversion(
      { users: 1, conversions: 0 },
      { users: 1, conversions: 1 },
    );

    expect(Number.isFinite(result.pValue)).toBe(true);
    expect(Number.isFinite(result.zScore)).toBe(true);
  });

  test("analyzeConversion: equal non-zero rates → zScore 0", () => {
    const result = analyzeConversion(
      { users: 1000, conversions: 50 },
      { users: 1000, conversions: 50 },
    );

    expect(result.zScore).toBe(0);
    expect(result.absoluteLift).toBe(0);
    expect(result.relativeLift).toBe(0);
  });

  test("checkSRM: 60/40 observed vs 50/50 expected → mismatch", () => {
    const result = checkSRM([
      { expected: 500, observed: 600 },
      { expected: 500, observed: 400 },
    ]);

    expect(result.chi2).toBeCloseTo(40);
    expect(result.isMismatch).toBe(true);
  });

  test("estimateSampleSize: throws for baselineRate 0 or 1", () => {
    expect(() => estimateSampleSize(0, 0.2)).toThrow();
    expect(() => estimateSampleSize(1, 0.2)).toThrow();
  });

  test("estimateSampleSize: throws for non-positive MDE", () => {
    expect(() => estimateSampleSize(0.1, 0)).toThrow();
    expect(() => estimateSampleSize(0.1, -0.1)).toThrow();
  });
});

// =============================================================
// analyzeRevenueFromAggregates — same test, sufficient statistics in
// =============================================================

describe("analyzeRevenueFromAggregates", () => {
  function stats(xs: number[]): { n: number; sum: number; sumSq: number } {
    return {
      n: xs.length,
      sum: xs.reduce((a, x) => a + x, 0),
      sumSq: xs.reduce((a, x) => a + x * x, 0),
    };
  }

  test("matches analyzeRevenue exactly on the same data", () => {
    // The point of the aggregate entry point is that it is the SAME test,
    // not a similar one — the ClickHouse reader just cannot ship a row per
    // subscriber. Asserting equality against the array-input function is
    // what makes drift between the two impossible to land silently.
    const control = [0, 0, 9.99, 0, 19.99, 0, 9.99, 49.99, 0, 0];
    const variant = [0, 14.99, 0, 0, 29.99, 9.99, 0, 0, 19.99, 4.99];

    const fromArrays = analyzeRevenue(control, variant);
    const fromAggregates = analyzeRevenueFromAggregates(
      stats(control),
      stats(variant),
    );

    expect(fromAggregates.controlMean).toBeCloseTo(fromArrays.controlMean, 12);
    expect(fromAggregates.variantMean).toBeCloseTo(fromArrays.variantMean, 12);
    expect(fromAggregates.lift).toBeCloseTo(fromArrays.lift, 12);
    expect(fromAggregates.tStatistic).toBeCloseTo(fromArrays.tStatistic, 10);
    expect(fromAggregates.pValue).toBeCloseTo(fromArrays.pValue, 10);
    expect(fromAggregates.isSignificant).toBe(fromArrays.isSignificant);
  });

  test("handles negative per-subscriber values (net refunds)", () => {
    // A subscriber refunded past their gross has NEGATIVE net revenue.
    // That is real and must not be clamped away — it is precisely what the
    // converter-only log aggregates cannot represent.
    const control = [0, 0, 19.99, -9.99, 0, 39.99];
    const variant = [0, 9.99, 9.99, 0, -19.99, 0];

    const fromArrays = analyzeRevenue(control, variant);
    const fromAggregates = analyzeRevenueFromAggregates(
      stats(control),
      stats(variant),
    );

    expect(fromAggregates.controlMean).toBeCloseTo(fromArrays.controlMean, 12);
    expect(fromAggregates.tStatistic).toBeCloseTo(fromArrays.tStatistic, 10);
  });

  test("reports a zero variance rather than a negative one when every value is equal", () => {
    // Sum(x^2) - Sum(x)^2/n cancels catastrophically here and can land a
    // hair below zero, which is not a variance. Both groups constant means
    // se = 0, which the shared core maps to t = 0 — never NaN.
    const n = 5000;
    const value = 19.99;
    const group = { n, sum: n * value, sumSq: n * value * value };

    const result = analyzeRevenueFromAggregates(group, group);
    expect(Number.isFinite(result.tStatistic)).toBe(true);
    expect(result.tStatistic).toBe(0);
    expect(result.controlMean).toBeCloseTo(value, 9);
    expect(result.lift).toBeCloseTo(0, 12);
  });

  test("throws below two observations per group", () => {
    expect(() =>
      analyzeRevenueFromAggregates(
        { n: 1, sum: 10, sumSq: 100 },
        { n: 30, sum: 300, sumSq: 3000 },
      ),
    ).toThrow(/at least 2/);
  });
});
