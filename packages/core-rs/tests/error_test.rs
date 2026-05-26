use rovenue::error::RovenueError;

#[test]
fn not_configured_displays() {
    assert_eq!(format!("{}", RovenueError::NotConfigured), "not configured");
}

#[test]
fn invalid_api_key_displays() {
    assert_eq!(
        format!("{}", RovenueError::InvalidApiKey),
        "invalid api key"
    );
}

#[test]
fn server_error_displays() {
    assert_eq!(format!("{}", RovenueError::ServerError), "server error");
}

#[test]
fn internal_displays() {
    assert_eq!(format!("{}", RovenueError::Internal), "internal error");
}

#[test]
fn network_unavailable_displays() {
    assert_eq!(format!("{}", RovenueError::NetworkUnavailable), "network unavailable");
}

#[test]
fn timeout_displays() {
    assert_eq!(format!("{}", RovenueError::Timeout), "timeout");
}

#[test]
fn rate_limited_displays() {
    assert_eq!(format!("{}", RovenueError::RateLimited), "rate limited");
}

#[test]
fn storage_displays() {
    assert_eq!(format!("{}", RovenueError::Storage), "storage error");
}
