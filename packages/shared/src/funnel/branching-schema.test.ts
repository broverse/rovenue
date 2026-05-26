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
