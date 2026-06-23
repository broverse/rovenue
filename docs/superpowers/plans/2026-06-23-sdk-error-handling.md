# SDK Unified Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SDK's flat, lossy error model with one consistent field-carrying error type per façade (normalized `kind` + raw backend `serverCode`/`message`/`httpStatus` + derived `isRetryable`), correct HTTP→kind mapping, typed store failure reasons, and two stability fixes.

**Architecture:** The Rust core (`librovenue`) owns the canonical `ErrorKind` taxonomy and a rich `RovenueError` carrying fields; it crosses the UniFFI boundary as a single rich error. Each façade (Swift/Kotlin/RN) re-exposes it as one idiomatic type. Store-purchase failures become typed `StorePurchaseOutcome` variants; `.pending`/deferred is a non-error `Deferred` outcome.

**Tech Stack:** Rust (thiserror, uniffi UDL mode), Swift (StoreKit 2, async/throws), Kotlin (Play Billing 9, coroutines), TypeScript (Expo modules), Vitest, JUnit, `cargo test`, `swift test`, `gradle testDebugUnitTest`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-23-sdk-error-handling-design.md` (authoritative; read it before starting).
- Breaking change. Version bump **0.15.0 → 0.16.0** across all four artefacts (root `Cargo.toml` `[workspace.package] version`, `sdk-rn/package.json` + `sdk-rn/src/version.ts`, `sdk-kotlin/build.gradle.kts`, `sdk-swift/Rovenue.podspec`). The version-parity test enforces alignment — bump all five strings together.
- Kotlin module is on Kotlin **1.9**; do not introduce `billing-ktx` (Kotlin 2.x). Use the base `com.android.billingclient:billing:9.1.0` (already in place).
- UniFFI bindings are generated, **gitignored** build artefacts. Regenerate with `./packages/core-rs/scripts/build-bindings.sh` (a.k.a. `npm run sdk:bindings`). Never hand-edit `Generated/`.
- Verify Kotlin with `./gradlew testDebugUnitTest` (NOT compile-only — it misses red tests). The desktop tests load `target/release/librovenue.{so,dylib}` via `jna.library.path` + `uniffi.component.librovenue.libraryOverride=rovenue`.
- Stay on the current branch; the user manages branching.
- DRY, YAGNI, TDD, frequent commits.

## File Structure

| File | Responsibility |
|---|---|
| `core-rs/src/error.rs` | `ErrorKind` enum, rich `RovenueError`, constructors, `is_retryable` derivation |
| `core-rs/src/librovenue.udl` | FFI surface: `ErrorKind` enum + rich `[Error] interface RovenueError` |
| `core-rs/src/transport/api.rs` | `ApiError` envelope type + parse helper |
| `core-rs/src/transport/http_client.rs` | HTTP status → `RovenueError` mapping (both verbs) |
| `core-rs/src/observer.rs` | `catch_unwind` guard around foreign callback dispatch |
| `core-rs/src/funnel/client.rs` | funnel listener dispatch guard (same pattern) |
| `sdk-swift/.../Errors.swift` | single `RovenueError` struct + `ErrorKind` re-export + mapper from FFI |
| `sdk-swift/.../Internal/AppleStore.swift`, `ApplePurchaseFlow.swift` | StoreKit error → outcome mapping; `Deferred` |
| `sdk-kotlin/.../RovenueException.kt` (was split across Types.kt) | single `RovenueException(kind, …)` + `ErrorKind` |
| `sdk-kotlin/.../internal/PlayStore.kt`, `PlayBillingStore.kt`, `PlayPurchaseFlow.kt` | typed outcomes, Play mapping, `Deferred`, concurrency guard |
| `sdk-rn/src/errors.ts` | single `RovenueError` class + `ErrorKind` union + `mapNativeError` |
| `sdk-rn/ios/RovenueModule.swift`, `sdk-rn/android/.../RovenueModule.kt` | bridge: emit `kind`+fields for all errors |
| `sdk-rn/src/__tests__/error-taxonomy-parity.test.ts` | cross-façade `ErrorKind` parity |

---

## Task 1: Core `ErrorKind` + rich `RovenueError` (Rust)

**Files:**
- Modify: `packages/core-rs/src/error.rs` (full rewrite of the enum)
- Test: `packages/core-rs/src/error.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub enum ErrorKind { … }` (the 24 variants from spec §4.1); `pub struct RovenueError { pub kind: ErrorKind, pub message: String, pub server_code: Option<String>, pub http_status: Option<u16>, pub retryable: bool }`; constructors `RovenueError::kind(ErrorKind)`, `RovenueError::http(kind, status, server_code, message)`; `impl ErrorKind { pub fn is_retryable(&self) -> bool }`; `impl std::fmt::Display`/`std::error::Error` for `RovenueError`.

- [ ] **Step 1: Write the failing test**

In `packages/core-rs/src/error.rs`, append:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_kinds_are_classified() {
        for k in [ErrorKind::NetworkUnavailable, ErrorKind::Timeout, ErrorKind::RateLimited,
                  ErrorKind::ServerError, ErrorKind::StoreServiceUnavailable] {
            assert!(k.is_retryable(), "{k:?} should be retryable");
        }
        for k in [ErrorKind::InvalidApiKey, ErrorKind::Forbidden, ErrorKind::NotFound,
                  ErrorKind::InvalidRequest, ErrorKind::InsufficientCredits, ErrorKind::Internal] {
            assert!(!k.is_retryable(), "{k:?} should NOT be retryable");
        }
    }

    #[test]
    fn http_constructor_carries_fields() {
        let e = RovenueError::http(ErrorKind::Forbidden, 403,
            Some("FORBIDDEN".into()), "no access".into());
        assert_eq!(e.kind, ErrorKind::Forbidden);
        assert_eq!(e.http_status, Some(403));
        assert_eq!(e.server_code.as_deref(), Some("FORBIDDEN"));
        assert_eq!(e.message, "no access");
        assert!(!e.retryable);
    }

    #[test]
    fn kind_constructor_uses_default_message_and_no_http() {
        let e = RovenueError::kind(ErrorKind::Timeout);
        assert_eq!(e.kind, ErrorKind::Timeout);
        assert_eq!(e.http_status, None);
        assert_eq!(e.server_code, None);
        assert!(e.retryable);
        assert!(!e.message.is_empty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test -p librovenue error::tests 2>&1 | tail -20`
