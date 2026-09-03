import { describe, expect, it } from "vitest";
import { buildChurnRatePoints, buildCountSeriesPoints } from "./charts";

// Pure arithmetic backing the subscription-lifecycle chart ids (task 3),
// same reasoning as charts.rate-points.test.ts: this repo cannot run
// ClickHouse in tests, so the part that can be proven is proven here,
// with real data structures and no mocks.

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-03T23:59:59.999Z");

describe("buildCountSeriesPoints", () => {
  it("emits one point per day in the window, ascending", () => {
    const points = buildCountSeriesPoints([], FROM, TO);
    expect(points.map((p) => p.bucket)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });

  it("a day present in the rows reports its count", () => {
    const points = buildCountSeriesPoints(
      [{ day: "2026-07-02", n: 7 }],
      FROM,
      TO,
    );
    expect(points[1]?.value).toBe(7);
  });

  it("a day ABSENT from the rows is a real, measured zero — not null", () => {
    // Unlike buildRatePoints, there is no ratio here, so no
    // zero-denominator case: nothing happening on a day is a fact, not
    // an undefined value.
    const points = buildCountSeriesPoints([], FROM, TO);
    expect(points[0]?.value).toBe(0);
    expect(points[0]?.value).not.toBeNull();
  });
});

describe("buildChurnRatePoints", () => {
  it("emits one point per day in the window, ascending", () => {
    const points = buildChurnRatePoints([], 0, FROM, TO);
    expect(points.map((p) => p.bucket)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });

  it("holds the active-subscriber base constant across every day, moving only the numerator", () => {
    const points = buildChurnRatePoints(
      [
        { day: "2026-07-01", n: 1 },
        { day: "2026-07-02", n: 2 },
      ],
      8,
      FROM,
      TO,
    );
    // day 1: 1 / (8 + 1) = 11.1%
    expect(points[0]?.value).toBe(11.1);
    expect(points[0]?.denominator).toBe(9);
    // day 2: 2 / (8 + 2) = 20%
    expect(points[1]?.value).toBe(20);
    expect(points[1]?.denominator).toBe(10);
    // day 3 (no churn that day): 0 / (8 + 0) = 0%, a measured zero
    expect(points[2]?.value).toBe(0);
    expect(points[2]?.denominator).toBe(8);
  });

  it("both active base and that day's churn at zero is an undefined rate — null, not 0%", () => {
    const points = buildChurnRatePoints([], 0, FROM, TO);
    expect(points.every((p) => p.value === null)).toBe(true);
  });

  it("a day absent from churnedByDay still gets the full (non-zero) active base as its denominator", () => {
    // This is the exact bug densification exists to prevent: naively
    // reusing buildRatePoints with a sparse denominator series would
    // default a missing day's denominator to 0, reporting an undefined
    // rate on a day that in fact had a well-defined (zero-churn) one.
    const points = buildChurnRatePoints(
      [{ day: "2026-07-01", n: 3 }],
      10,
      FROM,
      TO,
    );
    expect(points[1]?.denominator).toBe(10);
    expect(points[1]?.value).toBe(0);
  });
});
