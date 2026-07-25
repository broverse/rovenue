import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type AnswerValue } from "./evaluator";
import type { ClauseOp } from "./branching-schema";

// =============================================================
// Date comparison operators
// =============================================================
//
// The comparison is lexicographic, which equals chronological order ONLY
// for zero-padded YYYY-MM-DD. That equivalence is the whole design, and
// the malformed cases below are what make it safe: "2026-1-5" sorts AFTER
// "2026-01-10" as text and BEFORE it as a date, so an unvalidated compare
// routes the visitor to the wrong branch. Every one of those cases must
// come back false.

const DATE_OPS = ["before", "after", "on_or_before", "on_or_after"] as const;

/** Routes through the real evaluator so a `false` is an observed
 *  fall-through, not a hand-asserted return value. */
function fires(op: ClauseOp, answer: AnswerValue | undefined, value: unknown): boolean {
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
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

describe("date operators compare chronologically", () => {
  it("before fires only for an earlier date", () => {
    expect(fires("before", "2026-03-01", "2026-03-02")).toBe(true);
    expect(fires("before", "2026-03-02", "2026-03-01")).toBe(false);
  });

  it("after fires only for a later date", () => {
    expect(fires("after", "2026-03-02", "2026-03-01")).toBe(true);
    expect(fires("after", "2026-03-01", "2026-03-02")).toBe(false);
  });

  it("crosses year and month boundaries correctly", () => {
    // Naive per-component comparison, or a numeric coercion, gets these wrong.
    expect(fires("before", "2025-12-31", "2026-01-01")).toBe(true);
    expect(fires("after", "2026-01-01", "2025-12-31")).toBe(true);
    expect(fires("before", "2026-01-31", "2026-02-01")).toBe(true);
  });

  // The boundary is where an off-by-one in the comparison operator hides.
  it("treats an equal date per its inclusivity", () => {
    const same = "2026-03-01";
    expect(fires("before", same, same)).toBe(false);
    expect(fires("after", same, same)).toBe(false);
    expect(fires("on_or_before", same, same)).toBe(true);
    expect(fires("on_or_after", same, same)).toBe(true);
  });

  it("on_or_before and on_or_after still order strictly either side", () => {
    expect(fires("on_or_before", "2026-03-01", "2026-03-02")).toBe(true);
    expect(fires("on_or_before", "2026-03-02", "2026-03-01")).toBe(false);
    expect(fires("on_or_after", "2026-03-02", "2026-03-01")).toBe(true);
    expect(fires("on_or_after", "2026-03-01", "2026-03-02")).toBe(false);
  });

  // ---- the cases that justify validating instead of just comparing ----

  it("refuses a malformed OPERAND rather than mis-ordering it", () => {
    // "2026-1-5" > "2026-01-10" as text, but is earlier as a date. A raw
    // lexicographic compare would return true for `before` here.
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-01-10", "2026-1-5"), `${op} accepted a malformed operand`).toBe(false);
    }
  });

  it("refuses a malformed ANSWER rather than mis-ordering it", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-1-5", "2026-01-10"), `${op} accepted a malformed answer`).toBe(false);
    }
  });

  it("refuses every non-date answer shape", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, 20260301, "2026-03-01"), `${op} accepted a number`).toBe(false);
      expect(fires(op, ["2026-03-01"], "2026-03-01"), `${op} accepted an array`).toBe(false);
      expect(fires(op, null, "2026-03-01"), `${op} accepted null`).toBe(false);
      expect(fires(op, undefined, "2026-03-01"), `${op} accepted an unanswered question`).toBe(false);
      expect(fires(op, "", "2026-03-01"), `${op} accepted an empty answer`).toBe(false);
    }
  });

  it("refuses a non-string operand", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-03-01", 20260301), `${op} accepted a numeric operand`).toBe(false);
      expect(fires(op, "2026-03-01", null), `${op} accepted a null operand`).toBe(false);
    }
  });
});
