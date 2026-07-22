import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateClaimToken,
  hashEmail,
  hashToken,
  normalizeEmail,
  safeEqualHash,
} from "./token";

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

// =============================================================
// hashEmail / normalizeEmail
// =============================================================
//
// This is a lookup key shared by two sides that never meet: the funnel
// payment-intent route writes it onto funnel_purchases, and
// POST /v1/sdk/claim-via-email reads it back through findByEmailHash.
// A disagreement between them does not fail — it just never matches,
// which is indistinguishable from the "nothing writes email_hash at all"
// bug this function exists to close. So the derivation is pinned here,
// not merely exercised.

describe("email hash", () => {
  it("normalises by trimming then lowercasing", () => {
    expect(normalizeEmail("  Buyer@Example.COM \n")).toBe("buyer@example.com");
  });

  it("gives the same hash for addresses differing only by case or padding", () => {
    const canonical = hashEmail("buyer@example.com");
    for (const variant of [
      " buyer@example.com",
      "buyer@example.com ",
      "\tbuyer@example.com\n",
      "BUYER@EXAMPLE.COM",
      "  Buyer@Example.Com  ",
    ]) {
      expect(hashEmail(variant)).toBe(canonical);
    }
  });

  it("gives different hashes for different addresses", () => {
    expect(hashEmail("buyer@example.com")).not.toBe(hashEmail("buyer2@example.com"));
  });

  // The exact bytes, pinned. Any change to the algorithm, the encoding
  // or the normalisation — including adding a salt — orphans every
  // email_hash already stored, and the only symptom would be magic links
  // quietly no longer finding anything.
  it("is an unsalted sha256 hex digest of the normalised address", () => {
    expect(hashEmail("  Buyer@Example.COM ")).toBe(
      "6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd",
    );
    expect(hashEmail("buyer@example.com")).toBe(
      createHash("sha256").update("buyer@example.com").digest("hex"),
    );
  });

  it("is exactly hashToken over the normalised address", () => {
    // Same primitive as the claim token's own hash — one function, so
    // the write side and the read side cannot drift apart.
    expect(hashEmail(" BUYER@example.com ")).toBe(hashToken("buyer@example.com"));
  });
});
