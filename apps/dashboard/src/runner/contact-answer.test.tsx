import { describe, expect, it } from "vitest";
import { pickCollectedEmail } from "./funnel-runner";
import {
  isAnswered,
  evaluateNext,
  type AnswerMap,
  type ContactAnswer,
} from "@rovenue/shared/funnel";

// =============================================================
// `isAnswered` and the evaluator must agree about a composite
// =============================================================
//
// Asserting each side separately would pass even if the two definitions
// drifted apart — and drifting apart is the whole failure that sharing one
// function prevents. So feed ONE value to BOTH and compare.
//
// This closes a gap found by mutation-checking the extraction: reverting
// `evalClause` to its old inline "answered" expression was caught by
// NOTHING, because no test fed a composite through the `is_answered`
// operator. Every test lived on one side of the seam or the other.
//
// SCOPE, stated precisely because the obvious name over-claims: this pins
// that `evalClause` routes through `isAnswered`. It does NOT reach the
// runner's own `answered` gate, which lives inside the FunnelRunner
// component and is only exercised by rendering it with a live session —
// something no test does today. Re-inlining that gate is therefore caught
// by nothing; it is a one-line delegation to this same function, and the
// comment beside it says not to expand it back. Recorded rather than
// implied to be covered.

function evaluatorSaysAnswered(value: ContactAnswer): boolean {
  const answers: AnswerMap = new Map([["q_c", value]]);
  const res = evaluateNext({
    page: {
      id: "pg_1",
      type: "contact_info",
      next_rules: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: "q_c", op: "is_answered" }] },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "contact_info" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

describe("the runner gate and the evaluator agree on a composite", () => {
  it.each<[string, ContactAnswer]>([
    ["no keys", {}],
    ["one blank field", { email: "" }],
    ["one filled field", { email: "a@b.co" }],
    ["one filled, one blank", { email: "a@b.co", phone: "" }],
    ["both filled", { email: "a@b.co", phone: "+15550000" }],
    ["whitespace only", { name: "   " }],
  ])("%s — both layers return the same verdict", (_label, value) => {
    // isAnswered is what the runner's `required` gate calls; the evaluator
    // reaches the same function through its `is_answered` operator.
    expect(evaluatorSaysAnswered(value)).toBe(isAnswered(value));
  });

  it("a partly-filled contact page does NOT satisfy a required gate", () => {
    // The case the old inline gate got wrong: an object is not null, not ""
    // and not an empty array, so it read as answered however blank it was.
    expect(isAnswered({ name: "Ada", email: "" })).toBe(false);
    expect(evaluatorSaysAnswered({ name: "Ada", email: "" })).toBe(false);
  });
});

// =============================================================
// The checkout email pre-fill
// =============================================================
//
// Added because mutation-checking found it unverified: deleting the
// contact_info branch entirely broke no test. It was an inline useMemo body
// no test could reach, so it was extracted to be testable.

describe("pickCollectedEmail", () => {
  const EMAIL_PAGE = { type: "email", question_id: "q_e" };
  const CONTACT_PAGE = { type: "contact_info", question_id: "q_c" };

  it("reads a plain email page", () => {
    expect(pickCollectedEmail([EMAIL_PAGE], { q_e: "a@b.co" })).toBe("a@b.co");
  });

  it("reads the email out of a contact page's composite answer", () => {
    expect(
      pickCollectedEmail([CONTACT_PAGE], { q_c: { name: "Ada", email: "ada@x.co" } }),
    ).toBe("ada@x.co");
  });

  it("ignores a contact page whose email is blank or absent", () => {
    expect(pickCollectedEmail([CONTACT_PAGE], { q_c: { name: "Ada", email: "" } })).toBeUndefined();
    expect(pickCollectedEmail([CONTACT_PAGE], { q_c: { name: "Ada" } })).toBeUndefined();
  });

  it("trims what it finds", () => {
    expect(pickCollectedEmail([CONTACT_PAGE], { q_c: { email: "  a@b.co  " } })).toBe("a@b.co");
  });

  it("takes the LAST source in page order, not the most recently answered", () => {
    // The tie-break that keeps routing deterministic under back-navigation.
    // Both orders are asserted: a rule that merely returned "whichever it
    // saw last in the answers object" would pass one and fail the other.
    const answers = { q_e: "from-email@x.co", q_c: { email: "from-contact@x.co" } };
    expect(pickCollectedEmail([EMAIL_PAGE, CONTACT_PAGE], answers)).toBe("from-contact@x.co");
    expect(pickCollectedEmail([CONTACT_PAGE, EMAIL_PAGE], answers)).toBe("from-email@x.co");
  });

  it("skips a page with no question_id", () => {
    expect(pickCollectedEmail([{ type: "email" }], { q_e: "a@b.co" })).toBeUndefined();
  });
});
