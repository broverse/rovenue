import { describe, it, expect } from "vitest";
import { selectUniqueCandidate } from "./deferred-match";

describe("selectUniqueCandidate", () => {
  it("returns the single candidate when exactly one", () => {
    expect(selectUniqueCandidate([{ id: "a" }])).toEqual({ id: "a" });
  });
  it("returns null when no candidates (no match)", () => {
    expect(selectUniqueCandidate([])).toBeNull();
  });
  it("returns null when 2+ candidates (ambiguous — shared IP, do not leak)", () => {
    expect(selectUniqueCandidate([{ id: "a" }, { id: "b" }])).toBeNull();
  });
});
