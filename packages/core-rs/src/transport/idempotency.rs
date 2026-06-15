/// An opaque key the SDK attaches via the `Idempotency-Key` header.
/// Reused across all retry attempts of the same logical call — that's how
/// the server's 24h dedup window discriminates "this is a retry" from
/// "this is a new request."
#[derive(Debug, Clone)]
pub struct IdempotencyKey(String);

/// FNV-1a 64-bit. Dependency-free, deterministic across runs of the same binary.
/// Cryptographic strength is unnecessary: a collision only affects the server's
/// 24h response cache, and DB-level dedup guarantees correctness regardless.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

impl IdempotencyKey {
    pub fn new() -> Self {
        Self(format!("idem_{}", cuid2::create_id()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Deterministic key for a receipt POST, derived from the store + receipt
    /// token. All posts of the same transaction (first send, reconcile re-post,
    /// StoreKit re-delivery) share one key, so the server replays its cached
    /// response within the 24h window instead of re-verifying with the store.
    pub fn for_receipt(store: &str, receipt: &str) -> Self {
        let mut input = String::with_capacity(store.len() + 1 + receipt.len());
        input.push_str(store);
        input.push(':');
        input.push_str(receipt);
        Self(format!("idem_rcpt_{:016x}", fnv1a_64(input.as_bytes())))
    }
}

impl Default for IdempotencyKey {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn for_receipt_is_deterministic_and_scoped() {
        let a = IdempotencyKey::for_receipt("apple", "jws-token-xyz");
        let b = IdempotencyKey::for_receipt("apple", "jws-token-xyz");
        assert_eq!(a.as_str(), b.as_str(), "same input must yield same key");

        let diff_receipt = IdempotencyKey::for_receipt("apple", "jws-token-zzz");
        assert_ne!(a.as_str(), diff_receipt.as_str());

        let diff_store = IdempotencyKey::for_receipt("google", "jws-token-xyz");
        assert_ne!(a.as_str(), diff_store.as_str());

        assert!(a.as_str().starts_with("idem_rcpt_"));
    }
}
