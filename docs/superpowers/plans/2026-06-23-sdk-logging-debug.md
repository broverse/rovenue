# SDK Unified Logging & Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rust core the sole authority for SDK logging — a `LogLevel`-thresholded, redacted log stream delivered to native façades over a new FFI `LogSink` callback, replacing the dead `config.debug` flag and the disconnected façade-only `emit()` logs.

**Architecture:** A self-contained `logging` module in `core-rs` (no `log`/`tracing` crate) owns a `Logger` held by `RovenueCore`. The `Logger` filters by threshold (records below threshold are never built), redacts sensitive fields, and forwards `LogRecord`s to a registered `LogSink` (panic-guarded, mirroring `ObserverBus`). The UDL exposes `LogLevel`, `LogRecord`, `LogSink`, and `register_log_sink`. Each façade registers a `LogSink` bridge that maps `LogRecord` → its existing `LogEntry` and fans out to handlers registered via the unchanged `setLogHandler` API. Façade-internal `emit()` operation logs are deleted; core logs operations and network activity.

**Tech Stack:** Rust (core, `cargo test`), UniFFI (FFI bindings via `npm run sdk:bindings`), Swift (`RovenueTests`), Kotlin (`testDebugUnitTest`), React Native / TypeScript (Vitest).

## Global Constraints

- **No backward compatibility** — SDK not yet published; `debug` is removed (not deprecated) from config and all `configure(...)` signatures.
- **No new logging crate** — no `log` / `tracing` / `env_logger` / `slog`; the logging layer is hand-rolled in `core-rs/src/logging/`.
- **No wall-clock / RNG in core for ids** — correlation ids use a monotonic counter, never `Date.now()` / `Math.random()` / system time (breaks determinism + some runtimes).
- **Redaction is mandatory** — `Authorization` header is never logged; known sensitive field names (`token`, `receipt`, `email`, `app_user_id`, JWS/signature) are masked. Both network traces and error messages pass through `redact()`.
- **Lazy emission** — records below the configured threshold must not be constructed (no string formatting cost).
- **Panic safety** — `LogSink.on_log` is wrapped in `catch_unwind` in core, exactly like `ObserverBus::emit` (`observer.rs:41`).
- **Generated bindings are gitignored** — regenerate via `npm run sdk:bindings`; never hand-edit `Generated/RovenueFFI.swift` or `generated/librovenue.kt`.
- IDs are cuid2/UUID elsewhere; timestamps UTC. Conventional commits.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `core-rs/src/logging/mod.rs` (new) | `LogLevel`, `LogRecord`, `LogSink` trait, `Logger` (threshold, sink registration, lazy emit, panic guard) |
| `core-rs/src/logging/redact.rs` (new) | `redact_message(&str) -> String`, `redact_fields(BTreeMap) -> BTreeMap` |
| `core-rs/src/lib.rs` (modify) | `pub mod logging;` |
| `core-rs/src/config.rs` (modify) | remove `debug`, add `log_level: LogLevel` |
| `core-rs/src/observer.rs` (modify) | `ObserverBus` gets optional `Arc<Logger>`; replace `eprintln!` with `logger.warn` |
| `core-rs/src/funnel/mod.rs` (modify) | replace `eprintln!` with logger call |
| `core-rs/src/api.rs` (modify) | `RovenueCore` holds `Arc<Logger>`; `register_log_sink`; operation logs; thread logger into `HttpClient` |
| `core-rs/src/transport/http_client.rs` (modify) | `with_logger`; network metadata + error trace (redacted, correlation id) |
| `core-rs/src/librovenue.udl` (modify) | `LogLevel`, `LogRecord`, `LogSink`, `register_log_sink`, `Config.log_level` (remove `debug`) |
| `sdk-swift/Sources/Rovenue/Rovenue.swift` (modify) | `LogSinkBridge`, register in `configure`, remove `emit()` call sites, `logLevel` param |
| `sdk-kotlin/.../Rovenue.kt` (modify) | same as Swift |
| `sdk-rn/src/api/configure.ts`, `src/api/log.ts`, `src/specs/RovenueModule.types.ts`, `src/__tests__/log.test.ts` (modify) | `logLevel`, `LogRecord` fields on `onLog`, redaction test |

---

## Task 1: Core logging primitives (`LogLevel`, `LogRecord`, `LogSink`, `Logger`)

**Files:**
- Create: `packages/core-rs/src/logging/mod.rs`
- Modify: `packages/core-rs/src/lib.rs` (add `pub mod logging;`)
- Test: inline `#[cfg(test)]` in `logging/mod.rs`

**Interfaces:**
- Produces:
  - `pub enum LogLevel { Off, Error, Warn, Info, Debug, Trace }` (derives `Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord`)
  - `pub struct LogRecord { pub level: LogLevel, pub message: String, pub fields: BTreeMap<String, String> }`
  - `pub trait LogSink: Send + Sync { fn on_log(&self, record: LogRecord); }`
  - `pub struct Logger` with:
    - `pub fn new(threshold: LogLevel) -> Self`
    - `pub fn set_sink(&self, sink: Arc<dyn LogSink>)`
    - `pub fn enabled(&self, level: LogLevel) -> bool`
    - `pub fn log(&self, level: LogLevel, message: impl FnOnce() -> String, fields: impl FnOnce() -> BTreeMap<String, String>)`
    - convenience: `pub fn warn(&self, message: &str)`

