import { describe, expect, it } from "vitest";
import { completedPeriodStarts, shouldLockUsage } from "./usage-lock-rule";

const P1 = new Date(Date.UTC(2026, 4, 1)); // May 2026
const P2 = new Date(Date.UTC(2026, 5, 1)); // Jun 2026

function row(meterKey: string, periodStart: Date, current: number, limit: number | null) {
  return {
    meterKey,
    periodStart,
    currentValue: String(current),
    limitValue: limit === null ? null : String(limit),
  };
}

describe("shouldLockUsage", () => {
  it("locks when a hard meter is at/over limit in both periods", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, 5_000_000), row("events", P2, 5_000_000, 5_000_000)],
        [P1, P2],
      ),
    ).toBe(true);
  });

  it("locks when different hard meters are over in each period", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, 5_000_000), row("sql_queries", P2, 101, 100)],
        [P1, P2],
      ),
    ).toBe(true);
  });

  it("does not lock on a single over-limit period", () => {
    expect(
      shouldLockUsage([row("events", P2, 6_000_000, 5_000_000)], [P1, P2]),
    ).toBe(false);
  });

  it("never locks on MTR (soft cap), even over in both periods", () => {
    expect(
      shouldLockUsage(
        [row("mtr", P1, 9000, 5000), row("mtr", P2, 9000, 5000)],
        [P1, P2],
      ),
    ).toBe(false);
  });

  it("does not lock when the limit is null (unlimited tier)", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, null), row("events", P2, 6_000_000, null)],
        [P1, P2],
      ),
    ).toBe(false);
  });

  it("does not lock with no history", () => {
    expect(shouldLockUsage([], [P1, P2])).toBe(false);
  });
});

describe("completedPeriodStarts", () => {
  it("returns the two most recent completed calendar months", () => {
    const [a, b] = completedPeriodStarts(new Date(Date.UTC(2026, 6, 21))); // Jul 21
    expect(a.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(b.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("handles january rollover", () => {
    const [a, b] = completedPeriodStarts(new Date(Date.UTC(2026, 0, 5)));
    expect(a.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(b.toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });
});
