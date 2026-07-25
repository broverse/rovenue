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

  it("offers 'in'/'not_in' to number too — evalClause places no element-type constraint on them", () => {
    // {op:"in", value:[5,10,15]} against a numeric answer fires exactly as
    // eq does. Omitting it from `number` was live-but-unoffered — the
    // mirror image of the writable-but-dead class this sub-project removes.
    expect(OPERATORS_BY_KIND.number).toContain("in");
    expect(OPERATORS_BY_KIND.number).toContain("not_in");
  });

  it("never offers a scalar equality operator to multi", () => {
    // These are the ones that used to fire by accident on an array.
    for (const op of ["eq", "neq", "in", "not_in"] as const) {
      expect(OPERATORS_BY_KIND.multi).not.toContain(op);
    }
  });

  it("offers the unary operators to every answering kind", () => {
    // DERIVED from OPERATORS_BY_KIND, not hand-listed. This loop used to
    // enumerate ["text", "choice", "multi", "number"] under a name claiming
    // "every answering kind" — and when `date` joined AnswerKind the test
    // kept passing while silently covering one kind fewer. A kind is
    // "answering" precisely when it offers operators, so read that off the
    // table instead of restating it.
    const answering = (Object.keys(OPERATORS_BY_KIND) as AnswerKind[]).filter(
      (kind) => OPERATORS_BY_KIND[kind].length > 0,
    );
    for (const kind of answering) {
      expect(OPERATORS_BY_KIND[kind], `${kind} does not offer is_answered`).toContain("is_answered");
      expect(OPERATORS_BY_KIND[kind], `${kind} does not offer is_not_answered`).toContain(
        "is_not_answered",
      );
    }
  });

  it("offers nothing to a page that asks no question", () => {
    expect(OPERATORS_BY_KIND.none).toEqual([]);
  });

  it("coerces eq/neq to a number when the question answers with one", () => {
    // evalClause compares with ===, so `5 === "5"` is false. Left as a
    // string, `eq` on a numeric question is dead and `neq` fires for
    // EVERY visitor — silently rerouting the whole funnel.
    expect(coerceOperandValue("eq", "5", "number")).toBe(5);
    expect(coerceOperandValue("neq", "5", "number")).toBe(5);
    // ...and stays a string where the answer is a string.
    expect(coerceOperandValue("eq", "5", "text")).toBe("5");
  });

  it("never produces NaN from a non-numeric operand", () => {
    // NaN JSON-serialises to null, which passes the schema's
    // value-present check and then never matches — a dead rule that
    // looks valid. The coercion runs on BLUR so typing stays free; these
    // are the values that reach it.
    expect(coerceOperandValue("gt", "", "number")).toBe("");
    expect(coerceOperandValue("gt", "-", "number")).toBe("-");
    expect(coerceOperandValue("gt", "abc", "number")).toBe("abc");
    expect(coerceOperandValue("gt", "1.5", "number")).toBe(1.5);
    expect(coerceOperandValue("gt", " 42 ", "number")).toBe(42);
  });

  it("every operator it offers has a label the editor can render", async () => {
    // OPERATORS_BY_KIND is one table, the editor's label list is another.
    // not_contains shipped in the evaluator, was accepted by the schema,
    // was offered by this constant — and had no label, so the <select>
    // filtered it out and no author could ever write it. Correct but
    // unwritable is the same defect as writable but dead.
    const { RENDERABLE_OPS } = await import("./rule-editor");
    for (const ops of Object.values(OPERATORS_BY_KIND)) {
      for (const op of ops) {
        expect(RENDERABLE_OPS.has(op), `${op} is offered but has no label`).toBe(true);
      }
    }
  });

  it("classifies every page type with a valid AnswerKind", () => {
    // `PAGE_TYPES` is typed `Record<PageType, PageTypeMeta>` with a
    // required `answerKind`, so `toBeDefined()` cannot fail without
    // someone first weakening the type. Checking membership in the
    // AnswerKind union is the version that stays meaningful if that ever
    // happens — a new page type added without an answerKind, or with one
    // outside the union, is what this exists to catch.
    const VALID_KINDS: ReadonlySet<AnswerKind> = new Set([
      "text", "choice", "multi", "number", "date", "composite", "none",
    ]);
    for (const [type, meta] of Object.entries(PAGE_TYPES)) {
      expect(VALID_KINDS.has(meta.answerKind), `${type} has an invalid answerKind: ${meta.answerKind}`).toBe(
        true,
      );
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
