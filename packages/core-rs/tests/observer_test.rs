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
    assert_eq!(seen, vec![ChangeEvent::EntitlementsChanged, ChangeEvent::IdentityChanged]);
}

#[test]
fn dropped_observer_is_garbage_collected() {
    let bus = ObserverBus::default();
    {
        let cap = Arc::new(Capture(Mutex::new(vec![])));
        bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
        // cap is dropped here
    }
    // After the Arc is dropped, the bus should hold a dead Weak<>.
    bus.emit(ChangeEvent::EntitlementsChanged);
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
