use rovenue::config::Config;
use rovenue::RovenueError;

#[test]
fn config_validates_non_empty_api_key() {
    let err = Config::new("".into(), "https://api.rovenue.io".into()).unwrap_err();
    assert!(matches!(err, RovenueError::InvalidApiKey));
}

#[test]
fn config_validates_https_base_url() {
    let err = Config::new("pk_test_abc".into(), "ftp://api".into()).unwrap_err();
    assert!(matches!(err, RovenueError::Internal));
}

#[test]
fn config_accepts_valid_inputs() {
    let cfg = Config::new("pk_test_abc".into(), "https://api.rovenue.io".into()).unwrap();
    assert_eq!(cfg.api_key, "pk_test_abc");
    assert_eq!(cfg.base_url, "https://api.rovenue.io");
    assert!(!cfg.debug);
}
