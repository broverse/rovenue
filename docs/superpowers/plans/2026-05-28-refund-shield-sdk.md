# Refund Shield SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Refund Shield's required SDK behaviors across all four SDK layers — (1) stable per-subscriber tokens that the host app passes to Apple `Product.purchase(options:)` and Google `BillingFlowParams.Builder.setObfuscatedAccountId/ProfileId`, and (2) per-app-session telemetry (open/background/close events) batched and POSTed to `POST /v1/sdk/sessions` — so the backend (Plan 1) can decode `appAccountToken` from JWS, attribute refunds, and aggregate session signals for bucket mapping.

**Architecture:** The Rust core (`packages/core-rs`) gains a session-event buffer + flush worker and stable-token storage in its existing `CacheStore`. UniFFI exposes new functions to the Swift and Kotlin façades, which add thin passthrough methods. The RN TS façade adds two internal modules — `accountToken.ts` (lazy stable UUID via the Rust core's storage) and `sessionTracker.ts` (React Native `AppState` subscriber) — and surfaces a `getAppAccountToken()` helper plus a single new public `purchase()`-style method that does NOT call StoreKit/Play Billing directly (consumers still own the store call) but supplies the token in `postAppleReceipt` / `postGoogleReceipt`.

**Tech Stack:** Rust + UniFFI (core), Swift 5.9 + StoreKit2 (iOS façade), Kotlin 1.9 + Play Billing 6 (Android façade), TypeScript + Expo Modules + RN `AppState` (RN façade). Vitest + cargo test + XCTest + JUnit5.

**Spec:** `docs/superpowers/specs/2026-05-28-refund-shield-design.md` §7

**Important architectural note (spec gap):** The current SDK does NOT invoke StoreKit2 `Product.purchase()` or Play Billing `launchBillingFlow()` — the host app does. The spec's §3 Pipeline 1 step 1 ("SDK calls StoreKit2 `Product.purchase(options:)`") is aspirational; today the SDK only validates the resulting JWS / purchase token. This plan therefore:
- Exposes `getAppAccountToken()` so the host app can read the stable UUID and pass it to `Product.purchase(options: [.appAccountToken(uuid)])` (iOS) or `BillingFlowParams.Builder.setObfuscatedAccountId(...)` (Android) itself.
- Extends `postAppleReceipt` / `postGoogleReceipt` to accept the same token as a sanity-check passthrough (kept server-side as a cross-reference if the JWS-decoded `appAccountToken` is missing).
- Leaves a follow-up note: a future plan may add a wrapping `purchase()` API that internally calls the native store.

**Out of scope:**
- Backend ingest endpoint `POST /v1/sdk/sessions` and webhook JWS persistence of `appAccountToken` — both ship in Plan 1 (`docs/superpowers/plans/2026-05-28-refund-shield-backend.md`).
- Dashboard UI surfaces — Plan 3.
- SDK wrapping `purchase()` that calls StoreKit/Play Billing directly — separate future spec.
- Pure-native iOS / Kotlin lifecycle observers (`NotificationCenter UIApplication.willEnterForeground`, `ProcessLifecycleOwner`) — RN `AppState` covers the v1 consumer path; pure-Swift / pure-Kotlin consumers get the helper API but no automatic session tracking until v2.

---

## File Inventory

### Phase 1 — librovenue Rust core (`packages/core-rs/`)

**New files:**
- `packages/core-rs/src/sessions/mod.rs`
- `packages/core-rs/src/sessions/buffer.rs`
- `packages/core-rs/src/sessions/dispatcher.rs`
- `packages/core-rs/src/sessions/account_token.rs`

**Modified files:**
- `packages/core-rs/src/librovenue.udl` — add `SessionEventKind` enum + `record_session_event`, `flush_session_events`, `get_or_create_app_account_token` methods on `RovenueCore`
- `packages/core-rs/src/lib.rs` — declare `pub mod sessions;` and re-exports
- `packages/core-rs/src/api.rs` — wire session manager into `RovenueCore::from_store`
- `packages/core-rs/src/cache/schema.rs` — add `app_account_tokens` and `session_events` tables to the SQLite migration
- `packages/core-rs/src/cache/store.rs` — DAO methods for the new tables
- `packages/core-rs/src/transport/api.rs` — add `post_sessions(events)` HTTP call
- `packages/core-rs/src/version.rs` — bump `SDK_VERSION` from `0.5.x` → `0.6.0`

### Phase 2 — Swift façade (`packages/sdk-swift/`)

**Modified files:**
- `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` — add `getAppAccountToken()`, extend `postAppleReceipt(jws:productId:appAccountToken:)` signature
- `packages/sdk-swift/Sources/Rovenue/Types.swift` — re-export `SessionEventKind` if surfaced
- `packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift` — extend existing happy-path coverage
- `packages/sdk-swift/Package.swift` / `packages/sdk-swift/Rovenue.podspec` — bump version to `0.6.0`

**New files:**
- `packages/sdk-swift/Tests/RovenueTests/AppAccountTokenTests.swift`
- `packages/sdk-swift/Tests/RovenueTests/PostReceiptWithTokenTests.swift`

### Phase 3 — Kotlin façade (`packages/sdk-kotlin/`)

**Modified files:**
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — add `getAppAccountToken()`, extend `postGoogleReceipt(receipt:productId:obfuscatedAccountId:obfuscatedProfileId:)`
- `packages/sdk-kotlin/build.gradle.kts` — bump version to `0.6.0`

**New files:**
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/AppAccountTokenTest.kt`
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PostReceiptWithTokenTest.kt`

### Phase 4 — RN TS façade (`packages/sdk-rn/`)

**New files:**
- `packages/sdk-rn/src/api/accountToken.ts`
- `packages/sdk-rn/src/api/sessionTracker.ts`
- `packages/sdk-rn/src/__tests__/accountToken.test.ts`
- `packages/sdk-rn/src/__tests__/sessionTracker.test.ts`

**Modified files:**
- `packages/sdk-rn/src/index.ts` — export `getAppAccountToken`, wire `startSessionTracker` into `configure()`/`shutdown()`, extend receipts API surface
- `packages/sdk-rn/src/specs/RovenueModule.types.ts` — add `getAppAccountToken`, `recordSessionEvent`, `flushSessionEvents`, and extended receipt signatures
- `packages/sdk-rn/src/api/receipts.ts` — accept optional token in `postAppleReceipt` / `postGoogleReceipt`
- `packages/sdk-rn/src/api/configure.ts` — start session tracker after configure
- `packages/sdk-rn/src/api/lifecycle.ts` — stop session tracker on `shutdown()`
- `packages/sdk-rn/src/__tests__/_mockNative.ts` — extend the mock spec
- `packages/sdk-rn/ios/RovenueModule.swift` — add `getAppAccountToken`, `recordSessionEvent`, `flushSessionEvents` bridge functions
- `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` — same
- `packages/sdk-rn/package.json` — bump version to `0.2.0`

---

# Phase 1 — librovenue Rust core

Goal: extend the Rust core with (a) a process-stable per-subscriber app-account-token persisted in the existing SQLite `CacheStore`, and (b) a 1000-event FIFO session-event buffer with a 30s flush worker that POSTs to the backend session ingest. All exposed via UniFFI to Swift + Kotlin.

---

## Task 1: SQLite schema — `app_account_tokens` + `session_events` tables

**Files:**
- Modify: `packages/core-rs/src/cache/schema.rs`
- Modify: `packages/core-rs/src/cache/store.rs`

- [ ] **Step 1.1: Write the failing test**

Append to `packages/core-rs/src/cache/store.rs`'s existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn app_account_tokens_table_round_trip() {
    let store = CacheStore::open_in_memory().unwrap();
    let scope = "subscriber-abc";
    // Returns None when empty.
    assert_eq!(store.get_app_account_token(scope).unwrap(), None);
    // Insert + read back.
    store.put_app_account_token(scope, "550e8400-e29b-41d4-a716-446655440000").unwrap();
    assert_eq!(
        store.get_app_account_token(scope).unwrap(),
        Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
    );
    // Idempotent: re-insert same scope is a no-op (does not overwrite).
    store.put_app_account_token(scope, "different-uuid").unwrap();
    assert_eq!(
        store.get_app_account_token(scope).unwrap(),
        Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
    );
}

