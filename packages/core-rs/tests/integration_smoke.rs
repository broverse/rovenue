use rovenue::{Config, RovenueCore, SDK_VERSION};

#[test]
fn core_new_returns_handle() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).expect("core must construct");
    assert_eq!(core.get_version(), SDK_VERSION);
}

#[test]
fn core_new_rejects_invalid_config() {
    let cfg = Config::new("".into(), "https://api.rovenue.dev".into());
    assert!(cfg.is_err(), "empty api key must error before reaching core");
}
