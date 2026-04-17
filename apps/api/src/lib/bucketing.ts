import murmurhash from "murmurhash-js";

// =============================================================
// Deterministic bucketing for experiments and feature flags
// =============================================================
//
// Every assignment decision uses the same primitive: hash the
// subscriberId with an experiment/flag-specific seed into one of
// 10,000 buckets. 10k buckets give 0.01% precision — enough for
// a 1% canary rollout without drift.
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
  const hash = murmurhash.murmur3(`${subscriberId}:${seed}`);
  // murmur3 returns a 32-bit unsigned int; mod into our bucket space.
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
