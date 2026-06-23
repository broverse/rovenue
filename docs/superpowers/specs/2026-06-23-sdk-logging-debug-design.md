# SDK Logging & Debug — Design Spec

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Scope:** Rust core (`librovenue`) + Swift + Kotlin + React Native façades

---

## 1. Problem & Motivation

The SDK's logging/debug story is split across two layers with a hard disconnect:

- **Native façades** (Swift/Kotlin/RN) have a decent `setLogHandler` + structured `LogEntry` system with strong PII protection — but the logs originate **only in the façade** (`emit()` call sites wrapping each operation).
- **Rust core** (`librovenue`) — where all the real work happens (network, retries, FFI, cache) — has **no logging infrastructure at all**:
  - `log`/`tracing`/`env_logger` are **not** dependencies of our code (`log` is only transitive via `reqwest`).
  - Only **two** log statements exist in ~6,300 LoC, both raw `eprintln!` (`observer.rs:44`, `funnel/mod.rs:55`) — panic-recovery messages dumped to stderr.
  - The `config.debug: bool` flag is **dead code**: declared (`config.rs:11`) and defaulted (`config.rs:37`), passed across the FFI from all three façades, but **never read** anywhere in core.
  - There is **no FFI mechanism** to carry logs from core to native (only `Observer` + `FunnelClaimListener` callbacks exist, both for state events).

**Consequence:** when a real integration problem occurs (a purchase fails, a request retries, a token expires), the host app's `setLogHandler` sees only the façade's coarse `"identify failed: …"` line. Everything that would explain *why* (HTTP status, retry count, server code, timing) stays invisible inside the Rust runtime.

### New finding from the recent error refactor (commits up to `a6d87295`)

The error-taxonomy work introduced a single structured `RovenueError { kind, message, server_code, http_status, retryable }`:

- **Opportunity:** these structured fields are ideal raw material for structured logging — we replace free-text `"X failed: <message>"` with structured records carrying `kind`/`server_code`/`http_status`.
- **New risk:** commit `55fe4d0c` ("preserve backend error envelope") makes `message` carry the **raw backend message**, and the Swift façade logs it verbatim via `errorDescription { message }` (`Errors.swift:49`). If a server message ever contains user data, it leaks into logs. **Redaction scope therefore extends to error messages, not just network bodies.**

---

## 2. Goals & Non-Goals

### Goals
- A single, unified log stream: **Rust core is the sole authority**; façades are thin bridges.
- Configurable verbosity via a `LogLevel` threshold; logs below threshold are never produced (lazy, zero formatting cost).
- Core network/operation/retry diagnostics reach the host app's existing `setLogHandler`.
- Single-point redaction covering both network traces and error messages.
- Ship across core + all three façades in one coherent change (FFI/DTO contract is the gate).

### Non-Goals
- No `log`/`tracing` crate adoption (avoid backend-init complexity + dependency bloat).
- No on-device debug overlay / diagnostics-dump UI.
- No remote log shipping / telemetry pipeline.
- **No backward-compatibility constraint** — the SDK is not yet published, so public API may change freely (the `debug` flag is removed, not deprecated).

---

## 3. Architecture & Data Flow

Single log stream, core-authoritative:

```
Rust core
  ├─ produces log records at operation + network sites
  ├─ filters by configured LogLevel threshold (below threshold = never produced)
  ├─ redacts sensitive fields (single redact() pass)
  │
  │  UniFFI callback interface:  LogSink.on_log(LogRecord)
  ▼
Swift / Kotlin / RN façade
  ├─ registers a LogSink on configure
  ├─ maps LogRecord → existing LogEntry shape
  ▼
Host app's setLogHandler  (one unified stream: operations + network + panics)
```

Key principles:
- **Single source of truth.** Today's façade-internal `emit()` operation logs are **removed**; core produces both operation and network logs. The "façade logs are disconnected from core" problem is eliminated at the root.
- **Façade is a bridge.** Façades no longer originate logs — they register a `LogSink` and forward `LogRecord` → `LogEntry` to the host's `setLogHandler`. The public `setLogHandler`/`LogEntry` surface is **kept** (host apps see a richer, unified stream).
- **No backward compat.** `debug: bool` is **removed** from the config and all `configure(...)` signatures, replaced by `logLevel`.

---

## 4. Rust Core Logging Infrastructure

A lightweight, self-contained logging module (no `log`/`tracing` crate).

**New module:** `core-rs/src/logging/mod.rs`

```rust
pub enum LogLevel { Off, Error, Warn, Info, Debug, Trace }  // derives Ord for threshold compare

pub struct LogRecord {
    pub level: LogLevel,
    pub message: String,
    pub fields: BTreeMap<String, String>,  // op, kind, server_code, http_status, duration_ms, attempt, correlation_id
}
```

- A **`Logger`** owned by the `Client` (not a global): holds the configured `LogLevel` threshold and an optional reference to the registered `LogSink`. Records below threshold are **never constructed** (lazy — no string-format cost paid).
- **`config.debug` is removed**; replaced by `config.log_level: LogLevel` (default `Warn`).
- The two `eprintln!` statements (`observer.rs:44`, `funnel/mod.rs:55`) are **removed** and become `logger.warn(...)` calls, so observer/listener panic messages join the unified stream.
- **Single-point redaction:** `core-rs/src/logging/redact.rs` — drops the `Authorization` header entirely; masks known sensitive field names (`token`, `receipt`, `email`, `app_user_id`, JWS/signature). Both network traces and error messages pass through this filter before emission.

