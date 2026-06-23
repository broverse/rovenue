use rovenue::{ErrorKind, RovenueError};

/// Display delegates to the carried `message`, which `RovenueError::kind`
/// seeds from `ErrorKind::default_message`.
fn displays(kind: ErrorKind) -> String {
    format!("{}", RovenueError::kind(kind))
}

#[test]
fn invalid_api_key_displays() {
    assert_eq!(displays(ErrorKind::InvalidApiKey), "invalid api key");
}

#[test]
fn invalid_argument_displays() {
    assert_eq!(displays(ErrorKind::InvalidArgument), "invalid argument");
}

#[test]
fn server_error_displays() {
    assert_eq!(displays(ErrorKind::ServerError), "server error");
}

#[test]
fn internal_displays() {
    assert_eq!(displays(ErrorKind::Internal), "internal error");
}

#[test]
fn network_unavailable_displays() {
    assert_eq!(
        displays(ErrorKind::NetworkUnavailable),
        "network unavailable"
    );
}

#[test]
fn timeout_displays() {
    assert_eq!(displays(ErrorKind::Timeout), "request timed out");
}

#[test]
fn rate_limited_displays() {
    assert_eq!(displays(ErrorKind::RateLimited), "rate limited");
}

#[test]
fn storage_displays() {
    assert_eq!(displays(ErrorKind::Storage), "storage error");
}

#[test]
fn insufficient_credits_displays() {
    assert_eq!(
        displays(ErrorKind::InsufficientCredits),
        "insufficient credits"
    );
}

#[test]
fn receipt_invalid_displays() {
    assert_eq!(displays(ErrorKind::ReceiptInvalid), "receipt invalid");
}

#[test]
fn http_constructor_overrides_message_but_keeps_kind() {
    let e = RovenueError::http(
        ErrorKind::Forbidden,
        403,
        Some("FORBIDDEN".into()),
        "no access".into(),
    );
    assert_eq!(format!("{e}"), "no access");
    assert_eq!(e.kind, ErrorKind::Forbidden);
    assert_eq!(e.http_status, Some(403));
}
