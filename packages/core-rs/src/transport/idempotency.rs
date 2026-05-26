/// An opaque key the SDK attaches via the `Idempotency-Key` header.
/// Reused across all retry attempts of the same logical call — that's how
/// the server's 24h dedup window discriminates "this is a retry" from
/// "this is a new request."
#[derive(Debug, Clone)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new() -> Self {
        Self(format!("idem_{}", cuid2::create_id()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for IdempotencyKey {
    fn default() -> Self {
        Self::new()
    }
}
