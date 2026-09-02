import { describe, expect, it } from "vitest";
import { buildMrrSeriesPoints } from "./charts";
import type { MrrPoint } from "./mrr";

// buildMrrSeriesPoints is the arithmetic behind the four revenue
// chart-series ids (mrr, arr, gross_vs_net, arpu) — extracted out of
// SQL for the same reason buildRatePoints is, and proven the same
// way: real data structures, no ClickHouse, no mocks.

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-03T23:59:59.999Z");

function point(overrides: Partial<MrrPoint> & { bucket: Date }): MrrPoint {
  return {
    grossUsd: "0",
    refundsUsd: "0",
    netUsd: "0",
    eventCount: 0,
    activeSubscribers: 0,
    ...overrides,
  };
}

describe("buildMrrSeriesPoints", () => {
  it("emits one point per day in the window, ascending", () => {
    const points = buildMrrSeriesPoints([], FROM, TO, () => 0);
    expect(points.map((p) => p.bucket)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });

  it("passes each day's row to extract, undefined when the day has no row", () => {
    const rows = [point({ bucket: new Date("2026-07-02T00:00:00.000Z"), netUsd: "42" })];
    const seen: Array<MrrPoint | undefined> = [];
    buildMrrSeriesPoints(rows, FROM, TO, (row) => {
      seen.push(row);
      return row ? Number(row.netUsd) : 0;
    });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.netUsd).toBe("42");
    expect(seen[2]).toBeUndefined();
  });

  it("mrr: a day absent from ClickHouse is a real, measured zero — not null", () => {
    const points = buildMrrSeriesPoints([], FROM, TO, (row) =>
      row ? Number(row.netUsd) : 0,
    );
    expect(points.every((p) => p.value === 0)).toBe(true);
  });

  it("arr: annualises net MRR (x12)", () => {
    const rows = [point({ bucket: new Date("2026-07-02T00:00:00.000Z"), netUsd: "100" })];
    const points = buildMrrSeriesPoints(rows, FROM, TO, (row) =>
      row ? Number(row.netUsd) * 12 : 0,
    );
    expect(points[1]?.value).toBe(1200);
  });

  it("gross_vs_net: plots net ÷ gross as a 0-100 percentage", () => {
    const rows = [
      point({
        bucket: new Date("2026-07-02T00:00:00.000Z"),
        grossUsd: "150",
        refundsUsd: "30",
        netUsd: "120",
      }),
    ];
    const points = buildMrrSeriesPoints(rows, FROM, TO, (row) => {
      if (!row) return null;
      const gross = Number(row.grossUsd);
      if (gross <= 0) return null;
      return Math.round((Number(row.netUsd) / gross) * 100 * 10) / 10;
    });
    expect(points[1]?.value).toBe(80);
  });

  it("gross_vs_net: reports null — NOT zero — when gross is zero that day", () => {
    const rows = [
      point({
        bucket: new Date("2026-07-02T00:00:00.000Z"),
        grossUsd: "0",
        refundsUsd: "0",
        netUsd: "0",
      }),
    ];
    const points = buildMrrSeriesPoints(rows, FROM, TO, (row) => {
      if (!row) return null;
      const gross = Number(row.grossUsd);
      if (gross <= 0) return null;
      return Math.round((Number(row.netUsd) / gross) * 100 * 10) / 10;
    });
    expect(points[1]?.value).toBeNull();
  });

  it("arpu: divides net revenue by active subscribers for a day with both", () => {
    const rows = [
      point({
        bucket: new Date("2026-07-02T00:00:00.000Z"),
        netUsd: "100",
        activeSubscribers: 4,
      }),
    ];
    const points = buildMrrSeriesPoints(rows, FROM, TO, (row) =>
      row && row.activeSubscribers > 0 ? Number(row.netUsd) / row.activeSubscribers : null,
    );
    expect(points[1]?.value).toBe(25);
  });

  it("arpu: reports null — NOT zero — when there are no active subscribers that day", () => {
    const rows = [
      point({
        bucket: new Date("2026-07-02T00:00:00.000Z"),
        netUsd: "0",
        activeSubscribers: 0,
      }),
    ];
    const points = buildMrrSeriesPoints(rows, FROM, TO, (row) =>
      row && row.activeSubscribers > 0 ? Number(row.netUsd) / row.activeSubscribers : null,
    );
    expect(points[1]?.value).toBeNull();
  });

  it("arpu: a day absent from ClickHouse (no active subscribers) is also null", () => {
    const points = buildMrrSeriesPoints([], FROM, TO, (row) =>
      row && row.activeSubscribers > 0 ? Number(row.netUsd) / row.activeSubscribers : null,
    );
    expect(points.every((p) => p.value === null)).toBe(true);
  });
});
