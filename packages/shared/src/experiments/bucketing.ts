import { createHash } from "node:crypto";

// =============================================================
// Deterministic bucketing for experiments and feature flags
// =============================================================
//
// Every assignment decision uses the same primitive: hash the
// subscriberId with an experiment/flag-specific seed into one of
// 10,000 buckets. 10k buckets give 0.01% precision — enough for
// a 1% canary rollout without drift.
//
// Algorithm choice: SHA-256 over the concatenation `${subId}:${seed}`,
// first 4 bytes of the digest taken as a big-endian uint32, then
// modulo BUCKET_COUNT. SHA-256 is available in Node, browsers
// (WebCrypto), iOS (CryptoKit), Android (MessageDigest) and RN
// (react-native-quick-crypto / built-in from 0.73+) without any
// custom native binding — that's the property that made us walk
// away from murmurhash and xxhash (spec §13.4). 2^32 mod 10000
// leaves a ~2.4e-6 relative bias on the last 2496 pre-image values,
// which is well below the ±5% uniformity tolerance in the test.
//
// All three helpers are stateless and side-effect free so the
// SDK, the API, and the dashboard can reach the exact same answer
// from any context.

const BUCKET_COUNT = 10_000;

/**
 * Hash `(subscriberId, seed)` to a bucket in `[0, 9999]`.
 * Same inputs always produce the same bucket — this is the
 * stickiness guarantee that keeps a user in one variant across
 * every config fetch.
 */
export function assignBucket(subscriberId: string, seed: string): number {
  const digest = createHash("sha256")
    .update(`${subscriberId}:${seed}`)
    .digest();
  // First 4 bytes as big-endian u32 → mod into the bucket space.
  // readUInt32BE on a Buffer is how Node exposes the read — it
  // returns a plain number in [0, 2^32).
  const hash = digest.readUInt32BE(0);
  return hash % BUCKET_COUNT;
}

/**
 * Pick a variant from a weighted list given a pre-computed bucket
 * in `[0, 9999]`. Weights are treated as fractions (summing to 1)
 * and mapped onto the bucket space in order. Assumes weights are
 * pre-validated upstream (see @rovenue/shared experimentSchema).
 */
export function selectVariant<T extends { weight: number }>(
  bucket: number,
  variants: readonly T[],
): T {
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight * BUCKET_COUNT;
    // Round the boundary because JS FP makes `0.34 * 10000` equal
    // `3400.0000000000005`, which would push bucket 3400 into the
    // previous slot. Boundaries must be discrete integers.
    if (bucket < Math.round(cumulative)) return variant;
  }
  // Fall through — floating-point round-off on the final variant.
  return variants[variants.length - 1]!;
}

/**
 * True if a subscriber is inside the given rollout fraction.
 * `percentage` is `0..1` (e.g. `0.1` = 10%).
 */
export function isInRollout(
  subscriberId: string,
  seed: string,
  percentage: number,
): boolean {
  if (percentage <= 0) return false;
  if (percentage >= 1) return true;
  const bucket = assignBucket(subscriberId, seed);
  return bucket < percentage * BUCKET_COUNT;
}
