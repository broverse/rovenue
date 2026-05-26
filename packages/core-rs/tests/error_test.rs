use rovenue::error::RovenueError;

#[test]
fn not_configured_displays() {
    let e = RovenueError::NotConfigured;
    assert_eq!(format!("{e}"), "not configured");
}

#[test]
fn invalid_api_key_displays() {
    let e = RovenueError::InvalidApiKey;
    assert_eq!(format!("{e}"), "invalid api key");
}

#[test]
fn server_error_includes_status_and_message() {
    let e = RovenueError::ServerError {
        status: 503,
        message: "upstream down".into(),
    };
    let s = format!("{e}");
    assert!(s.contains("503"), "got {s}");
    assert!(s.contains("upstream down"), "got {s}");
}
