import { describe, expect, it } from "vitest";

import { estimateSampleSize } from "./experiment-stats";

// =============================================================
// estimateSampleSize — string-input guard
// =============================================================
//
// Drizzle's numeric column mode returns `experiments.minimumDetectableEffect`
// as a string ("0.1000"), not a number. Without a type guard, `1 + "0.1000"`
// is string concatenation ("10.1000"), silently treating a 10% MDE as
// 1010% and collapsing the required sample size — see the comment on
// `estimateSampleSize` in experiment-stats.ts.

describe("estimateSampleSize — input guards", () => {
  it("computes a sane sample size for valid numeric input", () => {
    const n = estimateSampleSize(0.05, 0.1);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it("throws when minimumDetectableEffect arrives as a string", () => {
    expect(() =>
      estimateSampleSize(0.05, "0.1000" as unknown as number),
    ).toThrow(/minimumDetectableEffect must be a finite number/);
  });

  it("throws when baselineRate arrives as a string", () => {
    expect(() =>
      estimateSampleSize("0.0500" as unknown as number, 0.1),
    ).toThrow(/baselineRate must be a finite number/);
  });

  it("throws when minimumDetectableEffect is NaN", () => {
    expect(() => estimateSampleSize(0.05, Number.NaN)).toThrow(
      /minimumDetectableEffect must be a finite number/,
    );
  });

  it("throws when baselineRate is Infinity", () => {
    expect(() => estimateSampleSize(Number.POSITIVE_INFINITY, 0.1)).toThrow(
      /baselineRate must be a finite number/,
    );
  });

  it("still rejects a non-positive minimumDetectableEffect after the type guard passes", () => {
    expect(() => estimateSampleSize(0.05, 0)).toThrow(
      /minimumDetectableEffect must be > 0/,
    );
  });
});