#[test]
fn session_events_fifo_drop_at_cap() {
    let store = CacheStore::open_in_memory().unwrap();
    for i in 0..1005 {
        store.append_session_event(
            "open",
            &format!("2026-05-28T10:00:{:02}Z", i % 60),
            None,
        ).unwrap();
    }
    let rows = store.list_session_events(2000).unwrap();
    // FIFO drop: at cap 1000, the oldest 5 are gone — newest 1000 remain.
    assert_eq!(rows.len(), 1000);
    // Cleared on flush.
    let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
    store.delete_session_events(&ids).unwrap();
    assert_eq!(store.list_session_events(2000).unwrap().len(), 0);
}
```

- [ ] **Step 1.2: Run test — expect failure**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml app_account_tokens_table_round_trip session_events_fifo_drop_at_cap`
Expected: FAIL — methods don't exist.

- [ ] **Step 1.3: Add tables to schema**

In `packages/core-rs/src/cache/schema.rs` (or wherever the existing `CREATE TABLE` migrations live — inspect the existing `entitlements`/`credits` table DDL first), append:

```rust
pub const APP_ACCOUNT_TOKENS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS app_account_tokens (
    scope TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"#;

pub const SESSION_EVENTS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_events_id ON session_events(id);
"#;
```

Register both with the existing migration runner (look at how `ENTITLEMENTS_DDL` is invoked in `CacheStore::open`/`open_in_memory`).

- [ ] **Step 1.4: Add DAO methods to `store.rs`**

```rust
impl CacheStore {
    pub fn get_app_account_token(&self, scope: &str) -> RovenueResult<Option<String>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT token FROM app_account_tokens WHERE scope = ?1",
            [scope],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| RovenueError::Storage)
    }

    pub fn put_app_account_token(&self, scope: &str, token: &str) -> RovenueResult<()> {
        let conn = self.conn.lock();
        // INSERT OR IGNORE so the first writer wins — idempotent.
        conn.execute(
            "INSERT OR IGNORE INTO app_account_tokens (scope, token, created_at) \
             VALUES (?1, ?2, datetime('now'))",
            [scope, token],
        ).map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn append_session_event(
        &self,
        kind: &str,
        occurred_at: &str,
        duration_ms: Option<u32>,
    ) -> RovenueResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO session_events (kind, occurred_at, duration_ms) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![kind, occurred_at, duration_ms],
        ).map_err(|_| RovenueError::Storage)?;
        // FIFO trim — keep newest 1000.
        conn.execute(
            "DELETE FROM session_events WHERE id NOT IN \
             (SELECT id FROM session_events ORDER BY id DESC LIMIT 1000)",
            [],
        ).map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn list_session_events(&self, limit: usize) -> RovenueResult<Vec<SessionEventRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, kind, occurred_at, duration_ms FROM session_events \
                      ORDER BY id ASC LIMIT ?1")
            .map_err(|_| RovenueError::Storage)?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(SessionEventRow {
                    id: r.get(0)?,
                    kind: r.get(0)?,        // typo placeholder — replace with correct index
                    occurred_at: r.get(2)?,
                    duration_ms: r.get(3)?,
                })
            })
            .map_err(|_| RovenueError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| RovenueError::Storage)?;
        Ok(rows)
    }

    pub fn delete_session_events(&self, ids: &[i64]) -> RovenueResult<()> {
        if ids.is_empty() { return Ok(()); }
        let conn = self.conn.lock();
        let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM session_events WHERE id IN ({})", placeholders);
        let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice()).map_err(|_| RovenueError::Storage)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SessionEventRow {
    pub id: i64,
    pub kind: String,
    pub occurred_at: String,
    pub duration_ms: Option<u32>,
}
```

(Note: the inline snippet above has an intentional typo flag `r.get(0)?` for `kind` — fix to `r.get(1)?` during implementation.)

- [ ] **Step 1.5: Run tests to confirm pass**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml --lib cache::`
Expected: All green, including the two new tests.

- [ ] **Step 1.6: Commit**

```bash
git add packages/core-rs/src/cache/
git commit -m "feat(core-rs): add app_account_tokens + session_events tables to cache"
```

---

## Task 2: `SessionManager` — buffer + flush worker

**Files:**
- Create: `packages/core-rs/src/sessions/mod.rs`
- Create: `packages/core-rs/src/sessions/buffer.rs`
- Create: `packages/core-rs/src/sessions/dispatcher.rs`
- Modify: `packages/core-rs/src/lib.rs`
- Modify: `packages/core-rs/src/transport/api.rs`

- [ ] **Step 2.1: Write the failing test**

Create `packages/core-rs/src/sessions/buffer.rs` with a test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::CacheStore;
    use std::sync::Arc;

    #[test]
    fn record_appends_to_store() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = SessionBuffer::new(Arc::clone(&store));
        buf.record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None).unwrap();
        buf.record(SessionEventKind::Background, "2026-05-28T10:05:00Z", Some(300_000)).unwrap();
        let rows = store.list_session_events(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, "open");
        assert_eq!(rows[1].kind, "background");
        assert_eq!(rows[1].duration_ms, Some(300_000));
    }

    #[test]
    fn drain_returns_and_deletes() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = SessionBuffer::new(Arc::clone(&store));
        buf.record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None).unwrap();
        let drained = buf.drain(100).unwrap();
        assert_eq!(drained.len(), 1);
        assert_eq!(store.list_session_events(10).unwrap().len(), 0);
    }
}
```

- [ ] **Step 2.2: Run — expect compile failure (module missing)**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml sessions::buffer`
Expected: FAIL — `sessions` module not declared.

- [ ] **Step 2.3: Implement `SessionEventKind` + `SessionBuffer`**

`packages/core-rs/src/sessions/mod.rs`:
```rust
pub mod buffer;
pub mod dispatcher;
pub mod account_token;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventKind {
    Open,
    Background,
    Close,
}

impl SessionEventKind {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Background => "background",
            Self::Close => "close",
        }
    }
}
```

`packages/core-rs/src/sessions/buffer.rs`:
```rust
use std::sync::Arc;
use crate::cache::CacheStore;
use crate::cache::store::SessionEventRow;
use crate::error::RovenueResult;
use super::SessionEventKind;

pub struct SessionBuffer {
    store: Arc<CacheStore>,
}

impl SessionBuffer {
    pub fn new(store: Arc<CacheStore>) -> Self { Self { store } }

    pub fn record(
        &self,
        kind: SessionEventKind,
        occurred_at: &str,
        duration_ms: Option<u32>,
    ) -> RovenueResult<()> {
        self.store.append_session_event(kind.as_wire(), occurred_at, duration_ms)
    }

    pub fn drain(&self, limit: usize) -> RovenueResult<Vec<SessionEventRow>> {
        let rows = self.store.list_session_events(limit)?;
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        self.store.delete_session_events(&ids)?;
        Ok(rows)
    }
}
```

`packages/core-rs/src/sessions/dispatcher.rs`:
```rust
use std::sync::Arc;
use std::time::Duration;
use crate::error::RovenueResult;
use crate::transport::http_client::HttpClient;
use crate::polling::PollingScheduler;
use super::buffer::SessionBuffer;

