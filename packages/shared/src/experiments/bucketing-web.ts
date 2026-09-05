// =============================================================
// Browser-safe bucketing
// =============================================================
//
// `assignBucket` in ./bucketing hashes with `node:crypto`, which does not
// exist in a browser. That module's own comment explains SHA-256 was chosen
// precisely BECAUSE every target has it — Node, WebCrypto, CryptoKit,
// MessageDigest — so the algorithm was already portable and only the import
// was not.
//
// This is the WebCrypto spelling of the identical computation: SHA-256 over
// `${subscriberId}:${seed}`, first four bytes as a big-endian uint32, modulo
// the same bucket space. It is verified against the same
// `bucketing-vectors.json` the Node and Rust implementations are checked
// against, so a divergence fails a test rather than silently putting a
// browser user in a different variant from the same user on their phone.
//
// It is async because WebCrypto's digest is. That is the only difference a
// caller sees.

const BUCKET_COUNT = 10_000;

/**
 * Hash `(subscriberId, seed)` to a bucket in `[0, 9999]` using WebCrypto.
 *
 * Byte-for-byte the same answer as `assignBucket`, which is the whole point:
 * a user's variant must not change because they opened the web app instead
 * of the native one.
 */
export async function assignBucketWeb(
  subscriberId: string,
  seed: string,
): Promise<number> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Every browser that supports the SDK's baseline has WebCrypto on a
    // secure origin. It is absent on plain http, which is worth saying out
    // loud rather than silently bucketing everyone to variant one.
    throw new Error(
      "[rovenue] WebCrypto is unavailable. Experiment assignment needs " +
        "crypto.subtle, which browsers expose only on secure origins " +
        "(https, or http://localhost).",
    );
  }
  const bytes = new TextEncoder().encode(`${subscriberId}:${seed}`);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  // First 4 bytes, big-endian, exactly as the Node implementation's
  // readUInt32BE does.
  const hash =
    ((digest[0]! << 24) >>> 0) +
    (digest[1]! << 16) +
    (digest[2]! << 8) +
    digest[3]!;
  return (hash >>> 0) % BUCKET_COUNT;
}

// Re-exported so a browser consumer needs one import for both halves of an
// assignment, and gets the SAME selection rule the server and the native
// SDKs use rather than a copy.
export { selectVariant } from "./bucketing-select";
