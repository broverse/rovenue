use rovenue::config::{resolve_base_url, Config, DEFAULT_BASE_URL};
use rovenue::ErrorKind;

#[test]
fn config_validates_non_empty_api_key() {
    let err = Config::new("".into(), "https://api.rovenue.io".into()).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidApiKey);
}

#[test]
fn blank_base_url_falls_back_to_default() {
    assert_eq!(resolve_base_url("").unwrap(), DEFAULT_BASE_URL);
    assert_eq!(resolve_base_url("   ").unwrap(), DEFAULT_BASE_URL);
    let cfg = Config::new("pk_test_abc".into(), "".into()).unwrap();
    assert_eq!(cfg.base_url, "https://api.rovenue.io");
}

#[test]
fn https_base_url_is_accepted() {
    assert_eq!(
        resolve_base_url("https://self.hosted.example.com").unwrap(),
        "https://self.hosted.example.com"
    );
}

#[test]
fn plain_http_base_url_is_rejected() {
    let err = resolve_base_url("http://self.hosted.example.com").unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidArgument);
}

#[test]
fn non_http_scheme_is_rejected() {
    let err = resolve_base_url("ftp://api").unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidArgument);
}

#[test]
fn http_localhost_is_allowed() {
    assert!(resolve_base_url("http://localhost:3000").is_ok());
    assert!(resolve_base_url("http://127.0.0.1:3000/v1").is_ok());
    assert!(resolve_base_url("http://[::1]:3000").is_ok());
    assert!(resolve_base_url("http://[::1]").is_ok());
    assert!(resolve_base_url("http://localhostevil.com").is_err());
}

#[test]
fn http_non_loopback_127_address_is_rejected() {
    // 127.0.0.100 is NOT loopback-localhost; must not slip through the http gate.
    assert!(resolve_base_url("http://127.0.0.100:3000").is_err());
}

#[test]
fn udl_default_matches_const() {
    // If this literal changes, update the `base_url` default in librovenue.udl too.
    assert_eq!(DEFAULT_BASE_URL, "https://api.rovenue.io");
}

#[test]
fn config_accepts_valid_inputs() {
    let cfg = Config::new("pk_test_abc".into(), "https://api.rovenue.io".into()).unwrap();
    assert_eq!(cfg.api_key, "pk_test_abc");
    assert_eq!(cfg.base_url, "https://api.rovenue.io");
    assert_eq!(cfg.log_level, rovenue::logging::LogLevel::Warn);
}