**Ordering note:** `LogLevel::Off` must be the lowest and `Trace` the highest, so `level <= threshold` means "emit". With `Off` as threshold, nothing emits (since the lowest emittable level is `Error`, and `Error > Off`).

- [ ] **Step 1: Write the failing test**

In `packages/core-rs/src/logging/mod.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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
    pub fields: BTreeMap<String, String>,
}

pub trait LogSink: Send + Sync {
    fn on_log(&self, record: LogRecord);
}

pub struct Logger {
    threshold: LogLevel,
    sink: Mutex<Option<Arc<dyn LogSink>>>,
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
            BTreeMap::new,
        );
        assert_eq!(sink.lock().unwrap().len(), 0);
        assert_eq!(built.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn at_or_below_threshold_emits() {
        let logger = Logger::new(LogLevel::Debug);
        let sink = Arc::new(Mutex::new(Vec::new()));
        logger.set_sink(Arc::new(Collector(sink.clone())));
        logger.log(LogLevel::Error, || "err".to_string(), BTreeMap::new);
        logger.log(LogLevel::Debug, || "dbg".to_string(), BTreeMap::new);
        let got = sink.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].message, "err");
    }

    #[test]
    fn off_threshold_emits_nothing() {
        let logger = Logger::new(LogLevel::Off);
        let sink = Arc::new(Mutex::new(Vec::new()));
        logger.set_sink(Arc::new(Collector(sink.clone())));
        logger.log(LogLevel::Error, || "err".to_string(), BTreeMap::new);
        assert_eq!(sink.lock().unwrap().len(), 0);
    }

    #[test]
    fn no_sink_is_noop() {
        let logger = Logger::new(LogLevel::Trace);
        logger.log(LogLevel::Error, || "err".to_string(), BTreeMap::new); // must not panic
    }

    #[test]
    fn panicking_sink_does_not_unwind() {
        let logger = Logger::new(LogLevel::Trace);
        logger.set_sink(Arc::new(Panicky));
        logger.log(LogLevel::Error, || "err".to_string(), BTreeMap::new); // caught, no panic
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test logging::tests 2>&1 | tail -20`
Expected: FAIL — `Logger::new`, `set_sink`, `log` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core-rs/src/logging/mod.rs` (above the `#[cfg(test)]` block):

```rust
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
        fields: impl FnOnce() -> BTreeMap<String, String>,
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
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            sink.on_log(record)
        }));
    }

    pub fn warn(&self, message: &str) {
        let msg = message.to_string();
        self.log(LogLevel::Warn, move || msg, BTreeMap::new);
    }
}
```

Add to `packages/core-rs/src/lib.rs` (with the other `pub mod` declarations):

```rust
pub mod logging;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test logging::tests 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/logging/mod.rs packages/core-rs/src/lib.rs
git commit -m "feat(sdk-core): logging primitives — LogLevel, LogRecord, LogSink, Logger"
```

---

## Task 2: Redaction helper

**Files:**
- Create: `packages/core-rs/src/logging/redact.rs`
- Modify: `packages/core-rs/src/logging/mod.rs` (add `pub mod redact;`)
- Test: inline `#[cfg(test)]` in `redact.rs`

**Interfaces:**
- Consumes: nothing from prior tasks (pure functions)
- Produces:
  - `pub fn redact_message(input: &str) -> String`
  - `pub fn redact_fields(fields: BTreeMap<String, String>) -> BTreeMap<String, String>`

**Behavior:** `redact_fields` replaces the value of any key whose lowercased name contains a sensitive token (`token`, `receipt`, `email`, `app_user_id`, `authorization`, `signature`, `jws`, `password`, `secret`) with `"[redacted]"`. `redact_message` masks `Bearer <...>` substrings and anything that looks like an email address.

- [ ] **Step 1: Write the failing test**

In `packages/core-rs/src/logging/redact.rs`:

```rust
use std::collections::BTreeMap;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_with_sensitive_keys_are_masked() {
        let mut f = BTreeMap::new();
        f.insert("status".to_string(), "401".to_string());
        f.insert("authorization".to_string(), "Bearer pk_live_abc".to_string());
        f.insert("app_user_id".to_string(), "user_42".to_string());
        f.insert("receipt_data".to_string(), "MIIxyz".to_string());
        let out = redact_fields(f);
        assert_eq!(out.get("status").unwrap(), "401");
        assert_eq!(out.get("authorization").unwrap(), "[redacted]");
        assert_eq!(out.get("app_user_id").unwrap(), "[redacted]");
        assert_eq!(out.get("receipt_data").unwrap(), "[redacted]");
    }

    #[test]
    fn message_masks_bearer_and_email() {
        let m = redact_message("auth Bearer pk_live_secret failed for jane@example.com");
        assert!(!m.contains("pk_live_secret"), "bearer token leaked: {m}");
        assert!(!m.contains("jane@example.com"), "email leaked: {m}");
        assert!(m.contains("[redacted]"));
    }

    #[test]
    fn clean_message_is_unchanged() {
        assert_eq!(redact_message("request timed out after 3 attempts"), "request timed out after 3 attempts");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test logging::redact 2>&1 | tail -20`
