import { describe, expect, it } from "vitest";
import {
  answerKindFor,
  answerKindForTarget,
  branchableQuestionIds,
  coerceOperandValue,
} from "./rule-editor";
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
    // contact_info used to be the one page type carrying a question_id
    // while classified "none". SP9 gave it answerKind "composite" (it
    // offers is_answered), so it IS branchable now and appears below.
    { id: "pg_2", type: "contact_info", question_id: "q_b" },
    { id: "pg_3", type: "info", title: {} },
    { id: "pg_4", type: "number_input", question_id: "q_d" },
  ];

  it("includes questions whose answer kind can actually be compared", () => {
    // pg_2 is contact_info with no collect* flags, so it contributes the
    // composite plus its two default-ON sub-fields (name, email).
    expect(branchableQuestionIds(pages, 4)).toEqual([
      "q_a",
      "q_b",
      "q_b.name",
      "q_b.email",
      "q_d",
    ]);
  });

  it("still excludes a question whose type resolves to a kind with no operators", () => {
    // After SP9 no page type SHIPS in this state — contact_info was the
    // last one — so the guard is exercised with the case that can still
    // reach it: stored JSON. A funnel authored through the API, or written
    // before a page type was removed, can hold a question_id on a type
    // that maps to "none". Offering it would leave a clause whose operator
    // <select> renders zero options.
    const stored: Page[] = [
      { id: "pg_a", type: "single_choice", question_id: "q_ok", options: [] } as never,
      { id: "pg_b", type: "info", question_id: "q_dead" } as never,
      { id: "pg_c", type: "some_removed_page_type", question_id: "q_gone" } as never,
    ];
    expect(branchableQuestionIds(stored, 3)).toEqual(["q_ok"]);
  });

  it("offers contact_info now that it has a comparable answer", () => {
    // It was the standing example of a question_id with no usable operators.
    // SP9 gave it is_answered, so excluding it would hide a rule an author
    // can legitimately write. The none-kind guard itself is covered by the
    // stored-JSON case above.
    expect(branchableQuestionIds(pages, 4)).toContain("q_b");
  });

  it("excludes a page with no question_id at all", () => {
    const ids = branchableQuestionIds(pages, 4);
    expect(ids).not.toContain(undefined);
    // pg_3 is an info page with no question_id. The other three have one, and
    // the contact page adds two sub-fields on top.
    expect(ids.length).toBe(5);
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

describe("contact_info sub-fields (SP11)", () => {
  const contactPages: Page[] = [
    {
      id: "pg_c",
      type: "contact_info",
      question_id: "q_c",
      collectName: true,
      collectEmail: true,
      collectPhone: false,
    } as never,
    { id: "pg_x", type: "info", title: {} } as never,
  ];

  it("offers the composite AND one entry per field the page asks for", () => {
    // The composite answers "did they give their details"; the sub-fields
    // answer "is the email X". Both are legitimate questions.
    expect(branchableQuestionIds(contactPages, 2)).toEqual(["q_c", "q_c.name", "q_c.email"]);
  });

  it("never offers a field the page does not collect", () => {
    // Driven by the SHARED contactFieldsAsked, so the editor cannot offer a
    // sub-field the renderer never shows — two definitions of "which fields
    // does this page ask for" is the drift this consolidation prevents.
    expect(branchableQuestionIds(contactPages, 2)).not.toContain("q_c.phone");

    const withPhone = [{ ...contactPages[0], collectPhone: true } as never] as Page[];
    expect(branchableQuestionIds(withPhone, 1)).toContain("q_c.phone");
  });

  it("respects the collectName/collectEmail default-ON asymmetry", () => {
    // Flags absent entirely: name and email are asked for, phone is not.
    const bare = [{ id: "pg_c", type: "contact_info", question_id: "q_c" } as never] as Page[];
    expect(branchableQuestionIds(bare, 1)).toEqual(["q_c", "q_c.name", "q_c.email"]);
  });

  it("classifies a sub-field target as text, and the composite as composite", () => {
    expect(answerKindForTarget(contactPages, "q_c.email")).toBe("text");
    expect(answerKindForTarget(contactPages, "q_c")).toBe("composite");
    expect(answerKindForTarget(contactPages, "q_nope")).toBe("none");
  });
})
