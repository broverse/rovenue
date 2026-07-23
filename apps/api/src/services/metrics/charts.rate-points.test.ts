import { describe, expect, it } from "vitest";
import { buildRatePoints } from "./charts";

// buildRatePoints is the whole reason the readers split their
// arithmetic out of SQL: this repo cannot run ClickHouse in tests,
// so the part that can be proven is proven here, with real data
// structures and no mocks.

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-03T23:59:59.999Z");

describe("buildRatePoints", () => {
  it("emits one point per day in the window, ascending", () => {
    const points = buildRatePoints([], [], FROM, TO);
    expect(points.map((p) => p.bucket)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });

  it("computes the ratio as a percentage for a day with both sides", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-02", n: "3" }],
      [{ day: "2026-07-02", n: "12" }],
      FROM,
      TO,
    );
    const day2 = points[1];
    expect(day2?.value).toBe(25);
    expect(day2?.numerator).toBe(3);
    expect(day2?.denominator).toBe(12);
  });

  it("reports null — NOT zero — when the denominator is zero", () => {
    // The distinction this whole field exists for. A day with no
    // paywall traffic has an UNDEFINED conversion rate; drawing it as
    // 0% would read as a collapse rather than an absence.
    const points = buildRatePoints(
      [],
      [{ day: "2026-07-02", n: "0" }],
      FROM,
      TO,
    );
    expect(points[1]?.value).toBeNull();
    expect(points[1]?.denominator).toBe(0);
  });

  it("reports zero — NOT null — when the numerator is zero but the denominator is not", () => {
    const points = buildRatePoints(
      [],
      [{ day: "2026-07-02", n: "40" }],
      FROM,
      TO,
    );
    expect(points[1]?.value).toBe(0);
  });

  it("treats a day missing from the denominator rows as zero-denominator", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-01", n: "5" }],
      [],
      FROM,
      TO,
    );
    expect(points[0]?.value).toBeNull();
  });

  it("rounds to one decimal place", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-01", n: "1" }],
      [{ day: "2026-07-01", n: "3" }],
      FROM,
      TO,
    );
    expect(points[0]?.value).toBe(33.3);
  });
});
