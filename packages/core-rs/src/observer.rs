use std::sync::{Arc, Mutex, Weak};

/// What changed in the SDK's internal state.
///
/// Façades translate these into platform-native streams (AsyncStream / Flow / JS bus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    CreditBalanceChanged,
}

/// Implemented by façades to receive cache-state notifications from the core.
pub trait Observer: Send + Sync {
    fn on_change(&self, event: ChangeEvent);
}

/// Holds `Weak` references so dropping an observer on the façade side
/// naturally GCs it without a separate unregister call.
#[derive(Default)]
pub struct ObserverBus {
    subs: Mutex<Vec<Weak<dyn Observer>>>,
}

impl ObserverBus {
    pub fn register(&self, obs: Arc<dyn Observer>) {
        let mut guard = self.subs.lock().expect("observer bus poisoned");
        guard.push(Arc::downgrade(&obs));
    }

    pub fn emit(&self, event: ChangeEvent) {
        let mut guard = self.subs.lock().expect("observer bus poisoned");
        guard.retain(|w| {
            if let Some(s) = w.upgrade() {
                s.on_change(event);
                true
            } else {
                false
            }
        });
    }

    pub fn live_count(&self) -> usize {
        let mut guard = self.subs.lock().expect("observer bus poisoned");
        guard.retain(|w| w.strong_count() > 0);
        guard.len()
    }
}
