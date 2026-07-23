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

  // Deterministic and 64 hex chars, so it is a stable searchable key. The
  // exact bytes are NOT pinned: they depend on ENCRYPTION_KEY, and pinning
  // them would either leak the dev key or break when it is set. Changing
  // the algorithm, encoding, normalisation or key orphans every stored
  // hash silently (the magic link stops finding anything), which is why
  // both sides go through this one function and the scheme is versioned.
  it("is deterministic and 64 hex chars", () => {
    const h = hashEmail("buyer@example.com");
    expect(h).toBe(hashEmail("buyer@example.com"));
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  // A KEYED hash, not a bare digest: a leak of the column must not let an
  // attacker confirm "did address X buy?" by hashing a guess. So the value
  // is NOT the plain SHA-256 of the address.
  it("is not an unkeyed sha256 of the address (defeats offline guessing)", () => {
    expect(hashEmail("buyer@example.com")).not.toBe(
      createHash("sha256").update("buyer@example.com").digest("hex"),
    );
  });
});
