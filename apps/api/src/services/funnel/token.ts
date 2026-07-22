import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function generateClaimToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * The single normalisation for an email address used as a lookup key.
 *
 * Trim, then lowercase — the rule the magic-link endpoint has always
 * applied to the address a visitor types into the SDK. It lives here so
 * the write side (the funnel payment-intent route, which hashes the
 * address at payment time) and the read side (`findByEmailHash`) cannot
 * drift apart: any disagreement — a stray space, a capital letter, a
 * salt on one side only — makes the lookup miss silently, which looks
 * exactly like the "nothing ever writes email_hash" bug it replaces.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The hash stored in `funnel_purchases.email_hash` and
 * `funnel_claim_tokens.email_hash`, and the one
 * `POST /v1/sdk/claim-via-email` looks up by. Unsalted on purpose: a
 * salt no writer could reproduce from the address alone would make the
 * column unsearchable, and searching it is its only job.
 */
export function hashEmail(email: string): string {
  return hashToken(normalizeEmail(email));
}

export function safeEqualHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
