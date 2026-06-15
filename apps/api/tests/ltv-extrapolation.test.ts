import { describe, expect, test } from "vitest";
import { computeLtvPrediction, type LtvRawRow, type LtvSizeRow } from "../src/services/metrics/ltv-extrapolation";

const H = 2;
const sizes: LtvSizeRow[] = [
  { cohortMonth: "2026-01-01", store: "APP_STORE", productId: "p1", size: 100 },
  { cohortMonth: "2026-02-01", store: "APP_STORE", productId: "p1", size: 100 },
  { cohortMonth: "2026-04-01", store: "APP_STORE", productId: "p1", size: 100 },
];
const mk = (cohort: string, ages: number[]): LtvRawRow[] =>
  ages.map((rev, age) => ({ cohortMonth: cohort, store: "APP_STORE", productId: "p1", ageMonth: age, netUsd: rev }));
const rows: LtvRawRow[] = [
  ...mk("2026-01-01", [600, 300, 100]),
  ...mk("2026-02-01", [600, 300, 100]),
  ...mk("2026-04-01", [600]),
];

describe("computeLtvPrediction", () => {
  test("scales a young cohort up to the horizon via the shared curve", () => {
    const r = computeLtvPrediction(rows, sizes, H, 2, "2026-04-01");
    const young = r.cohorts.find((c) => c.cohortMonth === "2026-04-01")!;
    expect(Number(young.observedLtvUsd)).toBeCloseTo(6, 4);
    expect(Number(young.predictedLtvUsd)).toBeCloseTo(10, 4);
    expect(young.isMature).toBe(false);
    expect(young.maturity).toBeCloseTo(0.6, 4);
    const mature = r.cohorts.find((c) => c.cohortMonth === "2026-01-01")!;
    expect(mature.isMature).toBe(true);
    expect(Number(mature.predictedLtvUsd)).toBeCloseTo(10, 4);
    expect(r.maturityCurve[0]!.fraction).toBeCloseTo(0.6, 4);
    expect(r.maturityCurve[H]!.fraction).toBeCloseTo(1, 4);
    expect(Number(r.blendedPredictedLtvUsd)).toBeCloseTo(10, 4);
    expect(r.byStore[0]!.key).toBe("APP_STORE");
    expect(Number(r.byStore[0]!.predictedLtvUsd)).toBeCloseTo(10, 4);
    expect(r.warning).toBeNull();
  });

  test("sets warning when too few mature cohorts", () => {
    const r = computeLtvPrediction(mk("2026-04-01", [600]), [sizes[2]!], H, 3, "2026-04-01");
    expect(r.warning).not.toBeNull();
  });

  test("empty input → zeros, no throw", () => {
    const r = computeLtvPrediction([], [], H, 3, "2026-04-01");
    expect(Number(r.blendedPredictedLtvUsd)).toBe(0);
    expect(r.cohorts).toHaveLength(0);
  });
});
