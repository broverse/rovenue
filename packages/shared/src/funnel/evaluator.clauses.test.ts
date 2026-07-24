import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type AnswerValue } from "./evaluator";
import type { ClauseOp } from "./branching-schema";

// Does a single clause fire? Routed through evaluateNext because
// evalClause is module-private: a matching rule goes to "pg_hit", a
// non-matching one falls through to default_next ("pg_miss").
function fires(op: ClauseOp, answer: AnswerValue | undefined, value?: unknown): boolean {
  const answers: AnswerMap = new Map();
  if (answer !== undefined) answers.set("q", answer);
  const result = evaluateNext({
    page: {
      id: "pg_1",
      type: "question",
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all",
            clauses: [{ question_id: "q", op, ...(value === undefined ? {} : { value }) }],
          },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "question" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return result.next === "page" && result.pageId === "pg_hit";
}

describe("evalClause — an array answer never matches a scalar operator", () => {
  const ARRAY: AnswerValue = ["a", "b"];

  // The load-bearing assertion of this whole sub-project. Listing every
  // scalar operator rather than only the two that were broken means the
  // next one added cannot regress quietly.
  it.each<[ClauseOp, unknown]>([
    ["eq", "a"],
    ["neq", "a"],
    ["in", ["a", "z"]],
    ["not_in", ["a", "z"]],
    ["gt", 1],
    ["gte", 1],
    ["lt", 1],
    ["lte", 1],
    ["between", [0, 5]],
  ])("%s does not fire for an array answer", (op, value) => {
    expect(fires(op, ARRAY, value)).toBe(false);
  });

  it("neq was the dangerous one: it fired even when the option WAS picked", () => {
    expect(fires("neq", ["a"], "a")).toBe(false);
  });

  it("not_in was equally dangerous", () => {
    expect(fires("not_in", ["a"], ["a", "z"])).toBe(false);
  });
});

describe("evalClause — arrays have their own operators", () => {
  it("contains fires when the option is among the selections", () => {
    expect(fires("contains", ["a", "b"], "a")).toBe(true);
  });

  it("contains does not fire when it is not", () => {
    expect(fires("contains", ["b"], "a")).toBe(false);
  });

  it("not_contains fires when the option is absent", () => {
    expect(fires("not_contains", ["b"], "a")).toBe(true);
  });

  it("not_contains does NOT fire when the option is present", () => {
    expect(fires("not_contains", ["a", "b"], "a")).toBe(false);
  });

  it("not_contains does not fire for a non-array answer — same can't-compare rule", () => {
    expect(fires("not_contains", "a", "z")).toBe(false);
  });
});

describe("evalClause — is_answered agrees with the runner's gate", () => {
  it.each<[string, AnswerValue | undefined]>([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["empty array", []],
  ])("%s is NOT answered", (_label, answer) => {
    expect(fires("is_answered", answer)).toBe(false);
    expect(fires("is_not_answered", answer)).toBe(true);
  });

  it.each<[string, AnswerValue]>([
    ["a string", "a"],
    ["zero", 0],
    ["false", false],
    ["a non-empty array", ["a"]],
  ])("%s IS answered", (_label, answer) => {
    expect(fires("is_answered", answer)).toBe(true);
    expect(fires("is_not_answered", answer)).toBe(false);
  });
});

describe("evalClause — scalar answers are unchanged", () => {
  it("eq still matches a scalar", () => {
    expect(fires("eq", "a", "a")).toBe(true);
  });

  it("neq on an UNANSWERED question still fires — deliberately unchanged", () => {
    // "they did not say x, including by skipping" is a meaningful
    // reading, unlike an array-versus-scalar type mismatch. Narrowing
    // this would also make is_not_answered redundant.
    expect(fires("neq", undefined, "x")).toBe(true);
  });

  it("gt still matches a number", () => {
    expect(fires("gt", 5, 3)).toBe(true);
  });
});
