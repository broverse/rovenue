use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub mod redact;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Off,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

pub struct LogRecord {
    pub level: LogLevel,
    pub message: String,
    pub fields: HashMap<String, String>,
}

pub trait LogSink: Send + Sync {
    fn on_log(&self, record: LogRecord);
}

pub struct Logger {
    threshold: LogLevel,
    sink: Mutex<Option<Arc<dyn LogSink>>>,
}

impl Logger {
    pub fn new(threshold: LogLevel) -> Self {
        Self {
            threshold,
            sink: Mutex::new(None),
        }
    }

    pub fn set_sink(&self, sink: Arc<dyn LogSink>) {
        let mut guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(sink);
    }

    /// Emit means: this level is at or below the configured threshold.
    /// `Off` threshold emits nothing (lowest emittable level `Error` > `Off`).
    pub fn enabled(&self, level: LogLevel) -> bool {
        level != LogLevel::Off && level <= self.threshold
    }

    pub fn log(
        &self,
        level: LogLevel,
        message: impl FnOnce() -> String,
        fields: impl FnOnce() -> HashMap<String, String>,
    ) {
        if !self.enabled(level) {
            return;
        }
        let sink = {
            let guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(s) => s.clone(),
                None => return,
            }
        };
        let record = LogRecord {
            level,
            message: message(),
            fields: fields(),
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || sink.on_log(record)));
    }

    pub fn warn(&self, message: &str) {
        let msg = message.to_string();
        self.log(LogLevel::Warn, move || msg, HashMap::new);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Collector(Arc<Mutex<Vec<LogRecord>>>);
    impl LogSink for Collector {
        fn on_log(&self, record: LogRecord) {
            self.0.lock().unwrap().push(record);
        }
    }

    struct Panicky;
    impl LogSink for Panicky {
        fn on_log(&self, _r: LogRecord) {
            panic!("boom");
        }
    }

    #[test]
    fn below_threshold_is_not_emitted_and_closures_not_called() {
        let logger = Logger::new(LogLevel::Warn);
        let sink = Arc::new(Mutex::new(Vec::new()));
        logger.set_sink(Arc::new(Collector(sink.clone())));
        let built = Arc::new(AtomicU32::new(0));
        let b = built.clone();
        // Info is above Warn → must NOT emit, and message closure must NOT run.
        logger.log(
            LogLevel::Info,
            || {
                b.fetch_add(1, Ordering::SeqCst);
                "should not build".to_string()
            },
            HashMap::new,
        );
        assert_eq!(sink.lock().unwrap().len(), 0);
        assert_eq!(built.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn at_or_below_threshold_emits() {
        let logger = Logger::new(LogLevel::Debug);
        let sink = Arc::new(Mutex::new(Vec::new()));
        logger.set_sink(Arc::new(Collector(sink.clone())));
        logger.log(LogLevel::Error, || "err".to_string(), HashMap::new);
        logger.log(LogLevel::Debug, || "dbg".to_string(), HashMap::new);
        let got = sink.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].message, "err");
    }

    #[test]
    fn off_threshold_emits_nothing() {
        let logger = Logger::new(LogLevel::Off);
        let sink = Arc::new(Mutex::new(Vec::new()));
        logger.set_sink(Arc::new(Collector(sink.clone())));
        logger.log(LogLevel::Error, || "err".to_string(), HashMap::new);
        assert_eq!(sink.lock().unwrap().len(), 0);
    }

    #[test]
    fn no_sink_is_noop() {
        let logger = Logger::new(LogLevel::Trace);
        logger.log(LogLevel::Error, || "err".to_string(), HashMap::new); // must not panic
    }

    #[test]
    fn panicking_sink_does_not_unwind() {
        let logger = Logger::new(LogLevel::Trace);
        logger.set_sink(Arc::new(Panicky));
        logger.log(LogLevel::Error, || "err".to_string(), HashMap::new); // caught, no panic
    }
}