pub struct SessionDispatcher {
    buffer: Arc<SessionBuffer>,
    http: Arc<HttpClient>,
    subscriber_id_provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

impl SessionDispatcher {
    pub fn new(
        buffer: Arc<SessionBuffer>,
        http: Arc<HttpClient>,
        subscriber_id_provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self { Self { buffer, http, subscriber_id_provider } }

    /// Drain up to 200 events and POST to /v1/sdk/sessions. On error,
    /// re-append is NOT attempted (telemetry is best-effort; dropping
    /// is preferable to unbounded retry on a flaky network).
    pub fn flush_once(&self) -> RovenueResult<usize> {
        let Some(sub_id) = (self.subscriber_id_provider)() else { return Ok(0); };
        let rows = self.buffer.drain(200)?;
        if rows.is_empty() { return Ok(0); }
        let events: Vec<_> = rows.iter().map(|r| serde_json::json!({
            "type": r.kind,
            "occurredAt": r.occurred_at,
            "durationMs": r.duration_ms,
            "appVersion": "",   // populated by façades before flush — see Task 5
            "sdkVersion": crate::version::SDK_VERSION,
        })).collect();
        let _ = self.http.post_sessions(&sub_id, &events);
        Ok(rows.len())
    }

    pub fn start(self: Arc<Self>, scheduler: &PollingScheduler) {
        let me = Arc::clone(&self);
        scheduler.register("sessions", Duration::from_secs(30), move || {
            let _ = me.flush_once();
        });
    }
}
```

- [ ] **Step 2.4: Wire `lib.rs`**

In `packages/core-rs/src/lib.rs`, add `pub mod sessions;` next to the other modules and re-export `pub use sessions::SessionEventKind;`.

- [ ] **Step 2.5: Add `HttpClient::post_sessions`**

In `packages/core-rs/src/transport/api.rs`, add a method:
```rust
pub fn post_sessions(
    &self,
    subscriber_id: &str,
    events: &[serde_json::Value],
) -> RovenueResult<()> {
    let body = serde_json::json!({ "subscriberId": subscriber_id, "events": events });
    self.post_json("/v1/sdk/sessions", &body)?;
    Ok(())
}
```

(Use whatever existing helper the file uses — read the existing `post_apple` / `post_google` patterns first.)

- [ ] **Step 2.6: Run tests**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml sessions`
Expected: All pass.

- [ ] **Step 2.7: Commit**

```bash
git add packages/core-rs/src/sessions/ packages/core-rs/src/lib.rs packages/core-rs/src/transport/
git commit -m "feat(core-rs): add SessionBuffer + SessionDispatcher with 30s flush"
```

---

## Task 3: `get_or_create_app_account_token` API + UDL exposure

**Files:**
- Create: `packages/core-rs/src/sessions/account_token.rs`
- Modify: `packages/core-rs/src/api.rs` — surface methods on `RovenueCore`
- Modify: `packages/core-rs/src/librovenue.udl`

- [ ] **Step 3.1: Write the failing test**

`packages/core-rs/src/sessions/account_token.rs`:
```rust
use std::sync::Arc;
use uuid::Uuid;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};

pub struct AccountTokenStore {
    store: Arc<CacheStore>,
}

impl AccountTokenStore {
    pub fn new(store: Arc<CacheStore>) -> Self { Self { store } }

    /// Returns the stable token for the given scope (typically the
    /// subscriber's anon_id or known_user_id). Generates + persists on
    /// first call; subsequent calls return the same UUID.
    pub fn get_or_create(&self, scope: &str) -> RovenueResult<String> {
        if scope.trim().is_empty() {
            return Err(RovenueError::Internal);
        }
        if let Some(existing) = self.store.get_app_account_token(scope)? {
            return Ok(existing);
        }
        let new_token = Uuid::new_v4().to_string();
        self.store.put_app_account_token(scope, &new_token)?;
        // Re-read to handle race: another caller may have inserted first.
        self.store
            .get_app_account_token(scope)?
            .ok_or(RovenueError::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_same_token_on_repeat_calls() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        let t1 = svc.get_or_create("user-a").unwrap();
        let t2 = svc.get_or_create("user-a").unwrap();
        assert_eq!(t1, t2);
    }

    #[test]
    fn different_scopes_get_different_tokens() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        assert_ne!(
            svc.get_or_create("user-a").unwrap(),
            svc.get_or_create("user-b").unwrap(),
        );
    }

    #[test]
    fn token_is_valid_uuid_v4() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        let t = svc.get_or_create("user-a").unwrap();
        let parsed = Uuid::parse_str(&t).expect("valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }
}
```

- [ ] **Step 3.2: Run — expect failure (module missing on api.rs side)**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml sessions::account_token`
Expected: PASS on the three tests above (module is self-contained).

- [ ] **Step 3.3: Surface on `RovenueCore`**

In `packages/core-rs/src/api.rs`:

```rust
// New field on RovenueCore
account_tokens: Arc<AccountTokenStore>,
sessions: Arc<SessionBuffer>,
session_dispatcher: Arc<SessionDispatcher>,
```

Wire them in `from_store`:

```rust
let account_tokens = Arc::new(AccountTokenStore::new(Arc::clone(&store)));
let sessions = Arc::new(SessionBuffer::new(Arc::clone(&store)));
let identity_for_sub = Arc::clone(&identity);
let session_dispatcher = Arc::new(SessionDispatcher::new(
    Arc::clone(&sessions),
    Arc::clone(&http),
    Arc::new(move || {
        let scope = identity_for_sub.current_user_scope();
        if scope.is_empty() { None } else { Some(scope) }
    }),
));
Arc::clone(&session_dispatcher).start(&scheduler);
```

Add public methods:

```rust
pub fn record_session_event(
    &self,
    kind: SessionEventKind,
    occurred_at: String,
    duration_ms: Option<u32>,
) -> RovenueResult<()> {
    self.sessions.record(kind, &occurred_at, duration_ms)
}

pub fn flush_session_events(&self) -> RovenueResult<u32> {
    self.session_dispatcher.flush_once().map(|n| n as u32)
}

pub fn get_or_create_app_account_token(&self) -> RovenueResult<String> {
    let scope = self.identity.current_user_scope();
    self.account_tokens.get_or_create(&scope)
}
```

- [ ] **Step 3.4: Extend `librovenue.udl`**

In `packages/core-rs/src/librovenue.udl`, add the enum + methods:

```idl
enum SessionEventKind {
    "Open",
    "Background",
    "Close",
};

interface RovenueCore {
    // ... existing ...

    [Throws=RovenueError]
    void record_session_event(
        SessionEventKind kind,
        string occurred_at,
        u32? duration_ms
    );

    [Throws=RovenueError]
    u32 flush_session_events();

    [Throws=RovenueError]
    string get_or_create_app_account_token();
};
```

- [ ] **Step 3.5: Regenerate UniFFI bindings**

Run: `cargo build --manifest-path packages/core-rs/Cargo.toml`
Then run whatever `bindgen` step the repo uses (inspect `packages/core-rs/bindgen/`):
- Swift: regenerates `packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift`
- Kotlin: regenerates `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt`

Expected: Both generated files now contain `recordSessionEvent`, `flushSessionEvents`, `getOrCreateAppAccountToken`, `SessionEventKind`.

- [ ] **Step 3.6: Run full core-rs test suite**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml`
Expected: All green.

- [ ] **Step 3.7: Commit**

```bash
git add packages/core-rs/ packages/sdk-swift/Sources/Rovenue/Generated/ packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/
git commit -m "feat(core-rs): expose record_session_event + get_or_create_app_account_token via UniFFI"
```

---

## Task 4: Version bump + cross-package version constants

**Files:**
- Modify: `packages/core-rs/src/version.rs`
- Modify: `packages/core-rs/Cargo.toml`

- [ ] **Step 4.1: Bump SDK_VERSION**

In `packages/core-rs/src/version.rs`, change `SDK_VERSION` from current (likely `"0.5.x"`) to `"0.6.0"`. Bump `version` in `Cargo.toml` to match.

- [ ] **Step 4.2: Update test snapshot if any**

Run: `cargo test --manifest-path packages/core-rs/Cargo.toml`
Expected: A version-string test may fail (e.g. `version_test.rs`). Update its expected value.

- [ ] **Step 4.3: Commit**

```bash
git add packages/core-rs/src/version.rs packages/core-rs/Cargo.toml
git commit -m "chore(core-rs): bump to 0.6.0 for Refund Shield SDK APIs"
```

---

# Phase 2 — Swift façade

Goal: surface the new core APIs through the Swift singleton so pure-Swift consumers can read the stable token (to pass to `Product.purchase(options:)` themselves) and forward the same token as a server-side sanity check on receipt submission.

---

## Task 5: `Rovenue.getAppAccountToken()` Swift API

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/AppAccountTokenTests.swift`

- [ ] **Step 5.1: Write the failing test**

```swift
// packages/sdk-swift/Tests/RovenueTests/AppAccountTokenTests.swift
import XCTest
@testable import Rovenue

final class AppAccountTokenTests: XCTestCase {
    override func setUp() async throws {
        Rovenue.resetForTesting()
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://localhost:0", debug: true)
    }