Expected: FAIL — `ErrorKind`/`RovenueError::http`/`is_retryable` not found (the old flat enum has none of these).

- [ ] **Step 3: Replace the enum with the rich type**

Rewrite the top of `packages/core-rs/src/error.rs` (everything above the test module):

```rust
/// Normalized error category — the stable discriminant callers switch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    // network / transport
    NetworkUnavailable, Timeout, RateLimited, ServerError,
    // auth / request
    InvalidApiKey, Forbidden, NotFound, InvalidRequest, Conflict, InvalidArgument,
    // domain
    InsufficientCredits, FunnelTokenNotFound, FunnelTokenExpired, FunnelTokenAlreadyClaimed,
    // store
    PurchaseCanceled, ProductNotAvailable, AlreadyOwned, PaymentDeclined,
    StoreServiceUnavailable, Ineligible, ReceiptInvalid, StoreProblem,
    // other
    Storage, Internal,
}

impl ErrorKind {
    pub fn is_retryable(&self) -> bool {
        matches!(self,
            ErrorKind::NetworkUnavailable | ErrorKind::Timeout | ErrorKind::RateLimited
            | ErrorKind::ServerError | ErrorKind::StoreServiceUnavailable)
    }

    /// Default English message used when the backend supplies none.
    pub fn default_message(&self) -> &'static str {
        match self {
            ErrorKind::NetworkUnavailable => "network unavailable",
            ErrorKind::Timeout => "request timed out",
            ErrorKind::RateLimited => "rate limited",
            ErrorKind::ServerError => "server error",
            ErrorKind::InvalidApiKey => "invalid api key",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::NotFound => "not found",
            ErrorKind::InvalidRequest => "invalid request",
            ErrorKind::Conflict => "conflict",
            ErrorKind::InvalidArgument => "invalid argument",
            ErrorKind::InsufficientCredits => "insufficient credits",
            ErrorKind::FunnelTokenNotFound => "funnel token not found",
            ErrorKind::FunnelTokenExpired => "funnel token expired",
            ErrorKind::FunnelTokenAlreadyClaimed => "funnel token already claimed",
            ErrorKind::PurchaseCanceled => "purchase canceled",
            ErrorKind::ProductNotAvailable => "product not available",
            ErrorKind::AlreadyOwned => "already owned",
            ErrorKind::PaymentDeclined => "payment declined",
            ErrorKind::StoreServiceUnavailable => "store service unavailable",
            ErrorKind::Ineligible => "ineligible",
            ErrorKind::ReceiptInvalid => "receipt invalid",
            ErrorKind::StoreProblem => "store problem",
            ErrorKind::Storage => "storage error",
            ErrorKind::Internal => "internal error",
        }
    }
}

/// The single error type the core produces and exports across FFI.
#[derive(Debug, Clone)]
pub struct RovenueError {
    pub kind: ErrorKind,
    pub message: String,
    pub server_code: Option<String>,
    pub http_status: Option<u16>,
    pub retryable: bool,
}

impl RovenueError {
    /// Construct from a kind alone (network/store/internal paths).
    pub fn kind(kind: ErrorKind) -> Self {
        Self { kind, message: kind.default_message().to_string(),
               server_code: None, http_status: None, retryable: kind.is_retryable() }
    }
    /// Construct from an HTTP error, preserving the backend code/message.
    pub fn http(kind: ErrorKind, status: u16,
                server_code: Option<String>, message: String) -> Self {
        let message = if message.is_empty() { kind.default_message().to_string() } else { message };
        Self { kind, message, server_code, http_status: Some(status), retryable: kind.is_retryable() }
    }
}

impl std::fmt::Display for RovenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for RovenueError {}
```

