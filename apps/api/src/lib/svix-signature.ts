// =============================================================
// Svix webhook signature verification (hand-rolled)
// =============================================================
//
// Resend signs delivery-event webhooks with the Svix scheme:
//   expected = base64( HMAC-SHA256( key, `${svix-id}.${svix-timestamp}.${rawBody}` ) )
// where key is the base64-decoded remainder of the "whsec_…" secret.
// The `svix-signature` header carries a space-separated list of
// `v1,<base64>` candidates (key-rotation window) — any match passes.
// Mirrors lib/sns-signature.ts: small, dependency-free, throw-on-fail.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** Throws unless `rawBody` carries a valid, fresh Svix signature. */
export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now(),
): void {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new Error("missing svix headers");
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) throw new Error("invalid svix-timestamp");
  if (Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) {
    throw new Error("svix-timestamp outside tolerance");
  }

  const encoded = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) throw new Error("undecodable webhook secret");

  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest();

  for (const part of headers.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return;
    }
  }
  throw new Error("no matching svix signature");
}