    override func tearDown() async throws {
        Rovenue.resetForTesting()
    }

    func test_returns_stable_uuid_across_calls() async throws {
        let t1 = try await Rovenue.shared.getAppAccountToken()
        let t2 = try await Rovenue.shared.getAppAccountToken()
        XCTAssertEqual(t1, t2)
        XCTAssertNotNil(UUID(uuidString: t1), "must be a valid UUID")
    }

    func test_token_changes_after_identify() async throws {
        let anonToken = try await Rovenue.shared.getAppAccountToken()
        try await Rovenue.shared.identify("user-123")
        let knownToken = try await Rovenue.shared.getAppAccountToken()
        // Tokens are scoped per current_user_scope; identify() changes the scope.
        XCTAssertNotEqual(anonToken, knownToken)
    }
}
```

- [ ] **Step 5.2: Run — expect failure**

Run: `swift test --package-path packages/sdk-swift --filter AppAccountTokenTests`
Expected: FAIL — method missing.

- [ ] **Step 5.3: Implement on `Rovenue`**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, add after `identify(_:)`:

```swift
/// Returns a stable UUID for the current user. The host app passes this
/// to `Product.purchase(options: [.appAccountToken(uuid)])` so Apple's
/// `CONSUMPTION_REQUEST` webhook can attribute the refund request back
/// to a known subscriber.
///
/// The token is generated once per (project, current_user_scope) pair
/// and persisted locally. It is stable across app launches and reused
/// for every subsequent purchase.
@discardableResult
public func getAppAccountToken() async throws -> String {
    try await dispatcher.run { [core] in
        do { return try core.getOrCreateAppAccountToken() }
        catch let err as RovenueError { throw mapError(err) }
    }
}
```

- [ ] **Step 5.4: Run tests to confirm pass**

Run: `swift test --package-path packages/sdk-swift --filter AppAccountTokenTests`
Expected: All pass. Verify the second case (`test_token_changes_after_identify`) — if the Rust `current_user_scope()` does NOT change on `identify()`, adjust the test expectation to `XCTAssertEqual` and document scope behavior in the doc comment.

- [ ] **Step 5.5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/AppAccountTokenTests.swift
git commit -m "feat(sdk-swift): add Rovenue.getAppAccountToken() helper"
```

---

## Task 6: Extend `postAppleReceipt` to accept optional `appAccountToken`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/PostReceiptWithTokenTests.swift`

- [ ] **Step 6.1: Write the failing test**

```swift
// PostReceiptWithTokenTests.swift
import XCTest
@testable import Rovenue

final class PostReceiptWithTokenTests: XCTestCase {
    override func setUp() async throws { Rovenue.resetForTesting() }
    override func tearDown() async throws { Rovenue.resetForTesting() }

    func test_postAppleReceipt_accepts_optional_token() async throws {
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://127.0.0.1:0", debug: true)
        // No mock server here — we only verify the call compiles + the new
        // signature exists. End-to-end behavior is covered by Rust HttpClient
        // tests + integration suite.
        do {
            _ = try await Rovenue.shared.postAppleReceipt(
                "jws-blob",
                productId: "premium_monthly",
                appAccountToken: UUID().uuidString,
            )
        } catch {
            // expected: network error since baseUrl is unreachable
        }
    }

    func test_postAppleReceipt_works_without_token() async throws {
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://127.0.0.1:0", debug: true)
        do {
            _ = try await Rovenue.shared.postAppleReceipt("jws-blob", productId: "premium_monthly")
        } catch { /* expected network error */ }
    }
}
```

- [ ] **Step 6.2: Run — expect failure (signature mismatch)**

Run: `swift test --package-path packages/sdk-swift --filter PostReceiptWithTokenTests`
Expected: FAIL — extra argument `appAccountToken` in call.

- [ ] **Step 6.3: Update signature on `Rovenue`**

In `Rovenue.swift`, replace the existing `postAppleReceipt(_:productId:)` with:

```swift
public func postAppleReceipt(
    _ jws: String,
    productId: String,
    appAccountToken: String? = nil,
) async throws -> ReceiptResult {
    Self.emit(LogEntry(level: "info", message: "postAppleReceipt"))
    do {
        let result = try await dispatcher.run { [core] in
            do {
                return try core.postAppleReceipt(
                    receipt: jws,
                    productId: productId,
                    appAccountToken: appAccountToken,
                )
            } catch let err as RovenueError { throw mapError(err) }
        }
        Self.emit(LogEntry(level: "info", message: "postAppleReceipt ok"))
        return result
    } catch {
        Self.emit(LogEntry(level: "error", message: "postAppleReceipt failed: \(error.localizedDescription)"))
        throw error
    }
}
```

This requires the Rust UDL to also accept the optional token on `post_apple_receipt` — extend Task 3's UDL change to:

```idl
[Throws=RovenueError]
ReceiptResult post_apple_receipt(string receipt, string product_id, string? app_account_token);
```

Regenerate bindings, then update `RovenueCore::post_apple_receipt` in `api.rs` to accept the third arg and forward it inside the request body (header or JSON field — coordinate with backend's receipt endpoint; if backend doesn't read it yet, this is harmless future-proofing).

- [ ] **Step 6.4: Run all swift tests**

Run: `swift test --package-path packages/sdk-swift`
Expected: All pass.

- [ ] **Step 6.5: Commit**

```bash
git add packages/sdk-swift/ packages/core-rs/src/librovenue.udl packages/core-rs/src/api.rs packages/core-rs/src/receipts/
git commit -m "feat(sdk-swift): accept optional appAccountToken in postAppleReceipt"
```

---

## Task 7: Version bump + podspec

**Files:**
- Modify: `packages/sdk-swift/Package.swift`
- Modify: `packages/sdk-swift/Rovenue.podspec`

- [ ] **Step 7.1: Bump versions**

In `Rovenue.podspec`, change `spec.version` to `"0.6.0"`. In `Package.swift`, ensure the librovenue dependency requirement (if present) is bumped to `>= 0.6.0`.

- [ ] **Step 7.2: Verify pod lints (if CI requires it)**

Run: `pod lib lint packages/sdk-swift/Rovenue.podspec --allow-warnings` (only if `cocoapods` is available locally; CI will catch it otherwise).

- [ ] **Step 7.3: Commit**

```bash
git add packages/sdk-swift/Package.swift packages/sdk-swift/Rovenue.podspec
git commit -m "chore(sdk-swift): bump to 0.6.0"
```

---

# Phase 3 — Kotlin façade

Goal: same as Swift, for Android consumers — expose `getAppAccountToken()` and extend `postGoogleReceipt` with optional `obfuscatedAccountId` + `obfuscatedProfileId` passthrough.

---

## Task 8: `Rovenue.getAppAccountToken()` Kotlin API

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/AppAccountTokenTest.kt`

- [ ] **Step 8.1: Write the failing test**

```kotlin
// AppAccountTokenTest.kt
package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.UUID

class AppAccountTokenTest {
    @BeforeEach fun setup() {
        Rovenue.resetForTesting()
        Rovenue.configure(apiKey = "test_pk", baseUrl = "http://localhost:0", debug = true)
    }
    @AfterEach fun teardown() { Rovenue.resetForTesting() }

