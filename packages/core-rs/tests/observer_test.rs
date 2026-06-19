use std::sync::{Arc, Mutex};

use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::{Config, RovenueCore};

struct Capture(Arc<Mutex<Vec<ChangeEvent>>>);

impl Observer for Capture {
    fn on_change(&self, event: ChangeEvent) {
        self.0.lock().unwrap().push(event);
    }
}

/// Builds an in-memory core pointed at `base_url` with a recording observer
/// attached, returning the shared event log for assertions.
fn test_core_recording_events(base_url: &str) -> (RovenueCore, Arc<Mutex<Vec<ChangeEvent>>>) {
    let cfg = Config::new("pk_test_obs".into(), base_url.to_string()).unwrap();
    let core = RovenueCore::new_for_test(cfg).unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    core.add_observer(Arc::new(Capture(Arc::clone(&events))) as Arc<dyn Observer>);
    (core, events)
}

#[test]
fn registered_observer_receives_events() {
    let bus = ObserverBus::default();
    let cap = Arc::new(Capture(Arc::new(Mutex::new(vec![]))));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    bus.emit(ChangeEvent::EntitlementsChanged);
    bus.emit(ChangeEvent::IdentityChanged);
    let seen = cap.0.lock().unwrap().clone();
    assert_eq!(
        seen,
        vec![
            ChangeEvent::EntitlementsChanged,
            ChangeEvent::IdentityChanged
        ]
    );
}

#[test]
fn bus_keeps_observer_alive_after_caller_drops_arc() {
    // The bus holds a strong Arc so that FFI registrations (which never keep
    // their own strong reference on the caller side) stay live and continue
    // to receive callbacks. Verify by dropping the caller's Arc and confirming
    // the bus still delivers events.
    let bus = ObserverBus::default();
    let cap = Arc::new(Capture(Arc::new(Mutex::new(vec![]))));
    let weak = Arc::downgrade(&cap);
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    drop(cap); // caller releases its Arc
    assert!(
        weak.upgrade().is_some(),
        "bus must keep observer alive after caller drop"
    );
    bus.emit(ChangeEvent::EntitlementsChanged);
    let alive = weak.upgrade().expect("observer still alive");
    assert_eq!(alive.0.lock().unwrap().len(), 1);
    assert_eq!(bus.live_count(), 1);

    // Explicit clear releases the strong references.
    bus.clear();
    drop(alive);
    assert!(weak.upgrade().is_none());
    assert_eq!(bus.live_count(), 0);
}

#[test]
fn multiple_observers_all_called() {
    let bus = ObserverBus::default();
    let a = Arc::new(Capture(Arc::new(Mutex::new(vec![]))));
    let b = Arc::new(Capture(Arc::new(Mutex::new(vec![]))));
    bus.register(Arc::clone(&a) as Arc<dyn Observer>);
    bus.register(Arc::clone(&b) as Arc<dyn Observer>);
    bus.emit(ChangeEvent::EntitlementsChanged);
    assert_eq!(a.0.lock().unwrap().len(), 1);
    assert_eq!(b.0.lock().unwrap().len(), 1);
}

#[test]
fn refresh_virtual_currencies_emits_virtual_currencies_changed() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_body(r#"{"data":{"balances":{"gold":1}}}"#)
        .create();
    let (core, events) = test_core_recording_events(&server.url());
    core.refresh_virtual_currencies().unwrap();
    assert!(events
        .lock()
        .unwrap()
        .contains(&ChangeEvent::VirtualCurrenciesChanged));
}
