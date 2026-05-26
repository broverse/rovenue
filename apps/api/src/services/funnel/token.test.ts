import { describe, expect, it } from "vitest";
import { generateClaimToken, hashToken, safeEqualHash } from "./token";

describe("claim token", () => {
  it("generates a 43-char base64url token", () => {
    const t = generateClaimToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("each call produces a different token", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).not.toBe(b);
  });

  it("hashToken is deterministic and 64 hex chars", () => {
    const t = "abc";
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("safeEqualHash returns true for equal hashes", () => {
    const t = generateClaimToken();
    expect(safeEqualHash(hashToken(t), hashToken(t))).toBe(true);
  });

  it("safeEqualHash returns false for different hashes", () => {
    expect(safeEqualHash(hashToken("a"), hashToken("b"))).toBe(false);
  });

  it("safeEqualHash is length-tolerant (does not throw)", () => {
    expect(safeEqualHash("ab", "abcd")).toBe(false);
  });
});