Expected: FAIL — `redact_fields` / `redact_message` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core-rs/src/logging/redact.rs` (above the test module):

```rust
const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "token", "receipt", "email", "app_user_id", "authorization",
    "signature", "jws", "password", "secret",
];

pub fn redact_fields(fields: BTreeMap<String, String>) -> BTreeMap<String, String> {
    fields
        .into_iter()
        .map(|(k, v)| {
            let lk = k.to_lowercase();
            if SENSITIVE_KEY_TOKENS.iter().any(|t| lk.contains(t)) {
                (k, "[redacted]".to_string())
            } else {
                (k, v)
            }
        })
        .collect()
}

pub fn redact_message(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for word in input.split_whitespace() {
        if word.contains('@') && word.contains('.') {
            out.push("[redacted]".to_string());
        } else {
            out.push(word.to_string());
        }
    }
    let joined = out.join(" ");
    // Collapse `Bearer <token>` → `Bearer [redacted]`.
    redact_bearer(&joined)
}

fn redact_bearer(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut tokens = s.split(' ').peekable();
    while let Some(tok) = tokens.next() {
        result.push_str(tok);
        if tok == "Bearer" {
            if tokens.next().is_some() {
                result.push_str(" [redacted]");
            }
        }
        if tokens.peek().is_some() {
            result.push(' ');
        }
    }
    result
}
```

Add to `packages/core-rs/src/logging/mod.rs` (top, after the `use` lines):

```rust
pub mod redact;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test logging::redact 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/logging/redact.rs packages/core-rs/src/logging/mod.rs
git commit -m "feat(sdk-core): single-point log redaction for fields + messages"
```

---

## Task 3: Config swap + RovenueCore wiring + replace `eprintln!`

**Files:**
- Modify: `packages/core-rs/src/config.rs` (remove `debug`, add `log_level`)
- Modify: `packages/core-rs/src/observer.rs` (`ObserverBus` optional logger; replace `eprintln!`)
- Modify: `packages/core-rs/src/funnel/mod.rs` (replace `eprintln!`)
- Modify: `packages/core-rs/src/api.rs` (`RovenueCore.logger: Arc<Logger>`; `register_log_sink`; build logger from `config.log_level`; pass logger to `ObserverBus`)
- Test: inline tests in `observer.rs` + a new test in `api.rs`

**Interfaces:**
- Consumes: `LogLevel`, `LogRecord`, `LogSink`, `Logger` (Task 1)
- Produces:
  - `Config.log_level: LogLevel` (default `LogLevel::Warn`)
  - `RovenueCore::register_log_sink(&self, sink: Box<dyn LogSink>)`
  - `RovenueCore.logger: Arc<Logger>` (internal, used by Tasks 4–5)
  - `ObserverBus::with_logger(self, logger: Arc<Logger>) -> Self`

- [ ] **Step 1: Write the failing test**

In `packages/core-rs/src/observer.rs`, replace the existing `panic_tests` module's panic test with a logger-routing assertion and add a new test. Add to the `panic_tests` module:

```rust
    use crate::logging::{LogLevel, LogRecord, LogSink, Logger};
    use std::collections::BTreeMap;

    struct Collector(Arc<std::sync::Mutex<Vec<LogRecord>>>);
    impl LogSink for Collector {
        fn on_log(&self, r: LogRecord) {
            self.0.lock().unwrap().push(r);
        }
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
```

In `packages/core-rs/src/api.rs` test module (`mod tests` near line 723), add:

```rust
    #[test]
    fn register_log_sink_receives_records() {
        use crate::logging::{LogRecord, LogSink};
        use std::sync::Mutex as StdMutex;
        struct Collector(Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) { self.0.lock().unwrap().push(r); }
        }
        let cfg = Config::new("pk_test".to_string(), String::new()).unwrap();
        let core = RovenueCore::new_for_test(cfg).unwrap();
        let recs = Arc::new(StdMutex::new(Vec::new()));
        core.register_log_sink(Box::new(Collector(recs.clone())));
        // identity-changed observer panic path is exercised elsewhere; here we
        // assert the sink wiring is live by emitting a warn directly.
        core.logger.warn("test-warn");
        assert!(recs.lock().unwrap().iter().any(|r| r.message == "test-warn"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test observer::panic_tests::observer_panic_is_logged register_log_sink_receives 2>&1 | tail -25`
Expected: FAIL — `with_logger`, `register_log_sink`, `core.logger` not found; `Config::new` still has `debug`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core-rs/src/config.rs`:
- Add import: `use crate::logging::LogLevel;`
- Replace field `pub debug: bool,` (line 11) with `pub log_level: LogLevel,`
- In `Config::new` replace `debug: false,` (line 37) with `log_level: LogLevel::Warn,`

In `packages/core-rs/src/observer.rs`:
- Add `use crate::logging::Logger;` and `use std::sync::Arc;` (Arc already imported).
- Add field to `ObserverBus`:

```rust
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
}
```

- In `ObserverBus::emit`, replace the `eprintln!("[rovenue] observer.on_change panicked; skipping");` (line 44) with:

```rust
                if let Some(l) = self.logger.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    l.warn("observer.on_change panicked; skipping");
                }
```

In `packages/core-rs/src/funnel/mod.rs`, replace the `eprintln!` block (lines 55–57) with a logger warn. The funnel module must receive the logger — pass `Arc<Logger>` into the funnel struct the same way (builder/field). If the funnel struct already holds an `Arc<ObserverBus>` or similar shared handle, route through a stored `Arc<Logger>` added to it. Minimal change:

```rust
                if let Some(l) = self.logger.as_ref() {
                    l.warn("funnel_claim_listener.on_funnel_claim_resolved panicked; skipping");
                }
```

(Add a `logger: Option<Arc<Logger>>` field to the funnel struct and set it during construction in `api.rs`.)

In `packages/core-rs/src/api.rs`:
- Add imports: `use crate::logging::{Logger, LogLevel, LogSink};`
- Add field to `RovenueCore` struct (near `bus: Arc<ObserverBus>` at line 48):

```rust
    pub(crate) logger: Arc<Logger>,
```

- In the shared constructor (`fn` around line 88, where `bus` is built at line 92), build the logger BEFORE the bus and attach it:

```rust
        let logger = Arc::new(Logger::new(config.log_level));
        let bus = Arc::new(ObserverBus::default().with_logger(Arc::clone(&logger)));
```

- Store `logger` in the returned struct (near `_config: Arc::new(config),` line 208): add `logger,`.
- Add the public method (near `register_observer`, line 331):

```rust
    pub fn register_log_sink(&self, sink: Box<dyn LogSink>) {
        self.logger.set_sink(Arc::from(sink));
    }
```

Note: `Arc::from(Box<dyn LogSink>)` produces `Arc<dyn LogSink>`; `set_sink` takes `Arc<dyn LogSink>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test 2>&1 | tail -25`
Expected: PASS — all core tests green (the whole suite must compile after the `debug`→`log_level` swap; fix any remaining `config.debug` / `debug:` references the compiler flags).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/config.rs packages/core-rs/src/observer.rs packages/core-rs/src/funnel/mod.rs packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): wire Logger into RovenueCore; replace eprintln; config.debug→log_level"
```

---

## Task 4: Network trace in HttpClient

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs` (`with_logger`; emit debug metadata + error records; correlation id)
- Modify: `packages/core-rs/src/api.rs` (pass logger into `HttpClient` at construction, line ~101)
- Test: inline `#[cfg(test)]` in `http_client.rs`

**Interfaces:**
- Consumes: `Arc<Logger>`, `LogLevel`, `LogRecord` (Task 1); `redact_fields` (Task 2)
- Produces: `HttpClient::with_logger(self, logger: Arc<Logger>) -> Self`; a private monotonic correlation-id counter on `HttpClient`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)]` module in `packages/core-rs/src/transport/http_client.rs`:

```rust
    #[test]
    fn debug_level_logs_request_metadata_without_authorization() {
        use crate::logging::{LogLevel, LogRecord, LogSink, Logger};
        use std::sync::Mutex as StdMutex;
        struct Collector(std::sync::Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) { self.0.lock().unwrap().push(r); }
        }
        let recs = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let logger = std::sync::Arc::new(Logger::new(LogLevel::Debug));
        logger.set_sink(std::sync::Arc::new(Collector(recs.clone())));

        // Point at an unroutable local port so the request fails fast; we only
        // assert on the emitted trace metadata, not on a live response.
        let client = HttpClient::new("http://127.0.0.1:1".to_string(), "pk_secret".to_string())
            .with_max_attempts(1)
            .with_logger(logger);
        let _ = client.get_json::<serde_json::Value>(&crate::transport::types::Request {
            path: "/v1/entitlements".to_string(),
            // fill remaining Request fields per the actual struct definition
            ..Default::default()
        });

        let got = recs.lock().unwrap();
        assert!(got.iter().any(|r| r.fields.get("path").map(|p| p == "/v1/entitlements").unwrap_or(false)),
            "expected a record carrying the request path");
        for r in got.iter() {
            for v in r.fields.values() {
                assert!(!v.contains("pk_secret"), "api key leaked into trace: {v}");
            }
            assert!(!r.message.contains("pk_secret"), "api key leaked into message: {}", r.message);
            assert!(!r.fields.contains_key("Authorization") && !r.fields.contains_key("authorization"),
                "Authorization must never be a logged field");
        }
    }