    @Test fun returnsStableUuidAcrossCalls() = runBlocking {
        val t1 = Rovenue.shared.getAppAccountToken()
        val t2 = Rovenue.shared.getAppAccountToken()
        assertEquals(t1, t2)
        assertNotNull(UUID.fromString(t1))
    }

    @Test fun tokenIsScopedPerIdentify() = runBlocking {
        val anon = Rovenue.shared.getAppAccountToken()
        Rovenue.shared.identify("user-456")
        val known = Rovenue.shared.getAppAccountToken()
        assertNotEquals(anon, known)
    }
}
```

- [ ] **Step 8.2: Run — expect failure**

Run: `./gradlew :sdk-kotlin:test --tests AppAccountTokenTest`
Expected: FAIL — method missing.

- [ ] **Step 8.3: Implement on `Rovenue`**

Add to `Rovenue.kt`:

```kotlin
/**
 * Returns a stable UUID for the current user. The host app passes this
 * to `BillingFlowParams.Builder.setObfuscatedAccountId(token)` so Google
 * can use it for fraud-detection signals.
 *
 * The token is generated once per (project, current_user_scope) pair
 * and persisted locally. Stable across app launches.
 */
@Throws(RovenueException::class)
suspend fun getAppAccountToken(): String =
    dispatcher.run { core.getOrCreateAppAccountToken() }
```

- [ ] **Step 8.4: Run tests**

Run: `./gradlew :sdk-kotlin:test --tests AppAccountTokenTest`
Expected: All pass.

- [ ] **Step 8.5: Commit**

```bash
git add packages/sdk-kotlin/
git commit -m "feat(sdk-kotlin): add Rovenue.getAppAccountToken() helper"
```

---

## Task 9: Extend `postGoogleReceipt` with `obfuscatedAccountId` + `obfuscatedProfileId`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PostReceiptWithTokenTest.kt`

- [ ] **Step 9.1: Write the failing test**

```kotlin
// PostReceiptWithTokenTest.kt
package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PostReceiptWithTokenTest {
    @BeforeEach fun setup() {
        Rovenue.resetForTesting()
        Rovenue.configure(apiKey = "test_pk", baseUrl = "http://127.0.0.1:0", debug = true)
    }
    @AfterEach fun teardown() { Rovenue.resetForTesting() }

    @Test fun acceptsOptionalObfuscatedIds() = runBlocking {
        try {
            Rovenue.shared.postGoogleReceipt(
                receipt = "token-blob",
                productId = "premium_monthly",
                obfuscatedAccountId = "550e8400-e29b-41d4-a716-446655440000",
                obfuscatedProfileId = "project-abc",
            )
        } catch (e: Throwable) {
            // expected network failure
        }
    }

    @Test fun worksWithoutObfuscatedIds() = runBlocking {
        try {
            Rovenue.shared.postGoogleReceipt(receipt = "token-blob", productId = "premium_monthly")
        } catch (e: Throwable) { /* expected */ }
    }
}
```

- [ ] **Step 9.2: Run — expect failure**

Run: `./gradlew :sdk-kotlin:test --tests PostReceiptWithTokenTest`
Expected: FAIL — extra named args.

- [ ] **Step 9.3: Update signature**

Replace the existing `postGoogleReceipt` in `Rovenue.kt`:

```kotlin
@Throws(RovenueException::class)
suspend fun postGoogleReceipt(
    receipt: String,
    productId: String,
    obfuscatedAccountId: String? = null,
    obfuscatedProfileId: String? = null,
): dev.rovenue.sdk.generated.ReceiptResult {
    emit(LogEntry(level = "info", message = "postGoogleReceipt"))
    try {
        val result = dispatcher.run {
            core.postGoogleReceipt(
                receipt = receipt,
                productId = productId,
                obfuscatedAccountId = obfuscatedAccountId,
                obfuscatedProfileId = obfuscatedProfileId,
            )
        }
        emit(LogEntry(level = "info", message = "postGoogleReceipt ok"))
        return result
    } catch (e: Throwable) {
        emit(LogEntry(level = "error", message = "postGoogleReceipt failed: ${e.message ?: e.javaClass.simpleName}"))
        throw e
    }
}
```

This requires Rust UDL to accept the two extra optional strings on `post_google_receipt` — extend Task 3 UDL change accordingly:

```idl
[Throws=RovenueError]
ReceiptResult post_google_receipt(
    string receipt,
    string product_id,
    string? obfuscated_account_id,
    string? obfuscated_profile_id
);
```

Regenerate Kotlin + Swift bindings; update `RovenueCore::post_google_receipt` in `api.rs` accordingly.

- [ ] **Step 9.4: Run tests**

Run: `./gradlew :sdk-kotlin:test`
Expected: All pass.

- [ ] **Step 9.5: Commit**

```bash
git add packages/sdk-kotlin/ packages/core-rs/
git commit -m "feat(sdk-kotlin): accept optional obfuscated account+profile IDs in postGoogleReceipt"
```

---

## Task 10: Version bump

**Files:**
- Modify: `packages/sdk-kotlin/build.gradle.kts`

- [ ] **Step 10.1: Bump artifact version**

In `build.gradle.kts`, locate the `version =` line in the publishing/maven block and change to `"0.6.0"`. Bump the librovenue Rust dependency version constraint in the same file if explicitly pinned.

- [ ] **Step 10.2: Run full test suite**

Run: `./gradlew :sdk-kotlin:test`
Expected: All pass.

- [ ] **Step 10.3: Commit**

```bash
git add packages/sdk-kotlin/build.gradle.kts
git commit -m "chore(sdk-kotlin): bump to 0.6.0"
```

---

# Phase 4 — RN TS façade

Goal: expose `getAppAccountToken()` to JS, build a `sessionTracker` that subscribes to React Native `AppState` and records open/background/close events, and extend `postAppleReceipt` / `postGoogleReceipt` JS surfaces with the new optional token args. Plus native bridge updates for iOS + Android Expo modules.

---

## Task 11: Extend `RovenueModuleSpec` and `_mockNative`

**Files:**
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/src/__tests__/_mockNative.ts`

- [ ] **Step 11.1: Extend the type spec**

In `RovenueModule.types.ts`, add to the `RovenueModuleSpec` interface:

```ts
// Refund Shield additions
getAppAccountToken(): Promise<string>;
recordSessionEvent(kind: "open" | "background" | "close", occurredAt: string, durationMs?: number): Promise<void>;
flushSessionEvents(): Promise<number>;
```

And update the existing receipt method signatures:

```ts
postAppleReceipt(jws: string, productId: string, appAccountToken?: string | null): Promise<ReceiptResultDTO>;
postGoogleReceipt(
    receipt: string,
    productId: string,
    obfuscatedAccountId?: string | null,
    obfuscatedProfileId?: string | null,
): Promise<ReceiptResultDTO>;
```

- [ ] **Step 11.2: Extend `_mockNative.ts`**

Add to the mock object the three new methods plus updated receipt method bodies. Keep them simple:

```ts
getAppAccountToken: vi.fn(async () => "00000000-0000-0000-0000-000000000001"),
recordSessionEvent: vi.fn(async () => undefined),
flushSessionEvents: vi.fn(async () => 0),
postAppleReceipt: vi.fn(async (_jws: string, _productId: string, _token?: string | null) => ({
    ok: true, entitlementsRefreshed: true, creditsRefreshed: true,
})),
postGoogleReceipt: vi.fn(async (_r: string, _p: string, _o?: string | null, _f?: string | null) => ({
    ok: true, entitlementsRefreshed: true, creditsRefreshed: true,
})),
```

- [ ] **Step 11.3: Commit (no test step — pure types)**

```bash
git add packages/sdk-rn/src/specs/ packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): extend native module spec with Refund Shield methods"
```

---

## Task 12: `accountToken.ts` module + tests

**Files:**
- Create: `packages/sdk-rn/src/api/accountToken.ts`
- Create: `packages/sdk-rn/src/__tests__/accountToken.test.ts`

- [ ] **Step 12.1: Write the failing test**

```ts
// packages/sdk-rn/src/__tests__/accountToken.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { getAppAccountToken } from "../api/accountToken";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

describe("accountToken", () => {
    beforeEach(() => { _setNativeForTesting(null); });

    it("returns the token from the native module", async () => {
        const mock = makeMockNative();
        mock.getAppAccountToken = vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000");
        _setNativeForTesting(mock);
        const token = await getAppAccountToken();
        expect(token).toBe("550e8400-e29b-41d4-a716-446655440000");
        expect(mock.getAppAccountToken).toHaveBeenCalledTimes(1);
    });

    it("propagates native errors via mapNativeError", async () => {
        const mock = makeMockNative();
        mock.getAppAccountToken = vi.fn(async () => {
            const e: any = new Error("not configured"); e.code = "NotConfigured"; throw e;
        });
        _setNativeForTesting(mock);
        await expect(getAppAccountToken()).rejects.toMatchObject({ name: "NotConfiguredError" });
    });
});
```

- [ ] **Step 12.2: Run — expect failure**

Run: `pnpm --filter @rovenue/react-native-sdk test accountToken`
Expected: FAIL — module not found.

- [ ] **Step 12.3: Implement**

```ts
// packages/sdk-rn/src/api/accountToken.ts
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e: any) {
        if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
        throw e;
    }
}

