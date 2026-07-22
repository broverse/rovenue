use sha2::{Digest, Sha256};

pub const BUCKET_COUNT: u32 = 10_000;

/// Deterministic bucket assignment: `sha256("{subscriber_id}:{seed}")`, first
/// 4 bytes read big-endian, mod `BUCKET_COUNT`. Must match the TS
/// implementation byte-for-byte (same hash input, same byte order, same
/// modulo) — this is the cross-language bucketing contract, verified against
/// `packages/shared/src/experiments/bucketing-vectors.json` below.
pub fn assign_bucket(subscriber_id: &str, seed: &str) -> u32 {
    let digest = Sha256::digest(format!("{subscriber_id}:{seed}").as_bytes());
    let hash = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    hash % BUCKET_COUNT
}

/// Weights are fractions summing to 1. Boundary must replicate JS
/// `Math.round` (half-away-from-zero for positives = f64::round here).
pub fn select_variant_index(bucket: u32, weights: &[f64]) -> usize {
    let mut cumulative = 0.0f64;
    for (i, w) in weights.iter().enumerate() {
        cumulative += w * BUCKET_COUNT as f64;
        if (bucket as f64) < cumulative.round() {
            return i;
        }
    }
    weights.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Cross-language bucketing contract fixture, shared verbatim with the TS
    /// implementation. Path is relative to this file:
    /// `src/placements/bucketing.rs` -> up to `packages/` -> `shared/src/...`.
    const VECTORS_JSON: &str =
        include_str!("../../../shared/src/experiments/bucketing-vectors.json");

    #[derive(Debug, Deserialize)]
    struct VectorFile {
        #[serde(rename = "bucketCount")]
        bucket_count: u32,
        cases: Vec<VectorCase>,
    }

    #[derive(Debug, Deserialize)]
    struct VectorCase {
        #[serde(rename = "subscriberId")]
        subscriber_id: String,
        seed: String,
        #[serde(rename = "expectedBucket")]
        expected_bucket: u32,
        variants: Vec<VectorVariant>,
        #[serde(rename = "expectedVariantId")]
        expected_variant_id: String,
    }

    #[derive(Debug, Deserialize)]
    struct VectorVariant {
        id: String,
        weight: f64,
    }

    #[test]
    fn matches_cross_language_bucketing_vectors() {
        let file: VectorFile = serde_json::from_str(VECTORS_JSON).expect("valid fixture json");
        assert_eq!(file.bucket_count, BUCKET_COUNT);
        assert!(!file.cases.is_empty());

        for case in &file.cases {
            let bucket = assign_bucket(&case.subscriber_id, &case.seed);
            assert_eq!(
                bucket, case.expected_bucket,
                "bucket mismatch for subscriber={:?} seed={:?}",
                case.subscriber_id, case.seed
            );

            let weights: Vec<f64> = case.variants.iter().map(|v| v.weight).collect();
            let idx = select_variant_index(bucket, &weights);
            assert_eq!(
                case.variants[idx].id, case.expected_variant_id,
                "variant mismatch for subscriber={:?} seed={:?}",
                case.subscriber_id, case.seed
            );
        }
    }
}
