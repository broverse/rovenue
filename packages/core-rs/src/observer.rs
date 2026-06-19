use std::sync::{Arc, Mutex};

/// What changed in the SDK's internal state.
///
/// Façades translate these into platform-native streams (AsyncStream / Flow / JS bus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    CreditBalanceChanged,
    RemoteConfigChanged,
}

/// Implemented by façades to receive cache-state notifications from the core.
pub trait Observer: Send + Sync {
    fn on_change(&self, event: ChangeEvent);
}

/// Holds strong `Arc` references so FFI-registered observers stay alive for the
/// bus's lifetime. The FFI boundary passes a `Box<dyn Observer>` once and never
/// holds another strong reference on the caller side, so the bus must own it.
///
/// Rust-side callers that want lifecycle control can drop the entire bus or
/// call `clear()` to release all observers at once.
#[derive(Default)]
pub struct ObserverBus {
    subs: Mutex<Vec<Arc<dyn Observer>>>,
}

impl ObserverBus {
    pub fn register(&self, obs: Arc<dyn Observer>) {
        let mut guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        guard.push(obs);
    }

    pub fn emit(&self, event: ChangeEvent) {
        let guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        for s in guard.iter() {
            s.on_change(event);
        }
    }

    /// Releases all registered observers. Primarily intended for tests and
    /// shutdown paths.
    pub fn clear(&self) {
        let mut guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
    }

    pub fn live_count(&self) -> usize {
        let guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        guard.len()
    }
}
