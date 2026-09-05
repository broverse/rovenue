// =============================================================
// Weighted variant selection
// =============================================================
//
// Split out from ./bucketing so it can be imported without that module's
// `node:crypto` dependency. The selection rule is pure arithmetic; only the
// hashing needs a platform primitive, and the Web SDK supplies its own.
//
// One implementation, two importers. Two copies of a boundary-rounding rule
// is precisely the kind of duplication that drifts by one bucket and puts a
// user in a different variant depending on which surface they opened.

const BUCKET_COUNT = 10_000;

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


