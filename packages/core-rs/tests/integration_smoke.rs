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
    assert!(u.rovenue_id.starts_with("rov_"));
}

#[test]
fn identify_then_current_user_reflects_known_id() {
    let core = test_core();
    core.identify("user_42".into()).unwrap();
    assert_eq!(
        core.current_user().app_user_id.as_deref(),
        Some("user_42")
    );
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

/// FFI path: `register_observer(Box<dyn Observer>)` is what UniFFI generates for
/// callback-interface registration. The caller (Swift/Kotlin/JS façade) has no
/// way to keep a Rust Arc alive, so the core must own a strong reference.
/// Regression test: prior to the fix the bus stored `Weak<dyn Observer>`, the
/// Arc created inside `register_observer` was immediately dropped, and FFI
/// callbacks silently never fired.
#[test]
fn ffi_register_observer_keeps_observer_alive_and_emits() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counter(AtomicUsize);
    impl Observer for Counter {
        fn on_change(&self, _e: ChangeEvent) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    let core = test_core();
    // Use a separate Arc so we can inspect the count after registration —
    // but pass the FFI Box<dyn Observer> path, not the Arc-flavored add_observer.
    let counter = Arc::new(Counter(AtomicUsize::new(0)));
    let counter_for_box: Arc<Counter> = Arc::clone(&counter);
    // Box the trait object exactly as UniFFI does. We deliberately move the
    // strong reference into the Box and rely on the bus to own it after this
    // call returns.
    let boxed: Box<dyn Observer> = Box::new(BoxedRelay(counter_for_box));
    core.register_observer(boxed);

    // Trigger an emit through the public surface.
    core.identify("user_ffi".into()).unwrap();

    assert!(
        counter.0.load(Ordering::SeqCst) >= 1,
        "FFI-registered observer must receive at least one event"
    );
}

/// Relays Observer calls into an inner Arc so the test can both pass a Box to
/// the FFI surface AND retain a reference to inspect the result afterwards.
struct BoxedRelay(Arc<dyn Observer>);
impl Observer for BoxedRelay {
    fn on_change(&self, e: ChangeEvent) {
        self.0.on_change(e);
    }
}

#[test]
fn log_out_resets_identity_and_clears_scope_bound_caches() {
    use rovenue::sessions::SessionEventKind;

    let core = test_core();
    let before = core.current_user().rovenue_id;

    // Seed scope-bound state: an app account token and a buffered session event.
    core.get_or_create_app_account_token().unwrap();
    core.record_session_event(SessionEventKind::Open, "2026-06-15T10:00:00Z".into(), None)
        .unwrap();
    core.identify("user_1".into()).unwrap();

    assert!(core.test_app_account_token_count() > 0);
    assert!(core.test_session_event_count() > 0);

    core.log_out().unwrap();

    let after = core.current_user();
    assert_ne!(after.rovenue_id, before);
    assert!(after.rovenue_id.starts_with("rov_"));
    assert_eq!(after.app_user_id, None);
    assert_eq!(core.test_app_account_token_count(), 0);
    assert_eq!(core.test_session_event_count(), 0);
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

#[test]
fn credit_balance_starts_zero() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new_for_test(cfg).unwrap();
    assert_eq!(core.credit_balance(), 0);
}

#[test]
fn consume_credits_rejects_zero_or_negative() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new_for_test(cfg).unwrap();
    assert!(matches!(
        core.consume_credits(0, None),
        Err(rovenue::RovenueError::Internal)
    ));
    assert!(matches!(
        core.consume_credits(-5, None),
        Err(rovenue::RovenueError::Internal)
    ));
}