---

## 5. FFI Contract (LogSink) & Façade Wiring

**Additions to `librovenue.udl`** (symmetric with the existing `Observer` pattern):

```
enum LogLevel { "Off", "Error", "Warn", "Info", "Debug", "Trace" };

dictionary LogRecord {
    LogLevel level;
    string message;
    record<string, string> fields;
};

callback interface LogSink {
    void on_log(LogRecord record);
};
```

- `Config` gains a `log_level` field; the client gains `register_log_sink(LogSink sink)` (symmetric with `register_observer`). When a sink is registered, core forwards records; otherwise emission is a no-op (zero cost).
- **`on_log` must be panic-guarded in core** via `catch_unwind` — identical to the protection added for observer/funnel callbacks in commit `29671302`. A panicking host sink must not crash the core.

**Façade wiring (Swift / Kotlin / RN):**
- Façade maps incoming `LogRecord` → existing `LogEntry` (`level` enum→string, `fields` carried through). Public `setLogHandler` API is preserved.
- Today's façade-internal `emit()` operation logs are **deleted** — no dual source. Operation logs are produced in core (core logs before/after the FFI operation).
- `configure(...)` signatures drop `debug`, gain `logLevel` (default `.warn`).
- RN: the `onLog` event bridge widens to carry `LogRecord.fields`.

---

## 6. What Gets Logged

| Level | Content |
|-------|---------|
| **Error** | Failed operation: `op`, `kind`, `server_code`, `http_status`, `retryable`. Message **redacted**. |
| **Warn** | Retry exhaustion, grace/fallback states, observer/listener panics. |
| **Info** | Operation start/success (`configure`, `identify ok`, `purchase ok`, …) — the core equivalent of today's `emit()` set. |
| **Debug** | Network metadata: `method`, `path`, `status`, `duration_ms`, `attempt`, `correlation_id`. **No** headers/body. |
| **Trace** | Redacted body summary (sensitive fields masked). |

- **Correlation ID:** a short id generated per outgoing request in core, linking the debug + error records of the same request. Generated via core's existing id/counter mechanism / a monotonic counter — **not** `Math.random`/`Date.now` (those are unavailable in some runtimes and break determinism).
- **Error-message redaction:** the raw `message` preserved by the error envelope now passes through `redact()`; `kind`/`server_code`/`http_status` carry cleanly in structured fields.

---

## 7. Test Strategy (TDD)

**Rust core (`cargo test`):**
- `LogLevel` threshold filtering: records below threshold are never produced (sink not invoked).
- Redaction: Authorization header / token / email / receipt absent from logged output.
- `LogSink` panic guard: a sink that panics in `on_log` is caught via `catch_unwind`; core does not crash (same pattern as observer/funnel).
- Correlation ID: debug + error records of the same request carry the same id.

**Façade contract tests (FFI/DTO gate — RN native bridges can't build standalone):**
- Swift (`RovenueTests`) + Kotlin (`testDebugUnitTest`): `LogRecord` → `LogEntry` mapping correct; existing PII test (user id absent from logs) preserved/extended.
- **RN redaction test added** (closes today's gap): a no-sensitive-data assertion in `log.test.ts`.

**Parity test:** all three façades agree the `LogLevel` enum values match the FFI (reuse the existing error-taxonomy parity-test pattern).

---

## 8. Affected Files (indicative)

| Area | Files |
|------|-------|
| Core infra | `core-rs/src/logging/mod.rs` (new), `core-rs/src/logging/redact.rs` (new) |
| Core config | `core-rs/src/config.rs` (remove `debug`, add `log_level`) |
| Core wiring | `core-rs/src/observer.rs`, `core-rs/src/funnel/mod.rs` (remove `eprintln!`), HTTP client/transport (network trace sites), client (`register_log_sink`) |
| FFI | `core-rs/src/librovenue.udl` (LogLevel, LogRecord, LogSink) |
| Swift | `sdk-swift/Sources/Rovenue/Rovenue.swift` (drop `emit()`, wire LogSink, `logLevel` in `configure`) |
| Kotlin | `sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (same) |
| RN | `sdk-rn/src/api/configure.ts`, `sdk-rn/src/api/log.ts`, `sdk-rn/src/specs/RovenueModule.types.ts`, native bridges, `sdk-rn/src/__tests__/log.test.ts` |

---

## 9. Open Questions / Risks

- **Generated bindings:** Swift/Kotlin bindings are regenerated via `npm run sdk:bindings` from the UDL; generated files are gitignored. The plan must include a bindings-regen step and verify façades compile against the new contract.
- **Correlation-id source:** confirm core has a suitable monotonic counter / id helper; if not, add one that does not rely on wall-clock or RNG that breaks in headless runs.
- **RN bridge build:** RN native bridges can't be built standalone, so the DTO/contract test is the verification gate (consistent with prior SDK work).
