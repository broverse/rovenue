import { describe, expect, it } from "vitest";
import { evaluateNext, shiftIsoDays, type AnswerMap, type AnswerValue } from "./evaluator";
import type { ClauseOp } from "./branching-schema";

// =============================================================
// Relative date operators
// =============================================================
//
// `today` is INJECTED, never read from a clock inside the evaluator, so
// these tests need no frozen time. Real routing is server-side only
// (funnel-runner.tsx never calls evaluateNext), which is why one authority
// for "now" is enough.

const TODAY = "2026-07-26";

function fires(
  op: ClauseOp,
  answer: AnswerValue | undefined,
  value: unknown,
  today: string | undefined = TODAY,
): boolean {
  const answers: AnswerMap = new Map();
  if (answer !== undefined) answers.set("q_d", answer);
  const res = evaluateNext({
    page: {
      id: "pg_1",
      type: "date_input",
      next_rules: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: "q_d", op, value } as never] },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "date_input" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
    today,
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

describe("shiftIsoDays — calendar arithmetic, the part that cannot be done as text", () => {
  it("crosses a month boundary", () => {
    expect(shiftIsoDays("2026-07-26", -30)).toBe("2026-06-26");
    expect(shiftIsoDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    expect(shiftIsoDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    // 2028 is a leap year; 2027 is not.
    expect(shiftIsoDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftIsoDays("2027-03-01", -1)).toBe("2027-02-28");
  });

  it("zero is identity", () => {
    expect(shiftIsoDays(TODAY, 0)).toBe(TODAY);
  });

  it("refuses a malformed date rather than inventing one", () => {
    expect(shiftIsoDays("2026-1-5", -1)).toBeNull();
    expect(shiftIsoDays("nonsense", -1)).toBeNull();
  });
});

describe("within_last_days — inclusive at both ends", () => {
  it("matches today", () => {
    expect(fires("within_last_days", TODAY, 30)).toBe(true);
  });

  it("matches the cutoff date itself", () => {
    // today - 30. The boundary is where an off-by-one hides.
    expect(fires("within_last_days", "2026-06-26", 30)).toBe(true);
  });

  it("does NOT match the day before the cutoff", () => {
    expect(fires("within_last_days", "2026-06-25", 30)).toBe(false);
  });

  it("does NOT match a future date", () => {
    expect(fires("within_last_days", "2026-07-27", 30)).toBe(false);
  });

  it("with 0 days means today only", () => {
    expect(fires("within_last_days", TODAY, 0)).toBe(true);
    expect(fires("within_last_days", "2026-07-25", 0)).toBe(false);
  });
});

describe("more_than_days_ago — strictly older than the cutoff", () => {
  it("matches the day before the cutoff", () => {
    expect(fires("more_than_days_ago", "2026-06-25", 30)).toBe(true);
  });

  it("does NOT match the cutoff date itself", () => {
    // Exactly 30 days ago is NOT "more than 30 days ago" — this is what
    // makes the two operators complementary rather than overlapping.
    expect(fires("more_than_days_ago", "2026-06-26", 30)).toBe(false);
  });

  it("does NOT match today or a future date", () => {
    expect(fires("more_than_days_ago", TODAY, 30)).toBe(false);
    expect(fires("more_than_days_ago", "2026-07-27", 30)).toBe(false);
  });
});

describe("the two operators partition the past, with no overlap and no gap", () => {
  it.each([
    "2026-07-26", // today
    "2026-07-25",
    "2026-06-27",
    "2026-06-26", // the cutoff
    "2026-06-25",
    "2020-01-01",
  ])("exactly one of the two fires for %s", (date) => {
    const a = fires("within_last_days", date, 30);
    const b = fires("more_than_days_ago", date, 30);
    expect([a, b].filter(Boolean), `${date} matched ${a && b ? "both" : "neither"}`).toHaveLength(
      1,
    );
  });

  it("a future date matches neither — documented, not accidental", () => {
    expect(fires("within_last_days", "2026-07-27", 30)).toBe(false);
    expect(fires("more_than_days_ago", "2026-07-27", 30)).toBe(false);
  });
});

describe("what the relative operators refuse", () => {
  const RELATIVE = ["within_last_days", "more_than_days_ago"] as const;

  it("returns false when `today` was not injected at all", () => {
    // The forgot-to-pass-it case. Silent false routes to default_next,
    // which is defined behaviour; answering true would route the visitor
    // somewhere nobody chose.
    //
    // Deliberately NOT expressed as `fires(op, TODAY, 30, undefined)`:
    // `fires`'s `today` parameter has a default, and passing `undefined`
    // explicitly TRIGGERS that default rather than omitting the value. The
    // first version of this test did exactly that and passed against a
    // production guard it never reached. Building the input without the key
    // is the only way to test the omission.
    for (const op of RELATIVE) {
      const answers: AnswerMap = new Map([["q_d", TODAY as AnswerValue]]);
      const res = evaluateNext({
        page: {
          id: "pg_1",
          type: "date_input",
          next_rules: [
            {
              id: "r_1",
              condition: { op: "all", clauses: [{ question_id: "q_d", op, value: 30 } as never] },
              goto: "pg_hit",
            },
          ],
          default_next: "pg_miss",
        },
        pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
        answers,
        pagesById: new Map([
          ["pg_1", { id: "pg_1", type: "date_input" }],
          ["pg_hit", { id: "pg_hit", type: "info" }],
          ["pg_miss", { id: "pg_miss", type: "info" }],
        ]),
        // no `today`
      });
      expect(res.next === "page" && res.pageId === "pg_hit", `${op} fired without today`).toBe(
        false,
      );
    }
  });

  it("refuses a malformed answer, reusing the ISO guard", () => {
    for (const op of RELATIVE) {
      expect(fires(op, "2026-7-2", 30), `${op} accepted an unpadded answer`).toBe(false);
    }
  });

  it("refuses every non-date answer shape", () => {
    for (const op of RELATIVE) {
      expect(fires(op, 20260726, 30), `${op} accepted a number`).toBe(false);
      expect(fires(op, ["2026-07-26"], 30), `${op} accepted an array`).toBe(false);
      expect(fires(op, null, 30), `${op} accepted null`).toBe(false);
      expect(fires(op, "", 30), `${op} accepted an empty answer`).toBe(false);
    }
  });

  it("refuses an operand that is not a whole non-negative day count", () => {
    for (const op of RELATIVE) {
      expect(fires(op, TODAY, "30"), `${op} accepted a string operand`).toBe(false);
      expect(fires(op, TODAY, -1), `${op} accepted a negative count`).toBe(false);
      expect(fires(op, TODAY, 1.5), `${op} accepted a fractional count`).toBe(false);
    }
  });

  it("refuses a malformed `today` rather than comparing against garbage", () => {
    for (const op of RELATIVE) {
      expect(fires(op, TODAY, 30, "2026-7-26"), `${op} accepted a malformed today`).toBe(false);
    }
  });
});
