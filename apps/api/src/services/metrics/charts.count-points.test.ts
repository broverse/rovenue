import { describe, expect, it } from "vitest";
import { buildCountSeriesPoints } from "./charts";

// Pure arithmetic backing the subscription-lifecycle chart ids (task 3):
// new_subs, reactivations, trials_started, and (as of fix round 1 —
// see task-3-fixes.md) churn, all four daily COUNTS sharing this one
// function. Same reasoning as charts.rate-points.test.ts: this repo
// cannot run ClickHouse in tests, so the part that can be proven is
// proven here, with real data structures and no mocks.
//
// churn used to have its own `buildChurnRatePoints` helper (a `percent`
// series dividing each day's churn count by a CONSTANT —
// getRevenueSummary's present-day activeSubscriberBase snapshot applied
// to every day in the window). That was caught in review: a point for
// 12 March read as March's churn count over TODAY's active base, not a
// rate for that day. Fixed to a plain daily count, same shape as the
// other three ids in this group — see summary.ts's getChurnDaily for
// the corrected reader and what a real per-day rate would need instead.

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

  it("churn's daily counts (post-fix): each day stands alone, no cross-day constant involved", () => {
    // Regression guard for the fix: two different days with two
    // different churn counts must report exactly those counts, with
    // nothing else (like a shared active-subscriber base) blending
    // them together.
    const points = buildCountSeriesPoints(
      [
        { day: "2026-07-01", n: 1 },
        { day: "2026-07-02", n: 5 },
      ],
      FROM,
      TO,
    );
    expect(points.map((p) => p.value)).toEqual([1, 5, 0]);
  });
});
