import { describe, expect, it } from "vitest";
import { isAnswered, type AnswerValue } from "./evaluator";

// =============================================================
// isAnswered — ONE definition, shared by the evaluator and the runner
// =============================================================
//
// These two used to compute the same four-way test in two places, aligned
// by hand. A composite answer breaks that alignment in a new way: an
// object with every field blank is neither null nor "" nor an empty array,
// so both copies would have called it answered. This is the single
// definition both now call.

describe("isAnswered — scalars behave exactly as before", () => {
  it.each<[string, AnswerValue | undefined, boolean]>([
    ["undefined", undefined, false],
    ["null", null, false],
    ["empty string", "", false],
    ["empty array", [], false],
    ["a string", "a", true],
    ["a selection", ["a"], true],
    // 0 and false are ANSWERS. A truthiness check would drop both, which is
    // why they are spelled out rather than the test being shortened.
    ["zero", 0, true],
    ["false", false, true],
  ])("%s -> %s", (_label, value, expected) => {
    expect(isAnswered(value)).toBe(expected);
  });
});

describe("isAnswered — a composite is answered when every field it ASKS FOR is filled", () => {
  it("an object with no keys is not answered", () => {
    // The page asked for nothing, so there is nothing to have answered.
    expect(isAnswered({})).toBe(false);
  });

  it("a single asked-for field must be filled", () => {
    expect(isAnswered({ email: "" })).toBe(false);
    expect(isAnswered({ email: "a@b.co" })).toBe(true);
  });

  it("EVERY asked-for field must be filled, not merely one", () => {
    // The case that distinguishes the key-set rule from "any field filled".
    // A page asking for email AND phone is not answered by the email alone.
    expect(isAnswered({ email: "a@b.co", phone: "" })).toBe(false);
    expect(isAnswered({ email: "a@b.co", phone: "+15550000" })).toBe(true);
  });

  it("whitespace is not an answer", () => {
    expect(isAnswered({ name: "   " })).toBe(false);
  });

  it("a page asking for less is answered sooner — with no page flags involved", () => {
    // The key set carries the question, so the evaluator needs to know
    // nothing about collectName/collectEmail/collectPhone.
    expect(isAnswered({ email: "a@b.co" })).toBe(true);
    expect(isAnswered({ email: "a@b.co", name: "" })).toBe(false);
  });
});
