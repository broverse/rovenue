import { describe, expect, it } from "vitest";
import { nextRuleSchema } from "./branching-schema";

describe("nextRuleSchema", () => {
  it("accepts 'all' rule with eq + gte clauses", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r1",
      condition: {
        op: "all",
        clauses: [
          { question_id: "goal", op: "eq", value: "lose_weight" },
          { question_id: "age", op: "gte", value: 40 },
        ],
      },
      goto: "pg_07",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts 'in' clause with array value", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r2",
      condition: { op: "any", clauses: [{ question_id: "g", op: "in", value: ["a", "b"] }] },
      goto: "end",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts 'is_answered' clause with no value", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r3",
      condition: { op: "all", clauses: [{ question_id: "e", op: "is_answered" }] },
      goto: "paywall",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts 'not_contains' with a string value", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r4",
      condition: { op: "all", clauses: [{ question_id: "g", op: "not_contains", value: "a" }] },
      goto: "end",
    });
    expect(ok.success).toBe(true);
  });

  it.each(["contains", "not_contains"] as const)(
    "rejects '%s' with a non-string value",
    (op) => {
      // The evaluator compares against a string member of a string[]
      // answer, so a numeric operand would validate here and then
      // silently never fire — the writable-but-dead rule this whole
      // sub-project removes. Rejecting at the boundary is the fix.
      const bad = nextRuleSchema.safeParse({
        id: "r5",
        condition: { op: "all", clauses: [{ question_id: "g", op, value: 3 }] },
        goto: "end",
      });
      expect(bad.success).toBe(false);
    },
  );

  it.each(["gt", "gte", "lt", "lte"] as const)(
    "accepts '%s' with a number value",
    (op) => {
      const ok = nextRuleSchema.safeParse({
        id: "r6",
        condition: { op: "all", clauses: [{ question_id: "age", op, value: 40 }] },
        goto: "end",
      });
      expect(ok.success).toBe(true);
    },
  );

  it.each(["gt", "gte", "lt", "lte"] as const)(
    "rejects '%s' with a non-number value",
    (op) => {
      // evaluator.ts requires typeof clause.value === "number" for these
      // four ops. A numeric-looking string ("40") validates as a string
      // and then silently never fires — the same writable-but-dead class
      // the contains/not_contains guard above exists to close.
      const bad = nextRuleSchema.safeParse({
        id: "r7",
        condition: { op: "all", clauses: [{ question_id: "age", op, value: "40" }] },
        goto: "end",
      });
      expect(bad.success).toBe(false);
    },
  );

  it("accepts 'between' with two number bounds", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r8",
      condition: { op: "all", clauses: [{ question_id: "age", op: "between", value: [18, 65] }] },
      goto: "end",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects 'between' with non-number bounds", () => {
    // [null, null] is what a NaN bound JSON-serialises to. It has the
    // right length and used to pass, then never matched in evalClause.
    const bad = nextRuleSchema.safeParse({
      id: "r9",
      condition: { op: "all", clauses: [{ question_id: "age", op: "between", value: [null, null] }] },
      goto: "end",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects 'between' with one number bound and one string bound", () => {
    const bad = nextRuleSchema.safeParse({
      id: "r10",
      condition: { op: "all", clauses: [{ question_id: "age", op: "between", value: [18, "65"] }] },
      goto: "end",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown op", () => {
    const bad = nextRuleSchema.safeParse({
      id: "r4",
      condition: { op: "all", clauses: [{ question_id: "x", op: "regex", value: ".*" }] },
      goto: "pg_1",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects empty clauses array", () => {
    const bad = nextRuleSchema.safeParse({
      id: "r5",
      condition: { op: "all", clauses: [] },
      goto: "pg_1",
    });
    expect(bad.success).toBe(false);
  });
});
