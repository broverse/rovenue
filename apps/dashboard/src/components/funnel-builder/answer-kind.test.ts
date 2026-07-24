import { describe, expect, it } from "vitest";
import { OPERATORS_BY_KIND, PAGE_TYPES, type AnswerKind } from "./types";
import { coerceOperandValue } from "./rule-editor";

describe("OPERATORS_BY_KIND", () => {
  it("offers array operators only to multi", () => {
    expect(OPERATORS_BY_KIND.multi).toContain("contains");
    expect(OPERATORS_BY_KIND.multi).toContain("not_contains");
    for (const kind of ["text", "choice", "number"] as AnswerKind[]) {
      expect(OPERATORS_BY_KIND[kind]).not.toContain("contains");
      expect(OPERATORS_BY_KIND[kind]).not.toContain("not_contains");
    }
  });

  it("offers numeric operators only to number", () => {
    for (const op of ["gt", "gte", "lt", "lte", "between"] as const) {
      expect(OPERATORS_BY_KIND.number).toContain(op);
      for (const kind of ["text", "choice", "multi"] as AnswerKind[]) {
        expect(OPERATORS_BY_KIND[kind]).not.toContain(op);
      }
    }
  });

  it("never offers a scalar equality operator to multi", () => {
    // These are the ones that used to fire by accident on an array.
    for (const op of ["eq", "neq", "in", "not_in"] as const) {
      expect(OPERATORS_BY_KIND.multi).not.toContain(op);
    }
  });

  it("offers the unary operators to every answering kind", () => {
    for (const kind of ["text", "choice", "multi", "number"] as AnswerKind[]) {
      expect(OPERATORS_BY_KIND[kind]).toContain("is_answered");
      expect(OPERATORS_BY_KIND[kind]).toContain("is_not_answered");
    }
  });

  it("offers nothing to a page that asks no question", () => {
    expect(OPERATORS_BY_KIND.none).toEqual([]);
  });

  it("classifies every page type", () => {
    // A new page type added without an answerKind would otherwise be
    // silently unbranchable.
    for (const [type, meta] of Object.entries(PAGE_TYPES)) {
      expect(meta.answerKind, `${type} has no answerKind`).toBeDefined();
    }
  });
});

describe("coerceOperandValue", () => {
  // gt/gte/lt/lte require typeof clause.value === "number" in evalClause
  // (packages/shared/src/funnel/evaluator.ts) — a raw string operand can
  // never match, silently dead-ending those four operators. This is the
  // assertion Step 8's mutation-check targets directly.
  it.each(["gt", "gte", "lt", "lte"] as const)(
    "coerces the %s operand to a number",
    (op) => {
      const v = coerceOperandValue(op, "5");
      expect(typeof v).toBe("number");
      expect(v).toBe(5);
    },
  );

  it("leaves non-numeric operators' operands as strings", () => {
    expect(coerceOperandValue("eq", "5")).toBe("5");
    expect(typeof coerceOperandValue("eq", "5")).toBe("string");
  });
});

describe("answerKind agrees with what the wired inputs actually emit", () => {
  // PagePreview captures answers for exactly these types today (SP4).
  // The value each one emits must match what its answerKind promises,
  // or the editor offers an operator the evaluator cannot fire.
  //
  // If you wire a new input type and this test does not mention it, that
  // is the gap — add it here.
  it.each<[string, "string" | "array"]>([
    ["email", "string"],
    ["short_text", "string"],
    ["text_input", "string"],
    ["single_choice", "string"],
    ["yes_no", "string"],
    ["multi_choice", "array"],
  ])("%s emits a %s", (pageType, shape) => {
    const kind = PAGE_TYPES[pageType as keyof typeof PAGE_TYPES].answerKind;
    expect(shape === "array" ? kind === "multi" : kind !== "multi").toBe(true);
  });
});
