import { describe, expect, it } from "vitest";
import { nextRuleSchema } from "./branching-schema";
import type { ClauseOp } from "./branching-schema";

// Two-sided per operator: a guard tested in one direction only is how
// SP5's `not_in` bug survived 45 tests.

const DATE_OPS: ClauseOp[] = ["before", "after", "on_or_before", "on_or_after"];

function parse(op: ClauseOp, value: unknown) {
  return nextRuleSchema.safeParse({
    id: "r_1",
    condition: { op: "all", clauses: [{ question_id: "q_d", op, value }] },
    goto: "pg_2",
  });
}

describe("date operands are validated at the boundary", () => {
  it("accepts a zero-padded ISO date", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-03-01").success, `${op} rejected a valid ISO date`).toBe(true);
    }
  });

  it("rejects an unpadded date, which would sort wrongly as text", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-1-5").success, `${op} accepted an unpadded date`).toBe(false);
    }
  });

  it("rejects a non-string operand", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, 20260301).success, `${op} accepted a number`).toBe(false);
      expect(parse(op, ["2026-03-01"]).success, `${op} accepted an array`).toBe(false);
      expect(parse(op, null).success, `${op} accepted null`).toBe(false);
    }
  });

  it("rejects a date-shaped string carrying extra text", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-03-01T00:00:00Z").success, `${op} accepted a datetime`).toBe(false);
      expect(parse(op, " 2026-03-01").success, `${op} accepted leading space`).toBe(false);
    }
  });

  it("leaves the other operators' operand rules alone", () => {
    // A regression guard: the new branch must not widen or narrow anything
    // else in the same superRefine.
    expect(parse("eq", "anything").success).toBe(true);
    expect(parse("gt", 5).success).toBe(true);
    expect(parse("gt", "5").success).toBe(false);
    expect(parse("in", ["a"]).success).toBe(true);
    expect(parse("contains", "a").success).toBe(true);
  });
});
