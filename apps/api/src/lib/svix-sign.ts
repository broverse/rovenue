// =============================================================
// Svix-format webhook signing (outbound)
// =============================================================
//
// Mirrors the scheme documented and verified in ./svix-signature.ts:
//   signature = base64( HMAC-SHA256( base64decode(key-without-prefix),
//                                    `${id}.${timestampSec}.${body}` ) )
// The `webhook-signature` / `svix-signature` header carries a
// space-separated list of `v1,<base64>` candidates — one per currently
// active secret, so a rotation window can verify under either the old
// or the new key.

import { createHmac, randomBytes } from "node:crypto";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SECRET_BYTES = 24;

/** `whsec_` + base64(randomBytes(WEBHOOK_SECRET_BYTES)). */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(WEBHOOK_SECRET_BYTES).toString("base64");
}

function decodeSecretKey(secretKey: string): Buffer {
  const encoded = secretKey.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secretKey.slice(WEBHOOK_SECRET_PREFIX.length)
    : secretKey;
  return Buffer.from(encoded, "base64");
}

/**
 * Signs `body` for every key in `secretKeys` and returns the Svix-format
 * multi-signature header value: one `v1,<base64>` candidate per key,
 * space-separated.
 */
export function signWebhook(input: {
  id: string;
  timestampSec: number;
  body: string;
  secretKeys: string[];
}): string {
  const toSign = `${input.id}.${input.timestampSec}.${input.body}`;
  return input.secretKeys
    .map((secretKey) => {
      const key = decodeSecretKey(secretKey);
      const sig = createHmac("sha256", key).update(toSign).digest("base64");
      return `v1,${sig}`;
    })
    .join(" ");
}