```

> Adjust the `Request` construction to match `transport/types.rs` exactly (the implementer must read that struct; if it has no `Default`, build it explicitly). The assertion content is the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test transport::http_client::tests::debug_level_logs 2>&1 | tail -25`
Expected: FAIL — `with_logger` not found.

- [ ] **Step 3: Write minimal implementation**

In `packages/core-rs/src/transport/http_client.rs`:
- Add to the `HttpClient` struct (near line 40):

```rust
    logger: Option<std::sync::Arc<crate::logging::Logger>>,
    corr_counter: std::sync::atomic::AtomicU64,
```

- Initialize in `HttpClient::new` (line 57): `logger: None,` and `corr_counter: std::sync::atomic::AtomicU64::new(0),`. (If the struct must stay `Clone`, wrap the counter in `Arc<AtomicU64>` instead.)
- Add builder:

```rust
    pub fn with_logger(mut self, logger: std::sync::Arc<crate::logging::Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    fn next_correlation_id(&self) -> String {
        let n = self.corr_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("req-{n}")
    }
```

- In `get_json` (and `post_json`, `post_json_status`) request loops, at the start of each attempt compute `let corr = self.next_correlation_id();` once before the loop, and after `let status = resp.status().as_u16();` emit a debug record; on the terminal error path emit an error record. Use the `Logger::log` lazy form so nothing is built below threshold:

```rust
            if let Some(l) = &self.logger {
                let path = req.path.clone();
                let corr_c = corr.clone();
                let attempt_n = attempt;
                l.log(
                    crate::logging::LogLevel::Debug,
                    || format!("http {} {}", "GET", path),
                    || {
                        let mut f = std::collections::BTreeMap::new();
                        f.insert("method".to_string(), "GET".to_string());
                        f.insert("path".to_string(), path.clone());
                        f.insert("status".to_string(), status.to_string());
                        f.insert("attempt".to_string(), attempt_n.to_string());
                        f.insert("correlation_id".to_string(), corr_c.clone());
                        crate::logging::redact::redact_fields(f)
                    },
                );
            }
```

For terminal errors (network/timeout after retries, and the final non-retryable error branch), emit at `LogLevel::Error` with `kind`/`status` fields and a `redact_message`-passed message. Reuse the same `if let Some(l) = &self.logger` lazy pattern.

> **Scope decision (deviates from spec §6):** the spec lists a `Trace`-level *redacted body summary*. This plan implements `Debug` metadata + `Error` records only and **defers trace-level body logging** — capturing/summarizing request/response bodies safely requires body buffering and a deeper redaction pass, and `Off→Debug` already covers the diagnostic need. `Trace` remains a valid threshold (it simply receives the same records as `Debug` for now). Flag this to the reviewer; promote to its own task if body-level tracing is required before launch.

