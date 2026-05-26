use rovenue::error::RovenueError;

#[test]
fn not_configured_displays() {
    assert_eq!(format!("{}", RovenueError::NotConfigured), "not configured");
}

#[test]
fn invalid_api_key_displays() {
    assert_eq!(format!("{}", RovenueError::InvalidApiKey), "invalid api key");
}

#[test]
fn server_error_displays() {
    assert_eq!(format!("{}", RovenueError::ServerError), "server error");
}

#[test]
fn internal_displays() {
    assert_eq!(format!("{}", RovenueError::Internal), "internal error");
}
