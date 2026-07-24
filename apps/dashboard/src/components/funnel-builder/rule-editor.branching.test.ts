import { describe, expect, it } from "vitest";
import { answerKindFor, branchableQuestionIds, coerceOperandValue } from "./rule-editor";
import type { Page } from "./types";

describe("answerKindFor (M-1)", () => {
  it("resolves a known page type", () => {
    expect(answerKindFor("single_choice")).toBe("choice");
    expect(answerKindFor("number_input")).toBe("number");
  });

  // Page.type is typed PageType, but the value originates in server JSON
  // through `as never` casts — an unknown/legacy type must resolve to
  // "none" (unbranchable) rather than throw.
  it("resolves an unknown/legacy type to 'none' instead of throwing", () => {
    expect(() => answerKindFor("some_removed_page_type")).not.toThrow();
    expect(answerKindFor("some_removed_page_type")).toBe("none");
  });
});

describe("branchableQuestionIds (M-2)", () => {
  const pages: Page[] = [
    { id: "pg_1", type: "single_choice", question_id: "q_a", options: [] },
    // contact_info carries a question_id despite answerKind "none" (its
    // answer is a composite of name/email/phone, not a single value) — it
    // must not be offered as a branching target, or a clause ends up with
    // zero valid operators.
    { id: "pg_2", type: "contact_info", question_id: "q_b" },
    { id: "pg_3", type: "info", title: {} },
    { id: "pg_4", type: "number_input", question_id: "q_d" },
  ];

  it("includes questions whose answer kind can actually be compared", () => {
    expect(branchableQuestionIds(pages, 4)).toEqual(["q_a", "q_d"]);
  });

  it("excludes a 'none'-kind question even when it carries a question_id", () => {
    const ids = branchableQuestionIds(pages, 4);
    expect(ids).not.toContain("q_b");
  });

  it("excludes a page with no question_id at all", () => {
    const ids = branchableQuestionIds(pages, 4);
    expect(ids).not.toContain(undefined);
    expect(ids.length).toBe(2);
  });

  it("only looks at pages before uptoIdx", () => {
    expect(branchableQuestionIds(pages, 1)).toEqual(["q_a"]);
    expect(branchableQuestionIds(pages, 0)).toEqual([]);
  });
});

describe("coerceOperandValue — 'between' (I-3)", () => {
  // between's two bounds are as numeric as gt/gte/lt/lte's single operand
  // (evaluator.ts requires typeof === "number" for all five) — the range
  // inputs now go through the same coercion instead of Number() on every
  // keystroke.
  it("coerces a parseable bound to a number", () => {
    expect(coerceOperandValue("between", "18")).toBe(18);
    expect(typeof coerceOperandValue("between", "18")).toBe("number");
  });

  it("leaves an unparseable bound as a string, not NaN", () => {
    expect(coerceOperandValue("between", "")).toBe("");
    expect(coerceOperandValue("between", "-")).toBe("-");
    expect(coerceOperandValue("between", "abc")).toBe("abc");
  });

  it("coerces regardless of the kind argument — between only ever applies to number-kind questions", () => {
    expect(coerceOperandValue("between", "18", "text")).toBe(18);
  });
});
