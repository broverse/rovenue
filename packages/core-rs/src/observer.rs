use crate::logging::Logger;
use std::sync::{Arc, Mutex};

/// What changed in the SDK's internal state.
///
/// Façades translate these into platform-native streams (AsyncStream / Flow / JS bus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    VirtualCurrenciesChanged,
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
    logger: Mutex<Option<Arc<Logger>>>,
}

impl ObserverBus {
    pub fn with_logger(self, logger: Arc<Logger>) -> Self {
        *self.logger.lock().unwrap_or_else(|e| e.into_inner()) = Some(logger);
        self
    }

    pub fn register(&self, obs: Arc<dyn Observer>) {
        let mut guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        guard.push(obs);
    }

    pub fn emit(&self, event: ChangeEvent) {
        let guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        for s in guard.iter() {
            let s = s.clone();
            let ev = event;
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || s.on_change(ev)))
                .is_err()
            {
                if let Some(l) = self
                    .logger
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                {
                    l.warn("observer.on_change panicked; skipping");
                }
            }
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

#[cfg(test)]
mod panic_tests {
    use super::*;
    use crate::logging::{LogLevel, LogRecord, LogSink, Logger};
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };

    struct Panicky;
    impl Observer for Panicky {
        fn on_change(&self, _e: ChangeEvent) {
            panic!("boom");
        }
    }

    struct Counter(Arc<AtomicU32>);
    impl Observer for Counter {
        fn on_change(&self, _e: ChangeEvent) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Collector(Arc<std::sync::Mutex<Vec<LogRecord>>>);
    impl LogSink for Collector {
        fn on_log(&self, r: LogRecord) {
            self.0.lock().unwrap().push(r);
        }
    }

    #[test]
    fn a_panicking_observer_does_not_abort_dispatch() {
        let bus = ObserverBus::default();
        let hits = Arc::new(AtomicU32::new(0));
        bus.register(Arc::new(Panicky));
        bus.register(Arc::new(Counter(hits.clone())));
        bus.emit(ChangeEvent::EntitlementsChanged); // must not unwind; Counter must still run
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn observer_panic_is_logged_as_warn_not_eprintln() {
        let recs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let logger = Arc::new(Logger::new(LogLevel::Warn));
        logger.set_sink(Arc::new(Collector(recs.clone())));
        let bus = ObserverBus::default().with_logger(logger);
        bus.register(Arc::new(Panicky));
        bus.emit(ChangeEvent::EntitlementsChanged);
        let got = recs.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].level, LogLevel::Warn);
        assert!(got[0].message.contains("observer.on_change panicked"));
    }
}