If the old enum had `From` impls or helper constructors used elsewhere, leave shims that build the new struct (e.g. keep a `RovenueError::internal(msg)` if call sites used it — grep `RovenueError::` first and preserve referenced constructors by delegating to `RovenueError::kind`/`http`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue error::tests 2>&1 | tail -10`
Expected: PASS (3 tests).

- [ ] **Step 5: Make the crate compile (fix call sites)**

Run: `cargo build -p librovenue 2>&1 | grep -E "error\[|error:" | head -40`
For each broken call site (old fieldless variant like `RovenueError::InvalidApiKey`), replace with `RovenueError::kind(ErrorKind::InvalidApiKey)` (transport mapping call sites are rewritten properly in Task 2 — here just make it compile). Re-run until clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/error.rs
git commit -m "feat(sdk-core): rich RovenueError with ErrorKind + carried fields"
```

---

## Task 2: `ApiError` envelope + HTTP→kind mapping (Rust transport)

**Files:**
- Modify: `packages/core-rs/src/transport/api.rs` (add `ApiError`)
- Modify: `packages/core-rs/src/transport/http_client.rs` (status mapping, both verbs)
- Test: new `packages/core-rs/tests/error_mapping.rs`

**Interfaces:**
- Consumes: `RovenueError`, `ErrorKind`, `RovenueError::http`/`kind` (Task 1).
- Produces: `pub struct ApiError { pub code: String, pub message: String }`; `pub fn error_from_status(status: u16, body: &str) -> RovenueError` (in `http_client.rs`, `pub(crate)`).

- [ ] **Step 1: Write the failing test**

Create `packages/core-rs/tests/error_mapping.rs`:

```rust
use librovenue::transport::http_client::error_from_status;
use librovenue::error::ErrorKind;

fn body() -> &'static str { r#"{"error":{"code":"BYOK_NOT_ALLOWED","message":"byok off"}}"# }

#[test]
fn maps_status_codes_to_kinds() {
    let cases = [
        (401u16, ErrorKind::InvalidApiKey),
        (402, ErrorKind::InsufficientCredits),
        (403, ErrorKind::Forbidden),
        (404, ErrorKind::NotFound),
        (400, ErrorKind::InvalidRequest),
        (422, ErrorKind::InvalidRequest),
        (409, ErrorKind::Conflict),
        (429, ErrorKind::RateLimited),
        (500, ErrorKind::ServerError),
        (503, ErrorKind::ServerError),
    ];
    for (status, kind) in cases {
        assert_eq!(error_from_status(status, body()).kind, kind, "status {status}");
    }
}

#[test]
fn preserves_backend_code_and_message() {
    let e = error_from_status(403, body());
    assert_eq!(e.server_code.as_deref(), Some("BYOK_NOT_ALLOWED"));
    assert_eq!(e.message, "byok off");
    assert_eq!(e.http_status, Some(403));
}

#[test]
fn falls_back_when_body_not_parseable() {
    let e = error_from_status(500, "<html>oops</html>");
    assert_eq!(e.kind, ErrorKind::ServerError);
    assert_eq!(e.server_code, None);
    assert!(!e.message.is_empty());
}
```

Ensure `error` and `transport::http_client` are reachable from integration tests: in `src/lib.rs` confirm `pub mod error;` and `pub mod transport;` (and `transport/mod.rs` has `pub mod http_client;`). If `error_from_status` must be public for the test, mark it `pub` (not `pub(crate)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue --test error_mapping 2>&1 | tail -20`
Expected: FAIL — `error_from_status` / `ApiError` not found.

- [ ] **Step 3: Add `ApiError` to `api.rs`**

In `packages/core-rs/src/transport/api.rs`, alongside `ApiEnvelope`:

```rust
#[derive(serde::Deserialize)]
pub struct ApiErrorBody { pub error: ApiError }

#[derive(serde::Deserialize)]
pub struct ApiError { pub code: String, pub message: String }
```

- [ ] **Step 4: Implement `error_from_status` in `http_client.rs`**

```rust
use crate::transport::api::ApiErrorBody;

/// Map an HTTP error status + response body to a RovenueError, preserving the
/// backend `{error:{code,message}}` envelope when present.
pub fn error_from_status(status: u16, body: &str) -> crate::error::RovenueError {
    use crate::error::{ErrorKind, RovenueError};
    let kind = match status {
        401 => ErrorKind::InvalidApiKey,
        402 => ErrorKind::InsufficientCredits,
        403 => ErrorKind::Forbidden,
        404 => ErrorKind::NotFound,
        409 => ErrorKind::Conflict,
        422 | 400 => ErrorKind::InvalidRequest,
        405..=499 => ErrorKind::InvalidRequest, // other 4xx are client-side
        500..=599 => ErrorKind::ServerError,
        429 => ErrorKind::RateLimited,
        _ => ErrorKind::Internal,
    };
    match serde_json::from_str::<ApiErrorBody>(body) {
        Ok(parsed) => RovenueError::http(kind, status, Some(parsed.error.code), parsed.error.message),
        Err(_) => RovenueError::http(kind, status, None, String::new()),
    }
}
```

Note: 429 is handled earlier by the retry/`Retry-After` path; the arm here is the exhausted fallback. The `405..=499` arm must come before nothing shadows 400/422 — Rust match arms are ordered, so keep the specific 400/409/422 arms above the range arm (reorder so `409 =>` and `422 | 400 =>` precede `405..=499 =>`; `405..=499` excludes those anyway, but list specific ones first for clarity).

Then in the terminal-error sites of `get_json` and `post_json`, replace the `ServerError`/`InvalidApiKey` collapse with `return Err(error_from_status(status, &body_text))`, reading the body text once on the error path. Apply the 402 check to **both** verbs (it currently exists only in `post_json`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p librovenue --test error_mapping 2>&1 | tail -10`
Expected: PASS (3 tests). Then `cargo test -p librovenue 2>&1 | grep "test result" | tail` — all green (existing transport tests must still pass; adjust any that asserted the old `ServerError`-for-4xx behaviour to the new kinds).

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/transport/api.rs packages/core-rs/src/transport/http_client.rs packages/core-rs/tests/error_mapping.rs
git commit -m "feat(sdk-core): preserve backend error envelope + correct HTTP status mapping"
```

---

## Task 3: Observer `catch_unwind` guard (Rust)

**Files:**
- Modify: `packages/core-rs/src/observer.rs`
- Modify: `packages/core-rs/src/funnel/client.rs` (claim-listener dispatch, same pattern)
- Test: inline `#[cfg(test)]` in `observer.rs`

**Interfaces:**
- Consumes: existing `ObserverBus`, `Observer` trait, `on_change`.
- Produces: no new public API; behaviour change only (panicking observer is caught + skipped).

- [ ] **Step 1: Write the failing test**

In `packages/core-rs/src/observer.rs` test module:

```rust
#[cfg(test)]
mod panic_tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicU32, Ordering}};

    struct Panicky;
    impl Observer for Panicky { fn on_change(&self, _e: ChangeEvent) { panic!("boom"); } }
    struct Counter(Arc<AtomicU32>);
    impl Observer for Counter { fn on_change(&self, _e: ChangeEvent) { self.0.fetch_add(1, Ordering::SeqCst); } }

    #[test]
    fn a_panicking_observer_does_not_abort_dispatch() {
        let bus = ObserverBus::new();
        let hits = Arc::new(AtomicU32::new(0));
        bus.subscribe(Arc::new(Panicky));
        bus.subscribe(Arc::new(Counter(hits.clone())));
        bus.emit(ChangeEvent::default()); // must not unwind; Counter must still run
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
```

Adjust `ChangeEvent::default()`/`subscribe`/`new` to the real signatures in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue observer::panic_tests 2>&1 | tail -20`
Expected: FAIL — the panic unwinds through `emit` (test aborts/panics) and/or `Counter` never runs.

- [ ] **Step 3: Guard the dispatch**

In `ObserverBus::emit`, wrap each callback call:

```rust
for s in subscribers.iter() {
    let s = s.clone();
    let ev = event.clone();
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || s.on_change(ev))).is_err() {
        log::warn!("observer.on_change panicked; skipping");
    }
}
```

Apply the same `catch_unwind` wrap to the funnel claim-listener invocation in `funnel/client.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue observer::panic_tests 2>&1 | tail -10`
Expected: PASS — no unwind, `Counter` ran once.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/observer.rs packages/core-rs/src/funnel/client.rs
git commit -m "fix(sdk-core): catch_unwind around foreign observer/listener callbacks"
```

---

## Task 4: FFI surface + binding regeneration

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`
- Run: `./packages/core-rs/scripts/build-bindings.sh`

**Interfaces:**
- Produces (across FFI): `enum ErrorKind`; rich `[Error] interface RovenueError { Generic(ErrorKind kind, string message, string? server_code, u16? http_status, boolean retryable); }`. Façade tasks (5–7) consume the generated `RovenueError`/`RovenueException` rich case.

- [ ] **Step 1: Edit the UDL**

In `packages/core-rs/src/librovenue.udl`, replace the existing flat `[Error] enum RovenueError {…}` with:

```idl
enum ErrorKind {
  "NetworkUnavailable", "Timeout", "RateLimited", "ServerError",
  "InvalidApiKey", "Forbidden", "NotFound", "InvalidRequest", "Conflict", "InvalidArgument",
  "InsufficientCredits", "FunnelTokenNotFound", "FunnelTokenExpired", "FunnelTokenAlreadyClaimed",
  "PurchaseCanceled", "ProductNotAvailable", "AlreadyOwned", "PaymentDeclined",
  "StoreServiceUnavailable", "Ineligible", "ReceiptInvalid", "StoreProblem",
  "Storage", "Internal"
};

[Error]
interface RovenueError {
  Generic(ErrorKind kind, string message, string? server_code, u16? http_status, boolean retryable);
};
```

Then make the Rust `RovenueError` match the UDL's `interface` (rich) error shape. UDL `[Error] interface` expects a Rust enum whose variant carries the fields. Add a uniffi-facing enum that wraps the struct:

```rust
// At the FFI boundary uniffi needs a single rich variant. Keep the ergonomic
// struct internally; expose it as the Generic variant.
#[derive(Debug, Clone)]
pub enum RovenueErrorFfi {
    Generic { kind: ErrorKind, message: String, server_code: Option<String>,
              http_status: Option<u16>, retryable: bool },
}
impl From<RovenueError> for RovenueErrorFfi {
    fn from(e: RovenueError) -> Self {
        RovenueErrorFfi::Generic { kind: e.kind, message: e.message,
            server_code: e.server_code, http_status: e.http_status, retryable: e.retryable }
    }
}
```

If the UDL `interface RovenueError` maps directly onto a Rust type named `RovenueError`, instead make `RovenueError` itself the enum with one `Generic{…}` variant and provide the `kind()`/`http()` constructors returning that variant (adjust Task 1's struct to a single-variant enum if the generator requires the type names to match). Decide based on what `build-bindings.sh` accepts.

- [ ] **Step 2: Regenerate bindings + confirm core builds**

Run:
```bash
./packages/core-rs/scripts/build-bindings.sh 2>&1 | tail -15
ls packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift
ls packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt
```
Expected: "bindings generated"; both generated files present. Inspect the generated `RovenueError` (Swift) / `RovenueException` (Kotlin) to confirm the `Generic` case carries `kind/message/serverCode/httpStatus/retryable`. **This is the risk checkpoint from spec §13** — if the generated shape is unworkable, adjust the UDL (e.g. flatten to a struct return + sentinel) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add packages/core-rs/src/librovenue.udl packages/core-rs/src/error.rs
git commit -m "feat(sdk-core): export ErrorKind + rich RovenueError across the FFI"
```

(The generated files are gitignored — only the UDL + Rust source are committed.)

---

## Task 5: Kotlin single error type + typed store outcomes + concurrency guard

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/RovenueException.kt`
- Modify: `.../sdk/Types.kt` (remove the 4 standalone purchase exceptions), `.../sdk/Rovenue.kt`, `.../internal/PlayStore.kt`, `.../internal/PlayBillingStore.kt`, `.../internal/PlayPurchaseFlow.kt`
- Test: `.../src/test/.../ErrorMappingTest.kt`, extend `PlayPurchaseFlow` tests

**Interfaces:**
- Consumes: generated `RovenueException.Generic(kind, message, serverCode, httpStatus, retryable)` (Task 4); generated `ErrorKind`.
- Produces: public `class RovenueException(val kind: ErrorKind, override val message: String, val serverCode: String?, val httpStatus: Int?, val isRetryable: Boolean) : Exception(message)`; `sealed interface StorePurchaseOutcome` gains `AlreadyOwned`, `PaymentDeclined`, `ServiceUnavailable`, `Ineligible`, `Deferred`.

- [ ] **Step 1: Write the failing test**

Create `ErrorMappingTest.kt`:

```kotlin
class ErrorMappingTest {
    @Test fun `play response codes map to typed outcomes`() {
        assertEquals(StorePurchaseOutcome.AlreadyOwned,
            mapBillingCode(BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED, null))
        assertEquals(StorePurchaseOutcome.ServiceUnavailable,
            mapBillingCode(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, null))
    }
    @Test fun `pending is Deferred not an exception`() {
        assertEquals(StorePurchaseOutcome.Deferred,
            mapBillingCode(BillingClient.BillingResponseCode.OK, Purchase.PurchaseState.PENDING))
    }
}
```

(Extract the listener's `when` into a testable `internal fun mapBillingCode(code: Int, state: Int?): StorePurchaseOutcome` so it can be unit-tested without a live BillingClient.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests '*ErrorMappingTest*' 2>&1 | tail -20`
Expected: FAIL — `mapBillingCode` / `StorePurchaseOutcome.AlreadyOwned` don't exist.

- [ ] **Step 3: Add the outcomes + mapping**

In `PlayStore.kt` `sealed interface StorePurchaseOutcome`, add `object AlreadyOwned`, `object PaymentDeclined`, `object ServiceUnavailable`, `object Ineligible`, `object Deferred`. In `PlayBillingStore.kt` extract:

```kotlin
internal fun mapBillingCode(code: Int, state: Int?): StorePurchaseOutcome = when (code) {
    BillingClient.BillingResponseCode.OK -> when (state) {
        Purchase.PurchaseState.PURCHASED -> StorePurchaseOutcome.Pending // replaced by successFor at call site
        Purchase.PurchaseState.PENDING -> StorePurchaseOutcome.Deferred
        else -> StorePurchaseOutcome.Deferred
    }
    BillingClient.BillingResponseCode.USER_CANCELED -> StorePurchaseOutcome.UserCancelled
    BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> StorePurchaseOutcome.ProductNotFound
    BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> StorePurchaseOutcome.AlreadyOwned
    BillingClient.BillingResponseCode.SERVICE_DISCONNECTED,
    BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
    BillingClient.BillingResponseCode.BILLING_UNAVAILABLE,
    BillingClient.BillingResponseCode.NETWORK_ERROR -> StorePurchaseOutcome.ServiceUnavailable
    else -> StorePurchaseOutcome.StoreProblem // see step 4 for PBL9 sub-response codes
}
```

Wire the live `purchasesListener` to call `mapBillingCode` (keeping `successFor(purchase)` for the PURCHASED branch), and add a `StoreProblem` outcome object if not present.

- [ ] **Step 4: Handle PBL9 sub-response codes + concurrency guard**

In the listener, before falling to `else`, inspect `result.onPurchasesUpdatedSubResponseCode` (PBL9): `PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS` → `PaymentDeclined`, `USER_INELIGIBLE` → `Ineligible`. Add the concurrency guard in `purchase()`:

```kotlin
if (pending != null) return StorePurchaseOutcome.StoreProblem // a purchase is already in flight
```

(Place the check at the top of `purchase()` before `connect()`. Reject-with-clear-outcome per spec §13.)

- [ ] **Step 5: Run store-mapping test to verify it passes**

Run: `./gradlew testDebugUnitTest --tests '*ErrorMappingTest*' 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Replace the exception hierarchy**

Create `RovenueException.kt`:

```kotlin
package dev.rovenue.sdk
import dev.rovenue.sdk.generated.ErrorKind
class RovenueException(
    val kind: ErrorKind,
    override val message: String,
    val serverCode: String?,
    val httpStatus: Int?,
    val isRetryable: Boolean,
) : Exception(message)
```

Delete the 4 standalone purchase exceptions from `Types.kt`. In `Rovenue.kt`, catch the generated `RovenueException.Generic(...)` and rethrow the new public `RovenueException(kind, message, serverCode, httpStatus, retryable)`. In `PlayPurchaseFlow.kt`, map outcomes to the new exception (`PurchaseCanceled` → `RovenueException(kind=PurchaseCanceled,…)`, `Deferred` → return a deferred `PurchaseResult`, not throw).

- [ ] **Step 7: Verify full suite**

Run: `./gradlew testDebugUnitTest --rerun-tasks 2>&1 | tail -5` then tally the JUnit XML (`build/test-results/testDebugUnitTest/*.xml`).
Expected: BUILD SUCCESSFUL, 0 failures. Update any test that referenced the deleted purchase exceptions.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin
git commit -m "feat(sdk-kotlin): single RovenueException + typed store outcomes + concurrency guard"
```

---

## Task 6: Swift single error type + StoreKit mapping + Deferred

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Errors.swift`, `Rovenue.swift`, `Internal/AppleStore.swift`, `Internal/ApplePurchaseFlow.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/ErrorMappingTests.swift`

**Interfaces:**
- Consumes: generated `RovenueError.generic(kind:message:serverCode:httpStatus:retryable:)` + `ErrorKind` (Task 4).
- Produces: `public struct RovenueError: Error, LocalizedError { public let kind: ErrorKind; public let message: String; public let serverCode: String?; public let httpStatus: Int?; public var isRetryable: Bool }`; `StorePurchaseOutcome` gains `.alreadyOwned`, `.paymentDeclined`, `.serviceUnavailable`, `.ineligible`, `.deferred`.

- [ ] **Step 1: Write the failing test**

Create `ErrorMappingTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class ErrorMappingTests: XCTestCase {
    func testRetryableDerivation() {
        XCTAssertTrue(RovenueError(kind: .timeout, message: "", serverCode: nil, httpStatus: nil).isRetryable)
        XCTAssertFalse(RovenueError(kind: .forbidden, message: "", serverCode: nil, httpStatus: nil).isRetryable)
    }
    func testCarriesServerCode() {
        let e = RovenueError(kind: .forbidden, message: "no", serverCode: "FORBIDDEN", httpStatus: 403)
        XCTAssertEqual(e.serverCode, "FORBIDDEN"); XCTAssertEqual(e.httpStatus, 403)
        XCTAssertEqual(e.errorDescription, "no")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && ./packages/core-rs/scripts/build-bindings.sh >/dev/null 2>&1; export DYLD_LIBRARY_PATH="$PWD/../../target/release"; swift test --filter ErrorMappingTests 2>&1 | tail -20`
Expected: FAIL — the new `RovenueError` struct / `isRetryable` don't exist (current `Rovenue.Error` is an enum).

- [ ] **Step 3: Replace `Rovenue.Error` with the struct**

Rewrite `Errors.swift`:

```swift
import Foundation

public struct RovenueError: Error, LocalizedError, Equatable, Sendable {
    public let kind: ErrorKind
    public let message: String
    public let serverCode: String?
    public let httpStatus: Int?
    public init(kind: ErrorKind, message: String, serverCode: String? = nil, httpStatus: Int? = nil) {
        self.kind = kind; self.message = message; self.serverCode = serverCode; self.httpStatus = httpStatus
    }
    public var isRetryable: Bool {
        switch kind {
        case .networkUnavailable, .timeout, .rateLimited, .serverError, .storeServiceUnavailable: return true
        default: return false
        }
    }
    public var errorDescription: String? { message }
}

// Map the generated FFI error into the public struct.
func mapError(_ e: RovenueFFI.RovenueError) -> RovenueError {  // generated type
    switch e {
    case let .generic(kind, message, serverCode, httpStatus, _):
        return RovenueError(kind: kind, message: message,
                            serverCode: serverCode, httpStatus: httpStatus.map(Int.init))
    }
}
```

Replace every `throw mapError(err)` site to use the new mapper; delete the old enum + its `errorDescription` switch.

- [ ] **Step 4: StoreKit outcome mapping + Deferred**

In `AppleStore.swift`, add `.alreadyOwned`, `.paymentDeclined`, `.serviceUnavailable`, `.ineligible`, `.deferred` to `StorePurchaseOutcome`, and replace the bare `catch { throw .storeProblem }` with:

```swift
} catch let skErr as StoreKitError {
    switch skErr {
    case .networkError, .systemError: return .serviceUnavailable
    case .notAvailableInStorefront: return .productNotFound
    default: throw RovenueError(kind: .storeProblem, message: "\(skErr)")
    }
} catch let pErr as Product.PurchaseError {
    switch pErr {
    case .ineligibleForOffer, .invalidQuantity, .productUnavailable: return .ineligible
    default: throw RovenueError(kind: .storeProblem, message: "\(pErr)")
    }
}
```

In `ApplePurchaseFlow.swift`, map `.pending` → return a deferred `PurchaseResult` (do not throw `.purchasePending`), `.userCancelled` → throw `RovenueError(kind: .purchaseCanceled, …)`, `.success(.unverified)` → throw `.receiptInvalid`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `swift test --filter ErrorMappingTests 2>&1 | tail -10` then `swift test 2>&1 | tail -15`
Expected: PASS; full suite green (update tests referencing the old enum cases).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources packages/sdk-swift/Tests
git commit -m "feat(sdk-swift): single RovenueError struct + typed StoreKit outcomes + Deferred"
```

---

## Task 7: RN single error class + bridge pass-through

**Files:**
- Modify: `packages/sdk-rn/src/errors.ts`, `packages/sdk-rn/src/core/native.ts`, `packages/sdk-rn/ios/RovenueModule.swift`, `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
- Test: rewrite `packages/sdk-rn/src/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: native errors carrying `code` (= `ErrorKind` string) + `message` + `extras` (`serverCode`, `httpStatus`, `retryable`, `available`, `retryAfter`).
- Produces: `export type ErrorKind = 'NetworkUnavailable' | … | 'Internal'`; `export class RovenueError extends Error { kind; serverCode?; httpStatus?; isRetryable; data? }`; `export function mapNativeError(code, message, extras): RovenueError`.

- [ ] **Step 1: Write the failing test**

Rewrite `errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RovenueError, mapNativeError, ERROR_KINDS } from "../errors";

describe("RN unified error", () => {
  it("maps a known kind with carried fields", () => {
    const e = mapNativeError("Forbidden", "no access",
      { serverCode: "FORBIDDEN", httpStatus: 403, retryable: false });
    expect(e).toBeInstanceOf(RovenueError);
    expect(e.kind).toBe("Forbidden");
    expect(e.serverCode).toBe("FORBIDDEN");
    expect(e.httpStatus).toBe(403);
    expect(e.isRetryable).toBe(false);
  });
  it("preserves serverCode even for an unknown kind", () => {
    const e = mapNativeError("SomethingNew", "msg", { serverCode: "X" });
    expect(e.kind).toBe("Internal");      // normalized fallback
    expect(e.serverCode).toBe("X");        // but nothing lost
  });
  it("derives isRetryable from kind when native omits it", () => {
    expect(mapNativeError("Timeout", "t", {}).isRetryable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/react-native-sdk test errors 2>&1 | tail -20`
Expected: FAIL — `RovenueError.kind` / `ERROR_KINDS` not present (old file has 22 subclasses).

- [ ] **Step 3: Rewrite `errors.ts`**

```ts
export const ERROR_KINDS = [
  "NetworkUnavailable","Timeout","RateLimited","ServerError",
  "InvalidApiKey","Forbidden","NotFound","InvalidRequest","Conflict","InvalidArgument",
  "InsufficientCredits","FunnelTokenNotFound","FunnelTokenExpired","FunnelTokenAlreadyClaimed",
  "PurchaseCanceled","ProductNotAvailable","AlreadyOwned","PaymentDeclined",
  "StoreServiceUnavailable","Ineligible","ReceiptInvalid","StoreProblem","Storage","Internal",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const RETRYABLE = new Set<ErrorKind>(["NetworkUnavailable","Timeout","RateLimited","ServerError","StoreServiceUnavailable"]);

export interface ErrorExtras { serverCode?: string; httpStatus?: number; retryable?: boolean; available?: number; retryAfter?: number; }

export class RovenueError extends Error {
  readonly kind: ErrorKind;
  readonly serverCode?: string;
  readonly httpStatus?: number;
  readonly isRetryable: boolean;
  readonly data?: { available?: number; retryAfter?: number };
  constructor(kind: ErrorKind, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = "RovenueError";
    Object.setPrototypeOf(this, RovenueError.prototype);
    this.kind = kind;
    this.serverCode = extras.serverCode;
    this.httpStatus = extras.httpStatus;
    this.isRetryable = extras.retryable ?? RETRYABLE.has(kind);
    if (extras.available !== undefined || extras.retryAfter !== undefined) {
      this.data = { available: extras.available, retryAfter: extras.retryAfter };
    }
  }
}

export function mapNativeError(code: string, message: string, extras: ErrorExtras = {}): RovenueError {
  const kind = (ERROR_KINDS as readonly string[]).includes(code) ? (code as ErrorKind) : "Internal";
  return new RovenueError(kind, message, extras);
}
```

- [ ] **Step 4: Update the bridge wrapper + native modules**

In `core/native.ts` (and `api/funnel.ts`, `api/events.ts` `call<T>()`), keep `catch (e) { if (e?.code) throw mapNativeError(e.code, e.message, e.extras ?? {}); throw e; }`. In `ios/RovenueModule.swift` and `android/.../RovenueModule.kt`, when rethrowing a core error, attach `kind` as the code and `serverCode`/`httpStatus`/`retryable` in the Expo error's `extras`/userInfo — for ALL errors, not just purchase/funnel (read these off the new `RovenueError` struct / `RovenueException`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rovenue/react-native-sdk test 2>&1 | tail -10`
Expected: PASS. Update any other test importing the removed subclasses.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src packages/sdk-rn/ios packages/sdk-rn/android
git commit -m "feat(sdk-rn): single RovenueError class with kind + carried fields"
```

---

## Task 8: Error-taxonomy parity test + 0.16.0 bump + docs

**Files:**
- Create: `packages/sdk-rn/src/__tests__/error-taxonomy-parity.test.ts`
- Modify: root `Cargo.toml`, `sdk-rn/package.json`, `sdk-rn/src/version.ts`, `sdk-kotlin/build.gradle.kts`, `sdk-swift/Rovenue.podspec`
- Modify: each package `CHANGELOG.md` (create if absent), `apps/docs/content/docs/.../error-handling.mdx` (or the nearest existing error doc)

**Interfaces:**
- Consumes: `ERROR_KINDS` (Task 7) + the UDL `ErrorKind` (Task 4) + generated Kotlin/Swift `ErrorKind`.

- [ ] **Step 1: Write the parity test**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_KINDS } from "../errors";

describe("ErrorKind parity across façades", () => {
  it("RN ERROR_KINDS matches the UDL ErrorKind enum", () => {
    const udl = readFileSync(join(__dirname, "../../../core-rs/src/librovenue.udl"), "utf8");
    const block = udl.match(/enum ErrorKind \{([\s\S]*?)\};/)![1];
    const udlKinds = [...block.matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]).sort();
    expect([...ERROR_KINDS].sort()).toEqual(udlKinds);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @rovenue/react-native-sdk test error-taxonomy-parity 2>&1 | tail -10`
Expected: PASS (if it fails, reconcile the mismatched names — that IS the test doing its job).

- [ ] **Step 3: Bump versions to 0.16.0**

Edit the five strings: root `Cargo.toml` `[workspace.package] version = "0.16.0"`; `sdk-rn/package.json` `"version": "0.16.0"`; `sdk-rn/src/version.ts` `SDK_VERSION = "0.16.0"`; `sdk-kotlin/build.gradle.kts` `version = "0.16.0"`; `sdk-swift/Rovenue.podspec` `s.version = '0.16.0'`.

- [ ] **Step 4: Run the version parity test**

Run: `pnpm --filter @rovenue/react-native-sdk test version 2>&1 | tail -10`
Expected: PASS (all four aligned at 0.16.0).

- [ ] **Step 5: Write CHANGELOG + migration docs**

Add a `## 0.16.0` entry to each package CHANGELOG documenting the breaking error API (single `RovenueError`/`RovenueException` with `kind`; removed Swift enum cases / Kotlin purchase exceptions / RN subclasses; `.pending` → `Deferred`; new `kind`s). Add a migration section to the docs error page: `catch (e) { if (e instanceof InsufficientCreditsError) … }` → `catch (e) { if (e.kind === "InsufficientCredits") … }`, and handling the `Deferred` purchase state.

- [ ] **Step 6: Full verification + commit**

Run, in order:
```bash
cd packages/core-rs && cargo test -p librovenue 2>&1 | grep "test result"
cargo fmt --check && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3
cd ../sdk-kotlin && ./gradlew testDebugUnitTest --rerun-tasks 2>&1 | tail -3
cd ../sdk-rn && pnpm --filter @rovenue/react-native-sdk test 2>&1 | tail -5
```
Expected: all green; clippy/fmt clean.

```bash
git add Cargo.toml packages/sdk-rn packages/sdk-kotlin/build.gradle.kts packages/sdk-swift/Rovenue.podspec docs/ packages/*/CHANGELOG.md
git commit -m "chore(sdk): error-taxonomy parity test + 0.16.0 bump + migration docs"
```

---

## Self-Review

**Spec coverage:** §4 taxonomy → Tasks 1,4. §4.2 carried fields → Tasks 1,2. §5 façade exposure → Tasks 5,6,7. §6 transport → Task 2. §7 store mapping + Deferred → Tasks 5,6. §8 catch_unwind + concurrency → Tasks 3,5. §9 testing → every task + Task 8 parity. §10 versioning/docs → Task 8. All sections covered.

**Type consistency:** `ErrorKind` variant names are identical across the UDL (Task 4), Rust (Task 1), Swift `.camelCase` (Task 6, via generated mapping), Kotlin (Task 5), RN string union (Task 7), and the parity test (Task 8) enforces it. `RovenueError` fields (`kind`, `message`, `serverCode`, `httpStatus`, `isRetryable`/`retryable`) consistent across tasks. `StorePurchaseOutcome` additions (`AlreadyOwned`/`PaymentDeclined`/`ServiceUnavailable`/`Ineligible`/`Deferred`) used consistently in Tasks 5–6.

**Open risk (carried from spec §13):** the exact UniFFI rich-error shape (Task 4 Step 2) must be validated by regenerating bindings before Tasks 5–7; if the generator rejects the `interface RovenueError { Generic(...) }` form, adjust the UDL there and the downstream mappers follow the same field set.
