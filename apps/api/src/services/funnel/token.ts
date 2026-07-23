import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../../lib/env";

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

// Domain-separated sub-key for the email hash, derived from the same
// ENCRYPTION_KEY that protects stored credentials. Deriving (rather than
// keying on ENCRYPTION_KEY directly) keeps this independent of any other
// use of that secret, and the version label lets the scheme be rotated.
// In dev/test with no key set, a fixed label keeps the hash deterministic
// and self-consistent — the write side and the read side both call this,
// so they agree within a deployment regardless.
const EMAIL_HASH_LABEL = "funnel-email-hash-v1";
function emailHashKey(): Buffer {
  const keyHex = env.ENCRYPTION_KEY;
  const root = keyHex
    ? Buffer.from(keyHex, "hex")
    : Buffer.from("rovenue-dev-funnel-email-hash");
  return createHmac("sha256", root).update(EMAIL_HASH_LABEL).digest();
}

/**
 * The hash stored in `funnel_purchases.email_hash` and
 * `funnel_claim_tokens.email_hash`, and the one
 * `POST /v1/sdk/claim-via-email` looks up by.
 *
 * A KEYED hash (HMAC), not a bare digest: the column has to stay
 * searchable, so a per-row salt is impossible — but an unkeyed SHA-256 of
 * an email is dictionary-attackable, so a leak of this column would let
 * anyone confirm "did address X buy?". Keying on a server-side secret
 * defeats the offline attack while keeping the value deterministic and
 * searchable. Changing the key or the normalisation orphans every stored
 * hash silently (the magic link just stops finding anything), so both are
 * versioned and both sides go through this one function.
 */
export function hashEmail(email: string): string {
  return createHmac("sha256", emailHashKey())
    .update(normalizeEmail(email))
    .digest("hex");
}

export function safeEqualHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
