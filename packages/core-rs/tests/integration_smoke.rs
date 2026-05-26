use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::observer::{ChangeEvent, Observer};
use rovenue::{Config, RovenueCore, SDK_VERSION};

fn test_core() -> RovenueCore {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    RovenueCore::new_for_test(cfg).expect("core must construct")
}

#[test]
fn core_new_returns_handle() {
    let core = test_core();
    assert_eq!(core.get_version(), SDK_VERSION);
}

#[test]
fn core_new_rejects_invalid_config() {
    let cfg = Config::new("".into(), "https://api.rovenue.dev".into());
    assert!(
        cfg.is_err(),
        "empty api key must error before reaching core"
    );
}

#[test]
fn current_user_has_anon_id_by_default() {
    let core = test_core();
    let u = core.current_user();
    assert!(u.anon_id.starts_with("anon_"));
}

#[test]
fn identify_then_current_user_reflects_known_id() {
    let core = test_core();
    core.identify("user_42".into()).unwrap();
    assert_eq!(core.current_user().known_user_id.as_deref(), Some("user_42"));
}

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

#[test]
fn register_observer_receives_identify() {
    let core = test_core();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    core.add_observer(Arc::clone(&cap) as Arc<dyn Observer>);
    core.identify("user_42".into()).unwrap();
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::IdentityChanged));
}

#[test]
fn entitlement_returns_none_when_empty() {
    let core = test_core();
    assert!(core.entitlement("pro".into()).is_none());
    assert_eq!(core.entitlements_all().len(), 0);
}

#[test]
fn set_foreground_runs_without_panic() {
    let core = test_core();
    core.set_foreground(true);
    std::thread::sleep(Duration::from_millis(20));
    core.set_foreground(false);
    core.shutdown();
}
