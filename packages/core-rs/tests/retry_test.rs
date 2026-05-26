use std::time::Duration;

use rovenue::transport::retry::{classify, RetryDecision};

#[test]
fn five_hundreds_are_retryable() {
    let d = classify(Some(503), None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn forbidden_is_fatal() {
    let d = classify(Some(403), None);
    assert!(matches!(d, RetryDecision::Fatal));
}

#[test]
fn rate_limited_honors_retry_after() {
    let d = classify(Some(429), Some(Duration::from_secs(5)));
    assert!(matches!(d, RetryDecision::RetryAfter(_)));
    if let RetryDecision::RetryAfter(d) = d {
        assert_eq!(d, Duration::from_secs(5));
    }
}

#[test]
fn rate_limited_without_header_is_retryable_with_default() {
    let d = classify(Some(429), None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn network_failure_is_retryable() {
    let d = classify(None, None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn conflict_is_success() {
    let d = classify(Some(409), None);
    assert!(matches!(d, RetryDecision::Success));
}