/**
 * Returns a stable per-subscriber UUID. Pass this to your StoreKit2
 * `Product.purchase(options:)` call as `.appAccountToken(uuid)` on iOS,
 * and to `BillingFlowParams.Builder.setObfuscatedAccountId(token)` on
 * Android. The same UUID is reused for the lifetime of the install
 * (and bound to the current SDK user — calling `identify()` first
 * changes the scope so the next `getAppAccountToken()` returns a
 * different UUID for the now-known user).
 *
 * Storage is the Rust core's SQLite cache (not MMKV) — survives JS
 * reloads but is wiped on app reinstall, matching Apple's documented
 * `appAccountToken` semantics.
 */
export async function getAppAccountToken(): Promise<string> {
    return call(() => getNative().getAppAccountToken());
}
```

- [ ] **Step 12.4: Run tests**

Run: `pnpm --filter @rovenue/react-native-sdk test accountToken`
Expected: All pass.

- [ ] **Step 12.5: Commit**

```bash
git add packages/sdk-rn/src/api/accountToken.ts packages/sdk-rn/src/__tests__/accountToken.test.ts
git commit -m "feat(sdk-rn): add getAppAccountToken() JS helper"
```

---

## Task 13: `sessionTracker.ts` module + tests

**Files:**
- Create: `packages/sdk-rn/src/api/sessionTracker.ts`
- Create: `packages/sdk-rn/src/__tests__/sessionTracker.test.ts`

- [ ] **Step 13.1: Write the failing test**

```ts
// packages/sdk-rn/src/__tests__/sessionTracker.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { startSessionTracker, stopSessionTracker } from "../api/sessionTracker";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

// Hoisted AppState mock — must be at module scope per vi.mock semantics.
const appStateListeners: Array<(s: string) => void> = [];
vi.mock("react-native", () => ({
    AppState: {
        addEventListener: (_evt: string, cb: (s: string) => void) => {
            appStateListeners.push(cb);
            return { remove: () => {
                const i = appStateListeners.indexOf(cb);
                if (i >= 0) appStateListeners.splice(i, 1);
            }};
        },
        currentState: "active",
    },
}));

function trigger(state: "active" | "background" | "inactive") {
    appStateListeners.forEach(cb => cb(state));
}

describe("sessionTracker", () => {
    beforeEach(() => {
        _setNativeForTesting(null);
        appStateListeners.length = 0;
        vi.useFakeTimers();
    });
    afterEach(() => {
        stopSessionTracker();
        vi.useRealTimers();
    });

    it("records 'open' on first start", async () => {
        const mock = makeMockNative();
        _setNativeForTesting(mock);
        startSessionTracker();
        await vi.runAllTimersAsync();
        expect(mock.recordSessionEvent).toHaveBeenCalledWith(
            "open",
            expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            undefined,
        );
    });

    it("records 'background' with durationMs when going to background", async () => {
        const mock = makeMockNative();
        _setNativeForTesting(mock);
        startSessionTracker();
        // advance 5 seconds in the foreground
        await vi.advanceTimersByTimeAsync(5000);
        trigger("background");
        await vi.runAllTimersAsync();
        const calls = mock.recordSessionEvent.mock.calls;
        const bgCall = calls.find(c => c[0] === "background");
        expect(bgCall).toBeDefined();
        expect(bgCall![2]).toBeGreaterThanOrEqual(4500);
        expect(bgCall![2]).toBeLessThanOrEqual(5500);
    });

    it("debounces sub-1s state transitions", async () => {
        const mock = makeMockNative();
        _setNativeForTesting(mock);
        startSessionTracker();
        await vi.runAllTimersAsync();
        const before = mock.recordSessionEvent.mock.calls.length;
        // rapid flap within 1s
        trigger("background"); trigger("active"); trigger("background");
        await vi.advanceTimersByTimeAsync(500);
        // should not have recorded the flap
        expect(mock.recordSessionEvent.mock.calls.length).toBe(before);
        await vi.advanceTimersByTimeAsync(600);
        // after debounce settles, exactly one transition recorded
        expect(mock.recordSessionEvent.mock.calls.length).toBe(before + 1);
    });

    it("stopSessionTracker removes the listener and stops the flush timer", async () => {
        const mock = makeMockNative();
        _setNativeForTesting(mock);
        startSessionTracker();
        stopSessionTracker();
        trigger("background");
        await vi.runAllTimersAsync();
        // No further calls after stop.
        const callsAfterStop = mock.recordSessionEvent.mock.calls.filter(c => c[0] === "background");
        expect(callsAfterStop.length).toBe(0);
    });
});
```

- [ ] **Step 13.2: Run — expect failure**

Run: `pnpm --filter @rovenue/react-native-sdk test sessionTracker`
Expected: FAIL — module not found.

- [ ] **Step 13.3: Implement**

```ts
// packages/sdk-rn/src/api/sessionTracker.ts
import { AppState, type NativeEventSubscription, type AppStateStatus } from "react-native";
import { getNative } from "../core/native";

const DEBOUNCE_MS = 1000;
const FLUSH_INTERVAL_MS = 30_000;

type Tracker = {
    sub: NativeEventSubscription;
    flushTimer: ReturnType<typeof setInterval>;
    lastTransitionAt: number;
    foregroundStartedAt: number | null;
    pendingState: AppStateStatus | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
};

let tracker: Tracker | null = null;

function now(): number { return Date.now(); }
function isoNow(): string { return new Date().toISOString(); }

function isForeground(s: AppStateStatus): boolean { return s === "active"; }

