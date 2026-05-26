use std::time::Duration;

/// We never wait more than this on a server-driven Retry-After.
/// Beyond this the client should fail open with RateLimited.
pub const RETRY_AFTER_MAX: Duration = Duration::from_secs(30);

/// What to do with an HTTP attempt's outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum RetryDecision {
    /// Treat as success (e.g. 409 duplicate).
    Success,
    /// Should be retried with normal exponential backoff.
    Retryable,
    /// Should be retried only after the specified duration (server-driven).
    RetryAfter(Duration),
    /// Do not retry — surface immediately.
    Fatal,
}

/// `status = None` indicates a network-level failure (no response).
pub fn classify(status: Option<u16>, retry_after: Option<Duration>) -> RetryDecision {
    match status {
        None => RetryDecision::Retryable,
        Some(s) if (500..600).contains(&s) => RetryDecision::Retryable,
        Some(429) => match retry_after {
            Some(d) => RetryDecision::RetryAfter(d),
            None => RetryDecision::Retryable,
        },
        Some(409) => RetryDecision::Success,
        Some(s) if (400..500).contains(&s) => RetryDecision::Fatal,
        Some(_) => RetryDecision::Success,
    }
}

/// Compute backoff for attempt index (0-based). exp 1s→2s→4s…, jitter ±20%, cap 5min.
pub fn backoff(attempt: u32, rng: &mut impl rand::RngCore) -> Duration {
    use rand::Rng;
    let base = (1u64 << attempt.min(8)).saturating_mul(1000);
    let capped = base.min(5 * 60 * 1000);
    let jitter: i64 = rng.gen_range(-((capped as i64) / 5)..=((capped as i64) / 5));
    let total = (capped as i64 + jitter).max(0) as u64;
    Duration::from_millis(total)
}
