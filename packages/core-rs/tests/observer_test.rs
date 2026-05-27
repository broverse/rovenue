use std::sync::{Arc, Mutex};

use rovenue::observer::{ChangeEvent, Observer, ObserverBus};

struct Capture(Mutex<Vec<ChangeEvent>>);

impl Observer for Capture {
    fn on_change(&self, event: ChangeEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[test]
fn registered_observer_receives_events() {
    let bus = ObserverBus::default();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
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
    let cap = Arc::new(Capture(Mutex::new(vec![])));
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
    let a = Arc::new(Capture(Mutex::new(vec![])));
    let b = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&a) as Arc<dyn Observer>);
    bus.register(Arc::clone(&b) as Arc<dyn Observer>);
    bus.emit(ChangeEvent::EntitlementsChanged);
    assert_eq!(a.0.lock().unwrap().len(), 1);
    assert_eq!(b.0.lock().unwrap().len(), 1);
}