function recordTransition(prev: AppStateStatus | null, next: AppStateStatus, startedAt: number | null) {
    const native = getNative();
    if (prev === null) {
        // initial mount — emit 'open' with no duration
        native.recordSessionEvent("open", isoNow(), undefined).catch(() => {});
        return;
    }
    if (!isForeground(prev) && isForeground(next)) {
        native.recordSessionEvent("open", isoNow(), undefined).catch(() => {});
    } else if (isForeground(prev) && !isForeground(next)) {
        const durationMs = startedAt ? Math.max(0, now() - startedAt) : undefined;
        native.recordSessionEvent("background", isoNow(), durationMs).catch(() => {});
    }
}

export function startSessionTracker(): void {
    if (tracker) return;
    const onChange = (next: AppStateStatus) => {
        if (!tracker) return;
        tracker.pendingState = next;
        if (tracker.debounceTimer) clearTimeout(tracker.debounceTimer);
        tracker.debounceTimer = setTimeout(() => {
            if (!tracker) return;
            const finalState = tracker.pendingState!;
            const prev = AppState.currentState as AppStateStatus; // best-effort previous
            // We compute against the last transition recorded, not the live currentState.
            // Implementation simplification: track explicitly via foregroundStartedAt.
            const wasForeground = tracker.foregroundStartedAt !== null;
            const willBeForeground = isForeground(finalState);
            if (wasForeground !== willBeForeground) {
                recordTransition(
                    wasForeground ? "active" : "background",
                    willBeForeground ? "active" : "background",
                    tracker.foregroundStartedAt,
                );
                tracker.foregroundStartedAt = willBeForeground ? now() : null;
            }
            tracker.debounceTimer = null;
        }, DEBOUNCE_MS);
    };
    const sub = AppState.addEventListener("change", onChange);
    const initialState = AppState.currentState as AppStateStatus;
    const startedAt = isForeground(initialState) ? now() : null;
    tracker = {
        sub,
        flushTimer: setInterval(() => {
            getNative().flushSessionEvents().catch(() => {});
        }, FLUSH_INTERVAL_MS),
        lastTransitionAt: now(),
        foregroundStartedAt: startedAt,
        pendingState: null,
        debounceTimer: null,
    };
    // initial 'open' event
    recordTransition(null, initialState, startedAt);
}

export function stopSessionTracker(): void {
    if (!tracker) return;
    // emit a 'close' if we were foregrounded
    if (tracker.foregroundStartedAt !== null) {
        const durationMs = Math.max(0, now() - tracker.foregroundStartedAt);
        getNative().recordSessionEvent("close", isoNow(), durationMs).catch(() => {});
        // best-effort final flush
        getNative().flushSessionEvents().catch(() => {});
    }
    if (tracker.debounceTimer) clearTimeout(tracker.debounceTimer);
    clearInterval(tracker.flushTimer);
    tracker.sub.remove();
    tracker = null;
}
```

- [ ] **Step 13.4: Run tests**

Run: `pnpm --filter @rovenue/react-native-sdk test sessionTracker`
Expected: All pass. If the debounce test fails due to timer fakery semantics, simplify the implementation to a leading-edge debounce (record the first transition, suppress subsequent transitions within DEBOUNCE_MS) and update the test to match.

- [ ] **Step 13.5: Commit**

```bash
git add packages/sdk-rn/src/api/sessionTracker.ts packages/sdk-rn/src/__tests__/sessionTracker.test.ts
git commit -m "feat(sdk-rn): add sessionTracker AppState observer with debounce + flush"
```

---

## Task 14: Wire tracker into `configure()` / `shutdown()`

**Files:**
- Modify: `packages/sdk-rn/src/api/configure.ts`
- Modify: `packages/sdk-rn/src/api/lifecycle.ts`
- Modify: `packages/sdk-rn/src/__tests__/api.test.ts` (extend existing tests)

- [ ] **Step 14.1: Write the failing test**

Append to `packages/sdk-rn/src/__tests__/api.test.ts` (or create `packages/sdk-rn/src/__tests__/sessionTrackerWiring.test.ts`):

```ts
import { configure } from "../api/configure";
import { shutdown } from "../api/lifecycle";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

