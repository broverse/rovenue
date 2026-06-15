use std::sync::{Arc, Mutex};

use rovenue::cache::CacheStore;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

fn fresh() -> (Arc<CacheStore>, Arc<ObserverBus>, IdentityManager) {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let mgr = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    (store, bus, mgr)
}

#[test]
fn first_load_generates_anon_id() {
    let (_, _, mgr) = fresh();
    let u = mgr.current_user();
    assert!(u.rovenue_id.starts_with("rov_"));
    assert!(u.app_user_id.is_none());
}

#[test]
fn anon_id_persists_across_open() {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let mgr1 = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    let first = mgr1.current_user().rovenue_id.clone();
    let mgr2 = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    assert_eq!(mgr2.current_user().rovenue_id, first);
}

#[test]
fn identify_sets_known_id_and_emits() {
    let (_, bus, mgr) = fresh();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    mgr.identify("user_42".into()).unwrap();
    let u = mgr.current_user();
    assert_eq!(u.app_user_id.as_deref(), Some("user_42"));
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::IdentityChanged));
}

#[test]
fn identify_is_idempotent_for_same_known_id() {
    let (_, bus, mgr) = fresh();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    mgr.identify("user_42".into()).unwrap();
    mgr.identify("user_42".into()).unwrap();
    let n = cap
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == ChangeEvent::IdentityChanged)
        .count();
    assert_eq!(n, 1, "second identify with same id should not re-emit");
}

#[test]
fn log_out_mints_new_rovenue_id_and_clears_app_user_id_and_emits() {
    let (_, bus, mgr) = fresh();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let before = mgr.current_user().rovenue_id;
    mgr.identify("user_1".into()).unwrap();
    mgr.log_out().unwrap();
    let after = mgr.current_user();
    assert_ne!(after.rovenue_id, before);
    assert!(after.rovenue_id.starts_with("rov_"));
    assert_eq!(after.app_user_id, None);
    assert!(cap
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, ChangeEvent::IdentityChanged)));
}

#[test]
fn current_user_returns_known_id_for_scope_when_present() {
    let (_, _, mgr) = fresh();
    let scope_before = mgr.current_user_scope();
    mgr.identify("user_42".into()).unwrap();
    let scope_after = mgr.current_user_scope();
    assert_ne!(scope_before, scope_after);
    assert_eq!(scope_after, "user_42");
}