In `packages/core-rs/src/api.rs`, where `HttpClient::new(...)` is constructed (line ~101), append `.with_logger(Arc::clone(&logger))` before the other builder calls.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test transport::http_client 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): redacted network trace with correlation id at debug/error"
```

---

## Task 5: Operation logs in core (replace façade emit())

**Files:**
- Modify: `packages/core-rs/src/api.rs` (log start/ok/fail around FFI operation methods)
- Test: inline test in `api.rs`

**Interfaces:**
- Consumes: `RovenueCore.logger` (Task 3), `LogLevel`, `redact_message` (Task 2)
- Produces: info/error operation records carrying `op` + (on failure) `kind` fields

**Scope note:** Core logs the operations it performs — `identify`, `log_out`, `refresh_entitlements`, `refresh_virtual_currencies`, `refresh_remote_config`, `track`, `set_attributes`, `get_offerings`, `post_apple_receipt`, `post_google_receipt`, `claim_*`, `get_or_create_app_account_token`. **Native-only StoreKit/Billing steps** (product fetch, payment sheet) are not visible to core and are intentionally out of scope — core logs the receipt-post outcome only.

- [ ] **Step 1: Write the failing test**

Add to `api.rs` test module:

```rust
    #[test]
    fn identify_logs_op_at_info_with_op_field() {
        use crate::logging::{LogLevel, LogRecord, LogSink};
        use std::sync::Mutex as StdMutex;
        struct Collector(Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) { self.0.lock().unwrap().push(r); }
        }
        let mut cfg = Config::new("pk_test".to_string(), String::new()).unwrap();
        cfg.log_level = LogLevel::Info;
        let core = RovenueCore::new_for_test(cfg).unwrap();
        let recs = Arc::new(StdMutex::new(Vec::new()));
        core.register_log_sink(Box::new(Collector(recs.clone())));
        let _ = core.identify("user_should_not_appear".to_string());
        let got = recs.lock().unwrap();
        // An "identify" op record exists at info level...
        assert!(got.iter().any(|r| r.fields.get("op").map(|o| o == "identify").unwrap_or(false)));
        // ...and the app_user_id never appears in any message or field.
        for r in got.iter() {
            assert!(!r.message.contains("user_should_not_appear"));
            assert!(r.fields.values().all(|v| !v.contains("user_should_not_appear")));
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test api::tests::identify_logs_op 2>&1 | tail -20`
Expected: FAIL — no `op=identify` record emitted.

- [ ] **Step 3: Write minimal implementation**

In `api.rs`, wrap each operation method body. Pattern for `identify` (apply the same shape to the other operations listed in the scope note):

```rust
    pub fn identify(&self, app_user_id: String) -> RovenueResult<()> {
        self.logger.log(LogLevel::Info, || "identify".to_string(), || {
            let mut f = std::collections::BTreeMap::new();
            f.insert("op".to_string(), "identify".to_string());
            f
        });
        let result = self.identify_inner(app_user_id); // existing body
        match &result {
            Ok(_) => self.logger.log(LogLevel::Info, || "identify ok".to_string(), || {
                let mut f = std::collections::BTreeMap::new();
                f.insert("op".to_string(), "identify".to_string());
                f
            }),
            Err(e) => self.logger.log(LogLevel::Error, || format!("identify failed: {}", crate::logging::redact::redact_message(&e.message)), || {
                let mut f = std::collections::BTreeMap::new();
                f.insert("op".to_string(), "identify".to_string());
                f.insert("kind".to_string(), format!("{:?}", e.kind));
                f
            }),
        }
        result
    }
```

> If splitting into `_inner` is heavy, log inline at the existing return sites instead — the contract is: an `op=identify` info record on entry/success and an `op=identify` + `kind` error record on failure, with the message redacted. Never insert `app_user_id` into a field or message.

Define a small private helper on `RovenueCore` to cut boilerplate:

```rust
    fn log_op(&self, level: LogLevel, message: &str, op: &str, extra: &[(&str, &str)]) {
        let message = message.to_string();
        let op = op.to_string();
        let extra: Vec<(String, String)> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        self.logger.log(level, move || message, move || {
            let mut f = std::collections::BTreeMap::new();
            f.insert("op".to_string(), op);
            for (k, v) in extra { f.insert(k, v); }
            f
        });
    }
```

Then each site becomes e.g. `self.log_op(LogLevel::Info, "identify", "identify", &[]);` and on error `self.log_op(LogLevel::Error, &format!("identify failed: {}", redact_message(&e.message)), "identify", &[("kind", &format!("{:?}", e.kind))]);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test 2>&1 | tail -25`
Expected: PASS (whole core suite).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): operation logs (op/kind, redacted) replacing facade emit"
```

---

## Task 6: FFI contract (UDL) + regenerate bindings

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/src/api.rs` — ensure `register_log_sink` signature matches the UDL projection (UniFFI maps `LogSink` callback → `Box<dyn LogSink>`); add UDL-facing `LogLevel`/`LogRecord` types if the Rust types need `uniffi` derive attributes (mirror how `ChangeEvent`/`Entitlement` are exposed)
- Test: `cargo build` (UDL must compile) + bindings regen

**Interfaces:**
- Consumes: `LogLevel`, `LogRecord`, `LogSink` (Task 1); `register_log_sink` (Task 3); `Config.log_level` (Task 3)
- Produces: generated Swift/Kotlin `LogLevel`, `LogRecord`, `LogSink` protocol, `RovenueCore.registerLogSink(...)`, `Config.logLevel` — consumed by Tasks 7–9

- [ ] **Step 1: Edit the UDL**

In `packages/core-rs/src/librovenue.udl`:

- In `dictionary Config` (lines 23–30): remove `boolean debug;` (line 25) and add:

```
    LogLevel log_level;
```

- Add after the `ChangeEvent` enum (after line 54):

```
enum LogLevel {
    "Off", "Error", "Warn", "Info", "Debug", "Trace",
};

dictionary LogRecord {
    LogLevel level;
    string message;
    record<string, string> fields;
};

callback interface LogSink {
    void on_log(LogRecord record);
};
```

- In `interface RovenueCore`, add after `register_observer` (line 196):

```
    void register_log_sink(LogSink sink);
```

- [ ] **Step 2: Make the Rust types UDL-compatible**

Ensure `LogLevel` and `LogRecord` in `logging/mod.rs` carry the UniFFI derives/attributes used elsewhere in the crate (check how `ChangeEvent` and `Entitlement` are wired — either `#[derive(uniffi::Enum)]` / `#[derive(uniffi::Record)]` or the scaffolding macro, matching the crate's existing UniFFI mode). The `LogSink` trait already matches the callback-interface shape (`&self`, no return). Confirm `register_log_sink` in `api.rs` is exported the same way `register_observer` is.

- [ ] **Step 3: Build + regenerate bindings**

Run:
```bash
cd packages/core-rs && cargo build 2>&1 | tail -20
cd /Volumes/Development/rovenue && npm run sdk:bindings 2>&1 | tail -20
```
Expected: core builds; bindings regenerate without error. Confirm generated `Config` no longer has `debug` and now has `logLevel`, and a `LogSink` protocol + `registerLogSink` exist (Swift `Generated/RovenueFFI.swift`, Kotlin `generated/librovenue.kt`).

- [ ] **Step 4: Commit**

```bash
git add packages/core-rs/src/librovenue.udl packages/core-rs/src/logging/mod.rs packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): export LogLevel/LogRecord/LogSink + register_log_sink across FFI"
```

---

## Task 7: Swift façade — LogSink bridge + remove emit()

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift`

**Interfaces:**
- Consumes: generated `LogSink` protocol, `LogRecord`, `LogLevel`, `Config.logLevel`, `RovenueCore.registerLogSink` (Task 6); existing static `emit`/`setLogHandler`/`logHandlers` (Rovenue.swift:136–154)
- Produces: a `LogSinkBridge` registered at configure; unchanged public `setLogHandler`/`LogEntry`

- [ ] **Step 1: Write the failing test**

In `LogHandlerTests.swift`, add (the existing PII/unsubscribe tests stay):

```swift
func testCoreLogReachesHandler() throws {
    var captured: [LogEntry] = []
    let unsub = Rovenue.shared.setLogHandler { captured.append($0) }
    defer { unsub() }
    // identify routes through core, which now emits an `identify` op log.
    Task { try? await Rovenue.shared.identify("user_pii_check") }
    // (use the test's existing expectation/wait pattern to drain the dispatcher)
    // After draining:
    XCTAssertTrue(captured.contains { $0.message.contains("identify") })
    XCTAssertFalse(captured.contains { $0.message.contains("user_pii_check") })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter LogHandlerTests 2>&1 | tail -25`
Expected: FAIL — no core-origin `identify` log reaches the handler (emit() was façade-only / removed).

- [ ] **Step 3: Implement**

In `Rovenue.swift`:
- Add a bridge type (near `ObserverBridge` usage):

```swift
final class LogSinkBridge: LogSink {
    func onLog(record: LogRecord) {
        let level: String
        switch record.level {
        case .off: return
        case .error: level = "error"
        case .warn: level = "warn"
        case .info: level = "info"
        case .debug: level = "debug"
        case .trace: level = "trace"
        }
        Rovenue.emit(LogEntry(level: level, message: record.message, data: record.fields.isEmpty ? nil : record.fields))
    }
}
```

- In `configure(...)`: change the signature `debug: Bool = false` → `logLevel: LogLevel = .warn`; remove the `emit(LogEntry(level: "info", message: "configure"))` line (66); build `Config(apiKey:, logLevel: logLevel, appVersion:, platform:, environment:)`; after `core.registerObserver(obs: bridge)` add:

```swift
        core.registerLogSink(sink: LogSinkBridge())
```

- Remove every `Self.emit(LogEntry(...))` / `emit(LogEntry(...))` operation call site throughout the file (identify, logOut, refresh*, track, getOfferings, purchase, restore, set*, shutdown, etc.). Keep the static `emit`, `setLogHandler`, `logHandlers`, `logLock` machinery — `emit` is now called only by `LogSinkBridge`.

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk-swift && swift test --filter LogHandlerTests 2>&1 | tail -25`
Expected: PASS. Then full `swift test 2>&1 | tail -25` to catch signature breaks from the `debug`→`logLevel` change.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift
git commit -m "feat(sdk-swift): LogSink bridge; core-authoritative logs; drop debug→logLevel"
```

---

## Task 8: Kotlin façade — LogSink bridge + remove emit()

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt`

**Interfaces:**
- Consumes: generated `LogSink`, `LogRecord`, `LogLevel`, `Config.logLevel`, `RovenueCore.registerLogSink` (Task 6); existing `LogEntry` data class + `setLogHandler` + `emit` (Rovenue.kt:17–23, 193–201)
- Produces: a `LogSinkBridge` registered at configure; unchanged public `setLogHandler`/`LogEntry`

- [ ] **Step 1: Write the failing test**

In `LogHandlerTest.kt` add (keep existing PII/unsubscribe tests):

```kotlin
@Test
fun coreLogReachesHandler() {
    val captured = mutableListOf<LogEntry>()
    val unsub = Rovenue.shared.setLogHandler { captured.add(it) }
    try {
        runBlocking { runCatching { Rovenue.shared.identify("user_pii_check") } }
        assertTrue(captured.any { it.message.contains("identify") })
        assertFalse(captured.any { it.message.contains("user_pii_check") })
    } finally {
        unsub()
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.LogHandlerTest" 2>&1 | tail -25`
Expected: FAIL — no core-origin `identify` log captured.

- [ ] **Step 3: Implement**

In `Rovenue.kt`:
- Add bridge:

```kotlin
private class LogSinkBridge : LogSink {
    override fun onLog(record: LogRecord) {
        val level = when (record.level) {
            LogLevel.OFF -> return
            LogLevel.ERROR -> "error"
            LogLevel.WARN -> "warn"
            LogLevel.INFO -> "info"
            LogLevel.DEBUG -> "debug"
            LogLevel.TRACE -> "trace"
        }
        Rovenue.emit(LogEntry(level, record.message, record.fields.ifEmpty { null }))
    }
}
```

- In `configure(...)`: change `debug: Boolean = false` → `logLevel: LogLevel = LogLevel.WARN`; build `Config(... logLevel = logLevel ...)`; after the observer registration add `core.registerLogSink(LogSinkBridge())`.
- Remove every internal `emit(LogEntry(...))` operation call site (the ~14 operation logs). Keep the `emit`/`setLogHandler`/`ReentrantLock` registry intact.

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest 2>&1 | tail -25`
Expected: PASS (whole unit-test suite; catches `debug`→`logLevel` signature breaks).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt
git commit -m "feat(sdk-kotlin): LogSink bridge; core-authoritative logs; drop debug→logLevel"
```

---

## Task 9: React Native façade — logLevel + LogRecord fields + redaction test

**Files:**
- Modify: `packages/sdk-rn/src/api/configure.ts` (remove `debug`, add `logLevel`)
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts` (config `logLevel`; `onLog` payload carries `fields`)
- Modify: `packages/sdk-rn/src/api/log.ts` (map native `onLog` → `LogEntry` with `data` from `fields`)
- Modify: `packages/sdk-rn/src/__tests__/log.test.ts` (add redaction test — closes today's gap)
- Modify: `packages/sdk-rn/src/__tests__/_mockNative.ts` (mock emits a `LogRecord`-shaped `onLog`)

**Interfaces:**
- Consumes: native `onLog` event now carrying `{ level, message, fields }` (the iOS/Android bridges forward core `LogRecord`); existing `LogEntry` type + `setLogHandler` (log.ts:9–22)
- Produces: `RovenueConfig.logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace"`; `LogEntry.data` populated from `fields`

> RN native bridges can't be built standalone — the DTO/contract + the JS mapping/redaction tests are the verification gate (consistent with prior SDK work).

- [ ] **Step 1: Write the failing test**

In `packages/sdk-rn/src/__tests__/log.test.ts` add:

```typescript
it("maps native onLog fields into LogEntry.data and never surfaces raw secrets", () => {
  const seen: LogEntry[] = [];
  Rovenue.setLogHandler((e) => seen.push(e));
  // Simulate the native bridge emitting a core LogRecord (already redacted in core).
  emitMockNativeLog({
    level: "debug",
    message: "http GET /v1/entitlements",
    fields: { method: "GET", path: "/v1/entitlements", status: "200", correlation_id: "req-0" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0].level).toBe("debug");
  expect(seen[0].data?.path).toBe("/v1/entitlements");
  // Authorization must never be a field key (core strips it).
  expect(Object.keys(seen[0].data ?? {})).not.toContain("authorization");
  Rovenue.setLogHandler(null);
});
```

Add an `emitMockNativeLog` helper to `_mockNative.ts` that pushes the given payload through the mocked `NativeEventEmitter` `onLog` listener.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm test log.test 2>&1 | tail -25`
Expected: FAIL — `emitMockNativeLog` undefined and/or `data` not populated from `fields`.

- [ ] **Step 3: Implement**

In `RovenueModule.types.ts`:
- In the config type (line ~130): replace `debug: boolean,` with `logLevel: "off" | "error" | "warn" | "info" | "debug" | "trace",`.
- In the `onLog` payload type (line ~113 area): add `fields: Record<string, string>` alongside `level`/`message`.

In `configure.ts`:
- In `RovenueConfig` (line 15): replace `debug?: boolean;` with `logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";`.
- At the native call (line 46): replace `opts.debug ?? false,` with `opts.logLevel ?? "warn",`.

In `log.ts`:
- In the `onLog` listener mapping, set `data` from the native `fields`:

```typescript
const entry: LogEntry = {
  level: native.level,
  message: native.message,
  data: native.fields && Object.keys(native.fields).length > 0 ? native.fields : undefined,
};
```

In `_mockNative.ts`: add `emitMockNativeLog(payload)` that invokes the registered `onLog` handler with `payload`.

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk-rn && pnpm test 2>&1 | tail -25`
Expected: PASS (whole RN test suite; catches `debug`→`logLevel` type breaks).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/src/api/configure.ts packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/api/log.ts packages/sdk-rn/src/__tests__/log.test.ts packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): logLevel config + LogRecord fields on onLog + redaction test"
```

---

## Task 10: Cross-façade LogLevel parity test

**Files:**
- Modify/Create: the existing error-taxonomy parity test location (mirror its pattern — find it via `grep -rl "ErrorKind" packages/*/[Tt]est*`); add a `LogLevel` value-parity assertion.

**Interfaces:**
- Consumes: the `LogLevel` enum as exposed in core UDL + each façade's generated/declared form

- [ ] **Step 1: Write the parity test**

Mirror the error-taxonomy parity test (`a6d87295`): assert the set of `LogLevel` string values is exactly `{off, error, warn, info, debug, trace}` and matches across the UDL and each façade's mapping switch (Swift `LogSinkBridge`, Kotlin `LogSinkBridge`, RN union type). Concretely: a test that enumerates the expected six values and asserts each façade's level-mapping handles all six (no `default`/`else` swallowing).

- [ ] **Step 2: Run / verify**

Run the relevant suite (`swift test` / `./gradlew testDebugUnitTest` / `pnpm test` for whichever houses the parity test).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add <parity test file>
git commit -m "test(sdk): LogLevel value parity across core + facades"
```

---

## Final verification

- [ ] `cd packages/core-rs && cargo test 2>&1 | tail -20` — all green
- [ ] `cd packages/core-rs && cargo clippy --all-targets 2>&1 | tail -20` — no new warnings (release gate per prior SDK CI notes)
- [ ] `cd packages/core-rs && cargo fmt --check` — formatted
- [ ] `npm run sdk:bindings` — regenerates cleanly
- [ ] `cd packages/sdk-swift && swift test 2>&1 | tail -20` — green
- [ ] `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest 2>&1 | tail -20` — green
- [ ] `cd packages/sdk-rn && pnpm test 2>&1 | tail -20` — green
- [ ] `grep -rn "config.debug\|debug:\s*bool\|\.debug\b" packages/core-rs/src` — no stray references
- [ ] Manual: confirm no `emit(LogEntry` operation call sites remain in façades (`grep -rn "emit(LogEntry" packages/sdk-swift packages/sdk-kotlin`)