describe("session tracker lifecycle", () => {
    beforeEach(() => { _setNativeForTesting(null); });

    it("starts the tracker on configure() and stops on shutdown()", async () => {
        const mock = makeMockNative();
        _setNativeForTesting(mock);
        configure({ apiKey: "test_pk", baseUrl: "http://localhost:0", debug: true });
        // Initial 'open' should have been recorded.
        // (Use a small tick — but accountToken impl is sync; recordSessionEvent is async.)
        await new Promise(r => setTimeout(r, 0));
        expect(mock.recordSessionEvent).toHaveBeenCalled();
        shutdown();
        // After shutdown, the tracker is torn down — subsequent AppState changes are no-ops.
    });
});
```

- [ ] **Step 14.2: Run — expect failure**

Run: `pnpm --filter @rovenue/react-native-sdk test sessionTrackerWiring`
Expected: FAIL — `recordSessionEvent` not called from configure.

- [ ] **Step 14.3: Wire into configure**

In `packages/sdk-rn/src/api/configure.ts`:

```ts
import { startEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { InvalidApiKeyError } from "../errors";
import { startSessionTracker } from "./sessionTracker";  // NEW

export function configure(opts: RovenueConfig): void {
    // ... existing validation
    native.configure(opts.apiKey, opts.baseUrl, opts.debug ?? false);
    startEventBridge();
    startSessionTracker();   // NEW
}
```

In `packages/sdk-rn/src/api/lifecycle.ts`:

```ts
import { stopEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { stopSessionTracker } from "./sessionTracker";  // NEW

export function shutdown(): void {
    stopSessionTracker();   // NEW — before stopEventBridge so a final flush is emitted
    stopEventBridge();
    getNative().shutdown();
}
```

- [ ] **Step 14.4: Run tests**

Run: `pnpm --filter @rovenue/react-native-sdk test`
Expected: All pass, including pre-existing api/configure/lifecycle tests.

- [ ] **Step 14.5: Commit**

```bash
git add packages/sdk-rn/src/api/configure.ts packages/sdk-rn/src/api/lifecycle.ts packages/sdk-rn/src/__tests__/
git commit -m "feat(sdk-rn): wire sessionTracker start/stop into configure/shutdown"
```

---

## Task 15: Extend `receipts.ts` + public `Rovenue` surface

**Files:**
- Modify: `packages/sdk-rn/src/api/receipts.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Modify: `packages/sdk-rn/src/__tests__/api.test.ts`

- [ ] **Step 15.1: Write the failing test**

Append:

```ts
it("postAppleReceipt forwards optional appAccountToken", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    await Rovenue.postAppleReceipt("jws-blob", "premium_monthly", "550e8400-e29b-41d4-a716-446655440000");
    expect(mock.postAppleReceipt).toHaveBeenCalledWith(
        "jws-blob",
        "premium_monthly",
        "550e8400-e29b-41d4-a716-446655440000",
    );
});

it("postGoogleReceipt forwards optional obfuscated ids", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    await Rovenue.postGoogleReceipt("token-blob", "premium_monthly", "550e8400-e29b-41d4-a716-446655440000", "project-abc");
    expect(mock.postGoogleReceipt).toHaveBeenCalledWith(
        "token-blob",
        "premium_monthly",
        "550e8400-e29b-41d4-a716-446655440000",
        "project-abc",
    );
});

it("exposes getAppAccountToken on Rovenue namespace", async () => {
    const mock = makeMockNative();
    mock.getAppAccountToken = vi.fn(async () => "abc");
    _setNativeForTesting(mock);
    expect(await Rovenue.getAppAccountToken()).toBe("abc");
});
```

- [ ] **Step 15.2: Run — expect failure**

Run: `pnpm --filter @rovenue/react-native-sdk test api.test`
Expected: FAIL.

- [ ] **Step 15.3: Update `receipts.ts`**

```ts
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { ReceiptResult } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e: any) {
        if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
        throw e;
    }
}

export async function postAppleReceipt(
    jws: string,
    productId: string,
    appAccountToken?: string,
): Promise<ReceiptResult> {
    return call(() => getNative().postAppleReceipt(jws, productId, appAccountToken));
}

export async function postGoogleReceipt(
    receipt: string,
    productId: string,
    obfuscatedAccountId?: string,
    obfuscatedProfileId?: string,
): Promise<ReceiptResult> {
    return call(() =>
        getNative().postGoogleReceipt(receipt, productId, obfuscatedAccountId, obfuscatedProfileId),
    );
}
```

- [ ] **Step 15.4: Export from `index.ts`**

```ts
import { getAppAccountToken } from "./api/accountToken";   // NEW

export const Rovenue = {
    configure,
    // ... existing methods
    getAppAccountToken,                                     // NEW
    // ... existing
} as const;
```

- [ ] **Step 15.5: Run tests**

Run: `pnpm --filter @rovenue/react-native-sdk test`
Expected: All pass.

- [ ] **Step 15.6: Commit**

```bash
git add packages/sdk-rn/src/api/receipts.ts packages/sdk-rn/src/index.ts packages/sdk-rn/src/__tests__/
git commit -m "feat(sdk-rn): expose getAppAccountToken + token-aware postReceipt methods"
```

---

## Task 16: iOS native bridge — `RovenueModule.swift`

**Files:**
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`

- [ ] **Step 16.1: Add new bridge functions**

Insert into the module `definition()` block, next to the existing AsyncFunctions:

```swift
AsyncFunction("getAppAccountToken") { () -> String in
    try await Rovenue.shared.getAppAccountToken()
}
AsyncFunction("recordSessionEvent") { (kind: String, occurredAt: String, durationMs: Double?) -> Void in
    let kindEnum: SessionEventKind = {
        switch kind {
        case "open": return .open
        case "background": return .background
        case "close": return .close
        default: return .open
        }
    }()
    try await Rovenue.shared.recordSessionEvent(
        kind: kindEnum,
        occurredAt: occurredAt,
        durationMs: durationMs.map { UInt32($0) },
    )
}
AsyncFunction("flushSessionEvents") { () -> Double in
    let n = try await Rovenue.shared.flushSessionEvents()
    return Double(n)
}
```

Also update the two existing receipt bridges to pass the new optional args:

```swift
AsyncFunction("postAppleReceipt") { (jws: String, productId: String, appAccountToken: String?) -> [String: Any?] in
    _ = try await Rovenue.shared.postAppleReceipt(jws, productId: productId, appAccountToken: appAccountToken)
    return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
}
AsyncFunction("postGoogleReceipt") { (receipt: String, productId: String, obfAccount: String?, obfProfile: String?) -> [String: Any?] in
    // On iOS this is unreachable but kept for surface parity.
    _ = try await Rovenue.shared.postGoogleReceipt(receipt, productId: productId, obfuscatedAccountId: obfAccount, obfuscatedProfileId: obfProfile)
    return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
}
```

This requires Task 5/6/8/9 to have surfaced `recordSessionEvent`, `flushSessionEvents`, `getAppAccountToken`, plus the new optional args on `postAppleReceipt` / `postGoogleReceipt` from the Swift façade. Verify those exist before committing.

- [ ] **Step 16.2: Build the iOS module**

Run from a fresh checkout sample app (or use the existing example app in `packages/sdk-rn/`): `cd packages/sdk-rn/example-ios && pod install && xcodebuild -scheme … build`. Smoke-test that the module compiles.

- [ ] **Step 16.3: Commit**

```bash
git add packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-rn-ios): bridge Refund Shield methods to JS"
```

---

## Task 17: Android native bridge — `RovenueModule.kt`

**Files:**
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

- [ ] **Step 17.1: Add new bridge functions**

Add to the module definition (mirror the iOS shape):

```kotlin
AsyncFunction("getAppAccountToken") Coroutine { ->
    Rovenue.shared.getAppAccountToken()
}
AsyncFunction("recordSessionEvent") Coroutine { kind: String, occurredAt: String, durationMs: Double? ->
    val kindEnum = when (kind) {
        "open" -> SessionEventKind.OPEN
        "background" -> SessionEventKind.BACKGROUND
        "close" -> SessionEventKind.CLOSE
        else -> SessionEventKind.OPEN
    }
    Rovenue.shared.recordSessionEvent(kindEnum, occurredAt, durationMs?.toInt()?.toUInt())
}
AsyncFunction("flushSessionEvents") Coroutine { ->
    Rovenue.shared.flushSessionEvents().toDouble()
}
```

Update existing receipt bridges similarly with the new optional args, mirroring Task 16.

(Use whatever Coroutine/AsyncFunction macro syntax matches the existing module — `Rovenue.shared.identify` shows the established style.)

- [ ] **Step 17.2: Build**

Run: `cd packages/sdk-rn/android && ./gradlew assembleDebug` (if a sample app is wired) or rely on the parent app's build.

- [ ] **Step 17.3: Commit**

```bash
git add packages/sdk-rn/android/
git commit -m "feat(sdk-rn-android): bridge Refund Shield methods to JS"
```

---

## Task 18: Version bump + final integration test

**Files:**
- Modify: `packages/sdk-rn/package.json`

- [ ] **Step 18.1: Bump version**

In `package.json`, bump `"version"` from `"0.1.0"` to `"0.2.0"`. Bump any consumer-facing references in `README.md` if present.

- [ ] **Step 18.2: Run full test suite end-to-end**

Run from repo root: `pnpm --filter @rovenue/react-native-sdk test && pnpm --filter @rovenue/react-native-sdk build`
Expected: All tests pass + clean build artifact.

- [ ] **Step 18.3: Commit**

```bash
git add packages/sdk-rn/package.json
git commit -m "chore(sdk-rn): bump to 0.2.0 for Refund Shield"
```

---

## Final phase summary

After all four phases land:

- `librovenue 0.6.0` exposes `record_session_event`, `flush_session_events`, `get_or_create_app_account_token` plus token-aware `post_apple_receipt` / `post_google_receipt`.
- `Rovenue 0.6.0` (Swift) and `dev.rovenue:sdk 0.6.0` (Kotlin) ship matching helpers for pure-native consumers.
- `@rovenue/react-native-sdk 0.2.0` ships `accountToken.ts`, `sessionTracker.ts`, an extended `Rovenue` JS namespace, and matching native bridge updates.

Run Plan 1 (`refund-shield-backend.md`) before publishing the SDKs so the `POST /v1/sdk/sessions` endpoint exists when SDK clients begin posting telemetry. Run Plan 3 (dashboard) afterward.

---

## Open questions / follow-ups for future plans

1. **Wrapping `purchase()` API** — adding a single method that calls StoreKit2 / Play Billing internally with the token already attached would simplify host integration. Out of scope here; spec §7.1 implies it but the existing SDK doesn't own the store call.
2. **Pure-native lifecycle observers** — `UIApplication.willEnterForeground` / `ProcessLifecycleOwner` wiring for non-RN consumers. v1 ships only the API surface; v2 should add automatic recording.
3. **Backend `POST /v1/sdk/sessions` contract** — confirm `appVersion` is required vs optional in the Zod schema (Plan 1 §5.4 has it required `.max(32)`). The Rust dispatcher in Task 2 sends an empty string today; either the Swift/Kotlin/RN façades must set it before flush, OR the backend must accept empty. Recommend: façades each set their app's bundle version explicitly. Add a `setAppVersion(version: String)` method to the Rust core in a follow-up — out of scope here (every additive on the receipt path would balloon this plan).
4. **Tests for `flush_session_events` HTTP path** — currently covered by the existing `HttpClient` test harness; add an integration test in `packages/core-rs/tests/sessions.integration.rs` that exercises an httpmock-backed flush. Tracked as future work.
