# SDK M1 — Rust Core (HttpClient + Cache + Identity + Entitlement Reader) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M1 milestone Rust-core slice for the Rovenue SDK: a blocking `HttpClient` with retry + ETag, a SQLite-backed `CacheStore`, an `IdentityManager` with anon→known transitions, an `Observer` bus, a `PollingScheduler`, and an `EntitlementReader` that wires them into a cache-first, polling-refreshed read flow. RovenueCore's UniFFI surface is extended with `current_user`, `entitlement`, `entitlements_all`, `refresh_entitlements`, `register_observer`, and `set_foreground`. **No façade work in this plan** — Swift/Kotlin/RN integration plans follow once the Rust contract is stable.

**Architecture:** Sync FFI surface (per spec §3.2). `reqwest::blocking` for HTTP. `rusqlite` (bundled SQLite) with hand-rolled file-versioned migrations. `std::thread` for the polling loop (no tokio). `std::sync::Arc + Mutex` for shared state. Observer bus is a `Vec<Weak<dyn Observer>>` to avoid leaking subscribers. `cuid2` for anonymous user IDs (spec §4.1). Identify is **client-local only** — no HTTP call, per memory note: server-side merge goes through secret-key `/v1/subscribers/transfer`, called by the customer's backend (spec §5.4 amended 2026-05-19).

**Tech Stack:** Rust 1.78.0, `reqwest` 0.12 (blocking, rustls), `rusqlite` 0.31 (bundled), `serde`/`serde_json` 1.x, `cuid2` 0.1, `rand` 0.8, `uniffi` 0.25.3 (existing). Dev deps: `mockito` 1.4 (HTTP fixtures), `tempfile` 3.10 (SQLite paths), `serial_test` 3 (polling thread isolation).

**Non-goals for M1:**
- Façade integration (Swift AsyncStream, Kotlin Flow, RN hooks) — separate plans
- Receipt posting, credits ledger, audiences, experiments — M2+
- sqlcipher / encrypted cache (deferred to M1.5+)
- Idempotency-Key middleware (no mutations in M1 — `consume_credits`, `post_apple_receipt` land in their own milestones)
- Cert pinning / Apple Root CA chain pinning (the **server** validates JWS; the SDK trusts its system root store in M1)
- Background `WorkManager` integration on Android 14 (open question §10.6 — façade-side concern)

---

## File Structure

**New crate files under `packages/core-rs/`:**

- `src/observer.rs` — `Observer` trait, `ChangeEvent` enum, `ObserverBus` registry
- `src/cache/mod.rs` — module root
- `src/cache/schema.rs` — schema v1 SQL + migration runner
- `src/cache/store.rs` — `CacheStore` open + transaction helpers
- `src/cache/entitlements.rs` — entitlements upsert/get/list
- `src/cache/etag.rs` — per-resource ETag store
- `src/cache/identity.rs` — identity row (singleton `self` table)
- `src/identity.rs` — `IdentityManager` (orchestrates cache + observer)
- `src/transport/mod.rs` — module root
- `src/transport/http_client.rs` — `HttpClient` (blocking, auth, retry, ETag, 429)
- `src/transport/retry.rs` — retry policy (classifier + backoff)
- `src/transport/types.rs` — `Response<T>` wrapper carrying ETag + status
- `src/polling/mod.rs` — module root
- `src/polling/scheduler.rs` — `PollingScheduler` (thread + foreground gate)
- `src/polling/registration.rs` — per-resource interval registration
- `src/entitlements/mod.rs` — module root
- `src/entitlements/reader.rs` — `EntitlementReader` (cache-first + refresh)
- `src/entitlements/types.rs` — DTOs + UniFFI-visible `Entitlement` struct
- `src/entitlements/api.rs` — server response models + mapping
- `src/time.rs` — `Clock` trait + `SystemClock` (real) + test clock

**Modified files:**

- `Cargo.toml` (workspace root) — add `reqwest`, `rusqlite`, `serde`, `serde_json`, `cuid2`, `rand`, dev-deps
- `packages/core-rs/Cargo.toml` — declare runtime + dev dependencies
- `packages/core-rs/src/lib.rs` — declare new modules, re-export public types
- `packages/core-rs/src/api.rs` — extend `RovenueCore` with the new FFI methods
- `packages/core-rs/src/error.rs` — add `NetworkUnavailable`, `Timeout`, `RateLimited`, `Storage` variants
- `packages/core-rs/src/librovenue.udl` — declare new types + interface methods
- `packages/core-rs/tests/integration_smoke.rs` — extend smoke to exercise observer + entitlement read against mockito

**New integration tests:**

- `packages/core-rs/tests/cache_test.rs` — schema migrations + entitlement CRUD against temp SQLite file
- `packages/core-rs/tests/http_client_test.rs` — mockito-driven happy path, retry, 304, 429, network-error
- `packages/core-rs/tests/identity_test.rs` — anon gen, identify, observer emission
- `packages/core-rs/tests/polling_test.rs` — scheduler ticks, foreground gate, shutdown
- `packages/core-rs/tests/entitlement_read_test.rs` — end-to-end cache-first + refresh + observer

**Test fixtures:**

- `packages/core-rs/tests/fixtures/entitlements_response.json` — sample server response

---

## Conventions

- **All FFI methods on `RovenueCore` are blocking** (sync). Façades wrap them in their own runtime in later plans.
- **Lib name is `rovenue`** (`use rovenue::...` in tests). Package name is `librovenue` (Cargo).
- **TDD per task** — failing test first, then implementation. Tests run against `cargo test -p librovenue --test <test_name>` so each integration file stays isolated.
- **Server contract for entitlements (M1):**
  - `GET /v1/me/entitlements` returns `200 OK` with body `{ "entitlements": [...], "etag": "..." }` and `ETag: "<value>"` response header
  - Subsequent calls with `If-None-Match: "<etag>"` may return `304 Not Modified` (no body)
  - Auth header: `Authorization: Bearer <publicApiKey>`
  - User context: `X-Rovenue-User: <coreUserId>` (anon_id or known_user_id)
- **No tokio.** `reqwest::blocking` plus a single `std::thread` for polling.

---

## Task 1: Workspace dependencies

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Modify: `packages/core-rs/Cargo.toml`

- [ ] **Step 1.1: Add workspace-level dependency entries**

Edit `/Volumes/Development/rovenue/Cargo.toml` `[workspace.dependencies]` block. Append (keep existing `uniffi` and `thiserror` lines untouched):

```toml
reqwest = { version = "0.12.5", default-features = false, features = ["blocking", "json", "rustls-tls"] }
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
cuid2 = "0.1"
rand = "0.8"

# dev-deps
mockito = "1.4"
tempfile = "3.10"
serial_test = "3"
```

- [ ] **Step 1.2: Declare runtime deps on the librovenue crate**

Edit `packages/core-rs/Cargo.toml`. Replace the `[dependencies]` and add a `[dev-dependencies]` block:

```toml
[dependencies]
uniffi = { workspace = true }
thiserror = { workspace = true }
reqwest = { workspace = true }
rusqlite = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
cuid2 = { workspace = true }
rand = { workspace = true }

[build-dependencies]
uniffi = { workspace = true, features = ["build"] }

[dev-dependencies]
mockito = { workspace = true }
tempfile = { workspace = true }
serial_test = { workspace = true }
```

- [ ] **Step 1.3: Verify workspace resolves**

Run: `source $HOME/.cargo/env && cargo fetch`
Expected: dependencies downloaded with no resolution errors.

- [ ] **Step 1.4: Verify existing tests still pass after dep addition**

Run: `cargo test -p librovenue`
Expected: 11 tests pass (M0 baseline, no regressions).

- [ ] **Step 1.5: Commit**

```
git add Cargo.toml packages/core-rs/Cargo.toml Cargo.lock
git commit -m "build(core-rs): add reqwest/rusqlite/serde/cuid2 for M1 transport+cache"
```

---

## Task 2: Extend `RovenueError`

**Files:**
- Modify: `packages/core-rs/src/error.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/tests/error_test.rs`

The UDL flat-error form keeps unit variants only (per Task 6 of M0). New variants for transport + storage failures.

- [ ] **Step 2.1: Write failing tests for new variants**

Edit `packages/core-rs/tests/error_test.rs` to append:

```rust
#[test]
fn network_unavailable_displays() {
    assert_eq!(format!("{}", RovenueError::NetworkUnavailable), "network unavailable");
}

#[test]
fn timeout_displays() {
    assert_eq!(format!("{}", RovenueError::Timeout), "timeout");
}

#[test]
fn rate_limited_displays() {
    assert_eq!(format!("{}", RovenueError::RateLimited), "rate limited");
}

#[test]
fn storage_displays() {
    assert_eq!(format!("{}", RovenueError::Storage), "storage error");
}
```

- [ ] **Step 2.2: Run, see compile failure**

Run: `cargo test -p librovenue --test error_test`
Expected: FAIL — variants not defined.

- [ ] **Step 2.3: Extend the enum**

Replace `packages/core-rs/src/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("server error")]
    ServerError,

    #[error("network unavailable")]
    NetworkUnavailable,

    #[error("timeout")]
    Timeout,

    #[error("rate limited")]
    RateLimited,

    #[error("storage error")]
    Storage,

    #[error("internal error")]
    Internal,
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
```

- [ ] **Step 2.4: Update UDL**

Edit `packages/core-rs/src/librovenue.udl`. Replace the `[Error] enum RovenueError` block with:

```
[Error]
enum RovenueError {
    "NotConfigured",
    "InvalidApiKey",
    "ServerError",
    "NetworkUnavailable",
    "Timeout",
    "RateLimited",
    "Storage",
    "Internal",
};
```

- [ ] **Step 2.5: Verify**

Run: `cargo test -p librovenue --test error_test`
Expected: 8 passed.

Run: `cargo test -p librovenue` (full crate)
Expected: 15 tests (11 prior + 4 new error tests), all green.

- [ ] **Step 2.6: Commit**

```
git add packages/core-rs/src/error.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/error_test.rs
git commit -m "feat(core-rs): RovenueError gains transport + storage variants"
```

---

## Task 3: Observer trait + bus

**Files:**
- Create: `packages/core-rs/src/observer.rs`
- Create: `packages/core-rs/tests/observer_test.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 3.1: Write failing tests**

Create `packages/core-rs/tests/observer_test.rs`:

```rust
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
```

- [ ] **Step 3.2: Run, see compile failure**

Run: `cargo test -p librovenue --test observer_test`
Expected: FAIL — `observer` module not found.

- [ ] **Step 3.3: Implement Observer + Bus**

Create `packages/core-rs/src/observer.rs`:

```rust
use std::sync::{Arc, Mutex, Weak};

/// What changed in the SDK's internal state.
///
/// Façades translate these into platform-native streams (AsyncStream / Flow / JS bus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
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
```

- [ ] **Step 3.4: Wire into lib**

Edit `packages/core-rs/src/lib.rs`. Add `pub mod observer;` and a re-export `pub use observer::{ChangeEvent, Observer};` after the existing module declarations. **Leave** the existing `uniffi::include_scaffolding!("librovenue");` line at the bottom untouched.

- [ ] **Step 3.5: Verify**

Run: `cargo test -p librovenue --test observer_test`
Expected: 3 passed.

- [ ] **Step 3.6: Commit**

```
git add packages/core-rs/src/observer.rs packages/core-rs/src/lib.rs packages/core-rs/tests/observer_test.rs
git commit -m "feat(core-rs): Observer trait + Weak-backed ObserverBus"
```

---

## Task 4: `time::Clock` abstraction

**Files:**
- Create: `packages/core-rs/src/time.rs`
- Modify: `packages/core-rs/src/lib.rs`

Used by the cache TTL, the polling scheduler, and retry backoff. A trait lets tests inject fake time.

- [ ] **Step 4.1: Create `src/time.rs`**

```rust
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_unix_ms(&self) -> u64;
    fn sleep(&self, d: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}
```

- [ ] **Step 4.2: Declare module**

Add `pub mod time;` to `packages/core-rs/src/lib.rs` (before `uniffi::include_scaffolding!`).

- [ ] **Step 4.3: Verify build**

Run: `cargo build -p librovenue`
Expected: clean build.

- [ ] **Step 4.4: Commit**

```
git add packages/core-rs/src/time.rs packages/core-rs/src/lib.rs
git commit -m "feat(core-rs): Clock trait + SystemClock for testable time"
```

---

## Task 5: CacheStore — connection + migrations

**Files:**
- Create: `packages/core-rs/src/cache/mod.rs`
- Create: `packages/core-rs/src/cache/schema.rs`
- Create: `packages/core-rs/src/cache/store.rs`
- Create: `packages/core-rs/tests/cache_migration_test.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 5.1: Write failing test for migration runner**

Create `packages/core-rs/tests/cache_migration_test.rs`:

```rust
use rovenue::cache::CacheStore;
use tempfile::tempdir;

#[test]
fn opens_fresh_db_runs_all_migrations() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).expect("open fresh db");
    assert_eq!(store.schema_version().unwrap(), 1);
}

#[test]
fn reopens_existing_db_idempotently() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let _a = CacheStore::open(&path).unwrap();
    let b = CacheStore::open(&path).expect("reopen existing");
    assert_eq!(b.schema_version().unwrap(), 1);
}

#[test]
fn creates_expected_tables() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).unwrap();
    for table in ["schema_meta", "identity", "entitlements", "etag_cache"] {
        let exists = store.has_table(table).unwrap();
        assert!(exists, "table `{table}` must exist after migrations");
    }
}
```

- [ ] **Step 5.2: Run, see compile failure**

Run: `cargo test -p librovenue --test cache_migration_test`
Expected: FAIL — `cache` module missing.

- [ ] **Step 5.3: Create schema module**

Create `packages/core-rs/src/cache/schema.rs`:

```rust
pub const MIGRATION_V1: &str = r#"
CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY
);

CREATE TABLE identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anon_id TEXT NOT NULL,
    known_user_id TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE entitlements (
    user_scope TEXT NOT NULL,
    entitlement_id TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    product_id TEXT,
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_scope, entitlement_id)
);

CREATE TABLE etag_cache (
    resource TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT INTO schema_meta (version) VALUES (1);
"#;

pub const MIGRATIONS: &[&str] = &[MIGRATION_V1];
pub const LATEST: u32 = 1;
```

- [ ] **Step 5.4: Create store module**

Create `packages/core-rs/src/cache/store.rs`:

```rust
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{RovenueError, RovenueResult};

use super::schema::{MIGRATIONS, LATEST};

pub struct CacheStore {
    conn: Mutex<Connection>,
}

impl CacheStore {
    pub fn open(path: &Path) -> RovenueResult<Self> {
        let conn = Connection::open(path).map_err(|_| RovenueError::Storage)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        Self::run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> RovenueResult<Self> {
        let conn = Connection::open_in_memory().map_err(|_| RovenueError::Storage)?;
        Self::run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn run_migrations(conn: &Connection) -> RovenueResult<()> {
        // schema_meta may not exist on a fresh db; treat absence as version 0.
        let current: u32 = conn
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);

        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            let target = idx as u32 + 1;
            if current < target {
                conn.execute_batch(sql).map_err(|_| RovenueError::Storage)?;
            }
        }
        Ok(())
    }

    pub fn schema_version(&self) -> RovenueResult<u32> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| r.get::<_, u32>(0))
            .map_err(|_| RovenueError::Storage)
    }

    pub fn has_table(&self, name: &str) -> RovenueResult<bool> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let count: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(|_| RovenueError::Storage)?;
        Ok(count > 0)
    }

    /// Internal accessor used by sibling modules (identity, entitlements, etag).
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> RovenueResult<R> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        f(&guard).map_err(|_| RovenueError::Storage)
    }

    /// Latest schema version the binary knows how to apply.
    pub const fn latest_schema_version() -> u32 {
        LATEST
    }
}
```

- [ ] **Step 5.5: Create module root**

Create `packages/core-rs/src/cache/mod.rs`:

```rust
pub mod schema;
pub mod store;

pub use store::CacheStore;
```

- [ ] **Step 5.6: Declare in lib.rs**

Add `pub mod cache;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 5.7: Run the test**

Run: `cargo test -p librovenue --test cache_migration_test`
Expected: 3 passed.

- [ ] **Step 5.8: Commit**

```
git add packages/core-rs/src/cache packages/core-rs/src/lib.rs packages/core-rs/tests/cache_migration_test.rs
git commit -m "feat(core-rs): CacheStore opens SQLite + runs schema v1 migrations"
```

---

## Task 6: CacheStore — identity row

**Files:**
- Create: `packages/core-rs/src/cache/identity.rs`
- Modify: `packages/core-rs/src/cache/mod.rs`
- Create: `packages/core-rs/tests/cache_identity_test.rs`

- [ ] **Step 6.1: Write the failing test**

Create `packages/core-rs/tests/cache_identity_test.rs`:

```rust
use rovenue::cache::CacheStore;
use rovenue::cache::identity::{IdentityRow, IdentityRepo};

#[test]
fn no_identity_returns_none() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    assert!(repo.load().unwrap().is_none());
}

#[test]
fn persist_and_reload() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    let row = IdentityRow {
        anon_id: "anon_abc".into(),
        known_user_id: None,
        created_at_ms: 1_700_000_000_000,
    };
    repo.save(&row).unwrap();
    let loaded = repo.load().unwrap().unwrap();
    assert_eq!(loaded.anon_id, "anon_abc");
    assert!(loaded.known_user_id.is_none());
    assert_eq!(loaded.created_at_ms, 1_700_000_000_000);
}

#[test]
fn save_is_upsert_keeps_one_row() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    let mut row = IdentityRow {
        anon_id: "anon_abc".into(),
        known_user_id: None,
        created_at_ms: 1,
    };
    repo.save(&row).unwrap();
    row.known_user_id = Some("user_42".into());
    repo.save(&row).unwrap();
    let count: i64 = store
        .with_conn(|c| c.query_row("SELECT COUNT(*) FROM identity", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 1);
    let loaded = repo.load().unwrap().unwrap();
    assert_eq!(loaded.known_user_id.as_deref(), Some("user_42"));
}
```

- [ ] **Step 6.2: Run, see failure**

Run: `cargo test -p librovenue --test cache_identity_test`
Expected: FAIL — `identity` module missing.

- [ ] **Step 6.3: Implement repo**

Create `packages/core-rs/src/cache/identity.rs`:

```rust
use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone)]
pub struct IdentityRow {
    pub anon_id: String,
    pub known_user_id: Option<String>,
    pub created_at_ms: u64,
}

pub struct IdentityRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> IdentityRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn load(&self) -> RovenueResult<Option<IdentityRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT anon_id, known_user_id, created_at_ms FROM identity WHERE id = 1",
            )?;
            let mut rows = stmt.query([])?;
            if let Some(r) = rows.next()? {
                Ok(Some(IdentityRow {
                    anon_id: r.get(0)?,
                    known_user_id: r.get(1)?,
                    created_at_ms: r.get(2)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn save(&self, row: &IdentityRow) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO identity (id, anon_id, known_user_id, created_at_ms)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    anon_id = excluded.anon_id,
                    known_user_id = excluded.known_user_id,
                    created_at_ms = excluded.created_at_ms",
                params![row.anon_id, row.known_user_id, row.created_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
```

- [ ] **Step 6.4: Expose from cache::mod**

Edit `packages/core-rs/src/cache/mod.rs`:

```rust
pub mod identity;
pub mod schema;
pub mod store;

pub use store::CacheStore;
```

- [ ] **Step 6.5: Verify**

Run: `cargo test -p librovenue --test cache_identity_test`
Expected: 3 passed.

- [ ] **Step 6.6: Commit**

```
git add packages/core-rs/src/cache/identity.rs packages/core-rs/src/cache/mod.rs packages/core-rs/tests/cache_identity_test.rs
git commit -m "feat(core-rs): identity row repo (single-row upsert)"
```

---

## Task 7: CacheStore — entitlements + etag

**Files:**
- Create: `packages/core-rs/src/cache/entitlements.rs`
- Create: `packages/core-rs/src/cache/etag.rs`
- Modify: `packages/core-rs/src/cache/mod.rs`
- Create: `packages/core-rs/tests/cache_entitlements_test.rs`

- [ ] **Step 7.1: Write failing test**

Create `packages/core-rs/tests/cache_entitlements_test.rs`:

```rust
use rovenue::cache::CacheStore;
use rovenue::cache::entitlements::{EntitlementRow, EntitlementsRepo};
use rovenue::cache::etag::EtagRepo;

#[test]
fn upsert_and_get_one() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    let row = EntitlementRow {
        entitlement_id: "pro".into(),
        is_active: true,
        product_id: Some("monthly".into()),
        expires_at_ms: Some(1_700_000_000_000),
        updated_at_ms: 1,
    };
    repo.upsert_many("user_42", &[row.clone()]).unwrap();
    let got = repo.get("user_42", "pro").unwrap().unwrap();
    assert!(got.is_active);
    assert_eq!(got.entitlement_id, "pro");
    assert_eq!(got.product_id.as_deref(), Some("monthly"));
}

#[test]
fn list_all_for_user_scope() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    repo.upsert_many(
        "user_42",
        &[
            EntitlementRow {
                entitlement_id: "pro".into(),
                is_active: true,
                product_id: None,
                expires_at_ms: None,
                updated_at_ms: 1,
            },
            EntitlementRow {
                entitlement_id: "lifetime".into(),
                is_active: true,
                product_id: None,
                expires_at_ms: None,
                updated_at_ms: 1,
            },
        ],
    )
    .unwrap();
    repo.upsert_many(
        "other",
        &[EntitlementRow {
            entitlement_id: "pro".into(),
            is_active: true,
            product_id: None,
            expires_at_ms: None,
            updated_at_ms: 1,
        }],
    )
    .unwrap();
    let mut got: Vec<String> = repo
        .list("user_42")
        .unwrap()
        .into_iter()
        .map(|e| e.entitlement_id)
        .collect();
    got.sort();
    assert_eq!(got, vec!["lifetime", "pro"]);
}

#[test]
fn etag_roundtrip() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EtagRepo::new(&store);
    assert!(repo.get("entitlements").unwrap().is_none());
    repo.put("entitlements", "abc123", 100).unwrap();
    assert_eq!(repo.get("entitlements").unwrap().as_deref(), Some("abc123"));
    repo.put("entitlements", "def456", 200).unwrap();
    assert_eq!(repo.get("entitlements").unwrap().as_deref(), Some("def456"));
}
```

- [ ] **Step 7.2: Run, see failure**

Run: `cargo test -p librovenue --test cache_entitlements_test`
Expected: FAIL — modules missing.

- [ ] **Step 7.3: Implement entitlements repo**

Create `packages/core-rs/src/cache/entitlements.rs`:

```rust
use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone)]
pub struct EntitlementRow {
    pub entitlement_id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub updated_at_ms: u64,
}

pub struct EntitlementsRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> EntitlementsRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn upsert_many(&self, user_scope: &str, rows: &[EntitlementRow]) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO entitlements
                       (user_scope, entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(user_scope, entitlement_id) DO UPDATE SET
                       is_active = excluded.is_active,
                       product_id = excluded.product_id,
                       expires_at_ms = excluded.expires_at_ms,
                       updated_at_ms = excluded.updated_at_ms",
                )?;
                for r in rows {
                    stmt.execute(params![
                        user_scope,
                        r.entitlement_id,
                        r.is_active as i64,
                        r.product_id,
                        r.expires_at_ms.map(|v| v as i64),
                        r.updated_at_ms as i64,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn get(&self, user_scope: &str, entitlement_id: &str) -> RovenueResult<Option<EntitlementRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms
                 FROM entitlements WHERE user_scope = ?1 AND entitlement_id = ?2",
            )?;
            let mut rows = stmt.query(params![user_scope, entitlement_id])?;
            if let Some(r) = rows.next()? {
                Ok(Some(EntitlementRow {
                    entitlement_id: r.get(0)?,
                    is_active: r.get::<_, i64>(1)? != 0,
                    product_id: r.get(2)?,
                    expires_at_ms: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    updated_at_ms: r.get::<_, i64>(4)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list(&self, user_scope: &str) -> RovenueResult<Vec<EntitlementRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms
                 FROM entitlements WHERE user_scope = ?1",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                out.push(EntitlementRow {
                    entitlement_id: r.get(0)?,
                    is_active: r.get::<_, i64>(1)? != 0,
                    product_id: r.get(2)?,
                    expires_at_ms: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    updated_at_ms: r.get::<_, i64>(4)? as u64,
                });
            }
            Ok(out)
        })
    }
}
```

- [ ] **Step 7.4: Implement etag repo**

Create `packages/core-rs/src/cache/etag.rs`:

```rust
use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

pub struct EtagRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> EtagRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, resource: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare("SELECT etag FROM etag_cache WHERE resource = ?1")?;
            let mut rows = stmt.query(params![resource])?;
            if let Some(r) = rows.next()? {
                Ok(Some(r.get::<_, String>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn put(&self, resource: &str, etag: &str, updated_at_ms: u64) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO etag_cache (resource, etag, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(resource) DO UPDATE SET
                   etag = excluded.etag,
                   updated_at_ms = excluded.updated_at_ms",
                params![resource, etag, updated_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
```

- [ ] **Step 7.5: Update cache::mod**

Edit `packages/core-rs/src/cache/mod.rs`:

```rust
pub mod entitlements;
pub mod etag;
pub mod identity;
pub mod schema;
pub mod store;

pub use store::CacheStore;
```

- [ ] **Step 7.6: Verify**

Run: `cargo test -p librovenue --test cache_entitlements_test`
Expected: 3 passed.

- [ ] **Step 7.7: Commit**

```
git add packages/core-rs/src/cache packages/core-rs/tests/cache_entitlements_test.rs
git commit -m "feat(core-rs): entitlements + etag repos"
```

---

## Task 8: IdentityManager — anon_id gen + identify()

**Files:**
- Create: `packages/core-rs/src/identity.rs`
- Modify: `packages/core-rs/src/lib.rs`
- Create: `packages/core-rs/tests/identity_test.rs`

- [ ] **Step 8.1: Write failing test**

Create `packages/core-rs/tests/identity_test.rs`:

```rust
use std::sync::{Arc, Mutex};

use rovenue::cache::CacheStore;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

fn fresh() -> (Arc<CacheStore>, Arc<ObserverBus>, IdentityManager) {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let mgr = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    (store, bus, mgr)
}

#[test]
fn first_load_generates_anon_id() {
    let (_, _, mgr) = fresh();
    let u = mgr.current_user();
    assert!(u.anon_id.starts_with("anon_"));
    assert!(u.known_user_id.is_none());
}

#[test]
fn anon_id_persists_across_open() {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let mgr1 = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    let first = mgr1.current_user().anon_id.clone();
    let mgr2 = IdentityManager::new(Arc::clone(&store), Arc::clone(&bus), Arc::new(SystemClock));
    assert_eq!(mgr2.current_user().anon_id, first);
}

#[test]
fn identify_sets_known_id_and_emits() {
    let (_, bus, mgr) = fresh();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    mgr.identify("user_42".into()).unwrap();
    let u = mgr.current_user();
    assert_eq!(u.known_user_id.as_deref(), Some("user_42"));
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::IdentityChanged));
}

#[test]
fn identify_is_idempotent_for_same_known_id() {
    let (_, bus, mgr) = fresh();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    mgr.identify("user_42".into()).unwrap();
    mgr.identify("user_42".into()).unwrap();
    let n = cap.0.lock().unwrap().iter().filter(|e| **e == ChangeEvent::IdentityChanged).count();
    assert_eq!(n, 1, "second identify with same id should not re-emit");
}

#[test]
fn current_user_returns_known_id_for_scope_when_present() {
    let (_, _, mgr) = fresh();
    let scope_before = mgr.current_user_scope();
    mgr.identify("user_42".into()).unwrap();
    let scope_after = mgr.current_user_scope();
    assert_ne!(scope_before, scope_after);
    assert_eq!(scope_after, "user_42");
}
```

- [ ] **Step 8.2: Run, see failure**

Run: `cargo test -p librovenue --test identity_test`
Expected: FAIL — identity module missing.

- [ ] **Step 8.3: Implement IdentityManager**

Create `packages/core-rs/src/identity.rs`:

```rust
use std::sync::{Arc, Mutex};

use crate::cache::identity::{IdentityRepo, IdentityRow};
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;

#[derive(Debug, Clone)]
pub struct User {
    pub anon_id: String,
    pub known_user_id: Option<String>,
}

pub struct IdentityManager {
    store: Arc<CacheStore>,
    bus: Arc<ObserverBus>,
    clock: Arc<dyn Clock>,
    cached: Mutex<User>,
}

impl IdentityManager {
    pub fn new(store: Arc<CacheStore>, bus: Arc<ObserverBus>, clock: Arc<dyn Clock>) -> Self {
        let repo = IdentityRepo::new(&store);
        let row = match repo.load().ok().flatten() {
            Some(r) => r,
            None => {
                let new_row = IdentityRow {
                    anon_id: format!("anon_{}", cuid2::create_id()),
                    known_user_id: None,
                    created_at_ms: clock.now_unix_ms(),
                };
                repo.save(&new_row).expect("persist initial identity");
                new_row
            }
        };
        let user = User {
            anon_id: row.anon_id,
            known_user_id: row.known_user_id,
        };
        Self {
            store,
            bus,
            clock,
            cached: Mutex::new(user),
        }
    }

    pub fn current_user(&self) -> User {
        self.cached.lock().expect("identity mutex poisoned").clone()
    }

    /// The user scope used by the cache layer — `known_user_id` if identified, else `anon_id`.
    pub fn current_user_scope(&self) -> String {
        let u = self.cached.lock().expect("identity mutex poisoned");
        u.known_user_id.clone().unwrap_or_else(|| u.anon_id.clone())
    }

    pub fn identify(&self, known_user_id: String) -> RovenueResult<()> {
        if known_user_id.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey); // reuse "invalid input" semantic
        }
        let changed = {
            let mut u = self.cached.lock().expect("identity mutex poisoned");
            if u.known_user_id.as_deref() == Some(known_user_id.as_str()) {
                false
            } else {
                u.known_user_id = Some(known_user_id.clone());
                true
            }
        };
        if changed {
            let row = IdentityRow {
                anon_id: self.cached.lock().expect("identity mutex poisoned").anon_id.clone(),
                known_user_id: Some(known_user_id),
                created_at_ms: self.clock.now_unix_ms(),
            };
            IdentityRepo::new(&self.store).save(&row)?;
            self.bus.emit(ChangeEvent::IdentityChanged);
        }
        Ok(())
    }
}
```

- [ ] **Step 8.4: Wire into lib**

Add `pub mod identity;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 8.5: Verify**

Run: `cargo test -p librovenue --test identity_test`
Expected: 5 passed.

- [ ] **Step 8.6: Commit**

```
git add packages/core-rs/src/identity.rs packages/core-rs/src/lib.rs packages/core-rs/tests/identity_test.rs
git commit -m "feat(core-rs): IdentityManager — anon gen, identify, client-local merge"
```

---

## Task 9: Retry policy classifier

**Files:**
- Create: `packages/core-rs/src/transport/mod.rs`
- Create: `packages/core-rs/src/transport/retry.rs`
- Create: `packages/core-rs/tests/retry_test.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 9.1: Write failing test**

Create `packages/core-rs/tests/retry_test.rs`:

```rust
use std::time::Duration;

use rovenue::transport::retry::{classify, RetryDecision};

#[test]
fn five_hundreds_are_retryable() {
    let d = classify(Some(503), None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn forbidden_is_fatal() {
    let d = classify(Some(403), None);
    assert!(matches!(d, RetryDecision::Fatal));
}

#[test]
fn rate_limited_honors_retry_after() {
    let d = classify(Some(429), Some(Duration::from_secs(5)));
    assert!(matches!(d, RetryDecision::RetryAfter(_)));
    if let RetryDecision::RetryAfter(d) = d {
        assert_eq!(d, Duration::from_secs(5));
    }
}

#[test]
fn rate_limited_without_header_is_retryable_with_default() {
    let d = classify(Some(429), None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn network_failure_is_retryable() {
    let d = classify(None, None);
    assert!(matches!(d, RetryDecision::Retryable));
}

#[test]
fn conflict_is_success() {
    let d = classify(Some(409), None);
    assert!(matches!(d, RetryDecision::Success));
}
```

- [ ] **Step 9.2: Run, see failure**

Run: `cargo test -p librovenue --test retry_test`
Expected: FAIL.

- [ ] **Step 9.3: Implement retry classifier**

Create `packages/core-rs/src/transport/retry.rs`:

```rust
use std::time::Duration;

/// What to do with an HTTP attempt's outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum RetryDecision {
    /// Treat as success (e.g. 409 duplicate).
    Success,
    /// Should be retried with normal exponential backoff.
    Retryable,
    /// Should be retried only after the specified duration (server-driven).
    RetryAfter(Duration),
    /// Do not retry — surface immediately.
    Fatal,
}

/// `status = None` indicates a network-level failure (no response).
pub fn classify(status: Option<u16>, retry_after: Option<Duration>) -> RetryDecision {
    match status {
        None => RetryDecision::Retryable,
        Some(s) if (500..600).contains(&s) => RetryDecision::Retryable,
        Some(429) => match retry_after {
            Some(d) => RetryDecision::RetryAfter(d),
            None => RetryDecision::Retryable,
        },
        Some(409) => RetryDecision::Success,
        Some(s) if (400..500).contains(&s) => RetryDecision::Fatal,
        Some(_) => RetryDecision::Success,
    }
}

/// Compute backoff for attempt index (0-based). exp 1s→2s→4s…, jitter ±20%, cap 5min.
pub fn backoff(attempt: u32, rng: &mut impl rand::RngCore) -> Duration {
    use rand::Rng;
    let base = (1u64 << attempt.min(8)).saturating_mul(1000);
    let capped = base.min(5 * 60 * 1000);
    let jitter: i64 = rng.gen_range(-((capped as i64) / 5)..=((capped as i64) / 5));
    let total = (capped as i64 + jitter).max(0) as u64;
    Duration::from_millis(total)
}
```

- [ ] **Step 9.4: Module wiring**

Create `packages/core-rs/src/transport/mod.rs`:

```rust
pub mod retry;
```

Add `pub mod transport;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 9.5: Verify**

Run: `cargo test -p librovenue --test retry_test`
Expected: 6 passed.

- [ ] **Step 9.6: Commit**

```
git add packages/core-rs/src/transport packages/core-rs/src/lib.rs packages/core-rs/tests/retry_test.rs
git commit -m "feat(core-rs): HTTP retry classifier + exponential backoff"
```

---

## Task 10: HttpClient — base + auth + retry loop

**Files:**
- Create: `packages/core-rs/src/transport/http_client.rs`
- Create: `packages/core-rs/src/transport/types.rs`
- Modify: `packages/core-rs/src/transport/mod.rs`
- Create: `packages/core-rs/tests/http_client_test.rs`

- [ ] **Step 10.1: Write failing tests against mockito**

Create `packages/core-rs/tests/http_client_test.rs`:

```rust
use std::time::Duration;

use rovenue::transport::http_client::{HttpClient, HttpRequest};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct DummyEntitlements {
    entitlements: Vec<String>,
}

fn client(server_url: &str) -> HttpClient {
    HttpClient::new(server_url.to_string(), "pk_test_abc".into())
        .with_max_attempts(2)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn happy_path_get_returns_body_and_etag() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"abc\"")
        .with_body(r#"{"entitlements": ["pro"]}"#)
        .match_header("authorization", "Bearer pk_test_abc")
        .match_header("x-rovenue-user", "anon_123")
        .create();

    let c = client(&server.url());
    let resp = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.etag.as_deref(), Some("\"abc\""));
    assert_eq!(resp.body.unwrap().entitlements, vec!["pro"]);
    m.assert();
}

#[test]
fn if_none_match_header_added_when_etag_provided() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .match_header("if-none-match", "\"abc\"")
        .with_status(304)
        .create();

    let c = client(&server.url());
    let resp = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements")
                .user_scope("anon_123")
                .etag("\"abc\""),
        )
        .unwrap();
    assert_eq!(resp.status, 304);
    assert!(resp.body.is_none(), "304 has no body");
    m.assert();
}

#[test]
fn retries_on_503_then_succeeds() {
    let mut server = mockito::Server::new();
    let m1 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(503)
        .expect(1)
        .create();
    let m2 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"entitlements": []}"#)
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3).with_min_backoff(Duration::from_millis(1));
    let resp = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap();
    assert_eq!(resp.status, 200);
    m1.assert();
    m2.assert();
}

#[test]
fn forbidden_is_fatal_no_retry() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(403)
        .expect(1) // not retried
        .create();

    let c = client(&server.url()).with_max_attempts(5);
    let err = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::ServerError));
    m.assert();
}

#[test]
fn rate_limit_returns_rate_limited_error() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "1")
        .expect(1) // we don't actually wait — first 429 → RateLimited error to caller
        .create();

    let c = client(&server.url()).with_max_attempts(1);
    let err = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::RateLimited));
    m.assert();
}
```

- [ ] **Step 10.2: Run, see failure**

Run: `cargo test -p librovenue --test http_client_test`
Expected: FAIL — http_client module missing.

- [ ] **Step 10.3: Implement types**

Create `packages/core-rs/src/transport/types.rs`:

```rust
use serde::de::DeserializeOwned;

pub struct HttpRequest<'a> {
    pub path: &'a str,
    pub user_scope: Option<&'a str>,
    pub etag: Option<&'a str>,
}

impl<'a> HttpRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self { path, user_scope: None, etag: None }
    }
    pub fn user_scope(mut self, scope: &'a str) -> Self {
        self.user_scope = Some(scope);
        self
    }
    pub fn etag(mut self, etag: &'a str) -> Self {
        self.etag = Some(etag);
        self
    }
}

pub struct HttpResponse<T> {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Option<T>,
}

#[allow(dead_code)]
pub(crate) fn _assert_deserialize<T: DeserializeOwned>() {}
```

- [ ] **Step 10.4: Implement client**

Create `packages/core-rs/src/transport/http_client.rs`:

```rust
use std::time::Duration;

use reqwest::blocking::Client;
use serde::de::DeserializeOwned;

use crate::error::{RovenueError, RovenueResult};

use super::retry::{backoff, classify, RetryDecision};
use super::types::{HttpRequest, HttpResponse};

pub struct HttpClient {
    base_url: String,
    api_key: String,
    inner: Client,
    max_attempts: u32,
    min_backoff: Duration,
    request_timeout: Duration,
}

impl HttpClient {
    pub fn new(base_url: String, api_key: String) -> Self {
        Self {
            base_url,
            api_key,
            inner: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("reqwest blocking client"),
            max_attempts: 3,
            min_backoff: Duration::from_millis(50),
            request_timeout: Duration::from_secs(10),
        }
    }

    pub fn with_max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = n.max(1);
        self
    }

    pub fn with_min_backoff(mut self, d: Duration) -> Self {
        self.min_backoff = d;
        self
    }

    pub fn with_request_timeout(mut self, d: Duration) -> Self {
        self.request_timeout = d;
        self.inner = Client::builder()
            .timeout(d)
            .build()
            .expect("reqwest blocking client");
        self
    }

    pub fn get_json<T: DeserializeOwned>(&self, req: HttpRequest<'_>) -> RovenueResult<HttpResponse<T>> {
        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable;

        for attempt in 0..self.max_attempts {
            let mut builder = self
                .inner
                .get(&url)
                .header("Authorization", format!("Bearer {}", self.api_key));
            if let Some(scope) = req.user_scope {
                builder = builder.header("X-Rovenue-User", scope);
            }
            if let Some(etag) = req.etag {
                builder = builder.header("If-None-Match", etag);
            }

            match builder.send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(Duration::from_secs);
                    let etag_out = resp
                        .headers()
                        .get("ETag")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);

                    match classify(Some(status), retry_after) {
                        RetryDecision::Success => {
                            let body = if status == 304 || status == 204 {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal)?)
                            };
                            return Ok(HttpResponse { status, etag: etag_out, body });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError
                            } else {
                                RovenueError::NetworkUnavailable
                            };
                            // backoff before next attempt (if any)
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(_) => {
                            // For M1 we surface 429 to the caller; M2+ can honor + retry within budget.
                            return Err(RovenueError::RateLimited);
                        }
                        RetryDecision::Fatal => {
                            return Err(if status == 401 {
                                RovenueError::InvalidApiKey
                            } else {
                                RovenueError::ServerError
                            });
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }

        Err(last_err)
    }
}
```

For 304, the `T: DeserializeOwned` bound is still fine — we don't actually deserialize when body is None.

- [ ] **Step 10.5: Expose from transport::mod**

Replace `packages/core-rs/src/transport/mod.rs`:

```rust
pub mod http_client;
pub mod retry;
pub mod types;
```

- [ ] **Step 10.6: Verify**

Run: `cargo test -p librovenue --test http_client_test`
Expected: 5 passed.

- [ ] **Step 10.7: Commit**

```
git add packages/core-rs/src/transport packages/core-rs/tests/http_client_test.rs
git commit -m "feat(core-rs): blocking HttpClient with auth, retry, ETag, 429"
```

---

## Task 11: EntitlementReader — types + cache read

**Files:**
- Create: `packages/core-rs/src/entitlements/mod.rs`
- Create: `packages/core-rs/src/entitlements/types.rs`
- Create: `packages/core-rs/src/entitlements/api.rs`
- Create: `packages/core-rs/src/entitlements/reader.rs`
- Modify: `packages/core-rs/src/lib.rs`

For this task we land **cache-first reads only** (refresh in Task 12). Pure-Rust unit tests, no HTTP.

- [ ] **Step 11.1: Write the types and API mapping**

Create `packages/core-rs/src/entitlements/types.rs`:

```rust
use serde::Deserialize;

/// FFI-visible entitlement projection.
#[derive(Debug, Clone, PartialEq)]
pub struct Entitlement {
    pub id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    pub expires_at_ms: Option<u64>,
}

/// Wire model the server returns.
#[derive(Debug, Deserialize)]
pub struct EntitlementWire {
    pub id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    #[serde(rename = "expires_at_ms")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct EntitlementsResponse {
    pub entitlements: Vec<EntitlementWire>,
}
```

Create `packages/core-rs/src/entitlements/api.rs`:

```rust
use crate::cache::entitlements::EntitlementRow;

use super::types::EntitlementWire;

pub fn wire_to_row(w: EntitlementWire, updated_at_ms: u64) -> EntitlementRow {
    EntitlementRow {
        entitlement_id: w.id,
        is_active: w.is_active,
        product_id: w.product_id,
        expires_at_ms: w.expires_at_ms,
        updated_at_ms,
    }
}
```

- [ ] **Step 11.2: Implement reader (cache-only for now)**

Create `packages/core-rs/src/entitlements/reader.rs`:

```rust
use std::sync::Arc;

use crate::cache::entitlements::EntitlementsRepo;
use crate::cache::CacheStore;
use crate::error::RovenueResult;
use crate::identity::IdentityManager;

use super::types::Entitlement;

pub struct EntitlementReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
}

impl EntitlementReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self { store, identity }
    }

    pub fn get(&self, id: &str) -> RovenueResult<Option<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.get(&scope, id)?.map(row_to_entitlement))
    }

    pub fn list_all(&self) -> RovenueResult<Vec<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.list(&scope)?.into_iter().map(row_to_entitlement).collect())
    }
}

fn row_to_entitlement(r: crate::cache::entitlements::EntitlementRow) -> Entitlement {
    Entitlement {
        id: r.entitlement_id,
        is_active: r.is_active,
        product_id: r.product_id,
        expires_at_ms: r.expires_at_ms,
    }
}
```

- [ ] **Step 11.3: Module root**

Create `packages/core-rs/src/entitlements/mod.rs`:

```rust
pub mod api;
pub mod reader;
pub mod types;

pub use reader::EntitlementReader;
pub use types::Entitlement;
```

Add `pub mod entitlements;` and `pub use entitlements::Entitlement;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 11.4: Sanity check**

Run: `cargo build -p librovenue`
Expected: clean build.

- [ ] **Step 11.5: Commit**

```
git add packages/core-rs/src/entitlements packages/core-rs/src/lib.rs
git commit -m "feat(core-rs): EntitlementReader cache-first reads"
```

---

## Task 12: EntitlementReader — refresh from HTTP + observer emit

**Files:**
- Modify: `packages/core-rs/src/entitlements/reader.rs`
- Create: `packages/core-rs/tests/fixtures/entitlements_response.json`
- Create: `packages/core-rs/tests/entitlement_read_test.rs`

- [ ] **Step 12.1: Create fixture**

Create `packages/core-rs/tests/fixtures/entitlements_response.json`:

```json
{
  "entitlements": [
    {"id": "pro", "is_active": true, "product_id": "monthly", "expires_at_ms": 1900000000000},
    {"id": "lifetime", "is_active": false, "product_id": null, "expires_at_ms": null}
  ]
}
```

- [ ] **Step 12.2: Write failing integration test**

Create `packages/core-rs/tests/entitlement_read_test.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::entitlements::EntitlementReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn refresh_populates_cache_and_emits_observer() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/entitlements_response.json");
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"v1\"")
        .with_body(body)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let reader = EntitlementReader::new(
        Arc::clone(&store),
        Arc::clone(&identity),
    )
    .with_http(Arc::new(http_client(&server.url())))
    .with_observer_bus(Arc::clone(&bus))
    .with_clock(Arc::new(SystemClock));

    // First read: empty cache → None.
    assert!(reader.get("pro").unwrap().is_none());

    // Refresh: hits HTTP, populates cache, emits observer.
    reader.refresh().unwrap();
    m.assert();

    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::EntitlementsChanged));

    let pro = reader.get("pro").unwrap().unwrap();
    assert!(pro.is_active);
    assert_eq!(pro.product_id.as_deref(), Some("monthly"));

    let all = reader.list_all().unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn second_refresh_sends_if_none_match_and_is_no_op_on_304() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/entitlements_response.json");
    let first = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"v1\"")
        .with_body(body)
        .expect(1)
        .create();
    let second = server
        .mock("GET", "/v1/me/entitlements")
        .match_header("if-none-match", "\"v1\"")
        .with_status(304)
        .expect(1)
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let reader = EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(Arc::new(http_client(&server.url())))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    reader.refresh().unwrap();
    let initial_events = cap.0.lock().unwrap().len();

    reader.refresh().unwrap();
    let after_events = cap.0.lock().unwrap().len();
    assert_eq!(after_events, initial_events, "304 must not emit a change");

    first.assert();
    second.assert();
}
```

- [ ] **Step 12.3: Run, see failure**

Run: `cargo test -p librovenue --test entitlement_read_test`
Expected: FAIL — `with_http`, `refresh`, etc. not defined.

- [ ] **Step 12.4: Extend reader**

Replace `packages/core-rs/src/entitlements/reader.rs`:

```rust
use std::sync::Arc;

use crate::cache::entitlements::EntitlementsRepo;
use crate::cache::etag::EtagRepo;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::api::wire_to_row;
use super::types::{Entitlement, EntitlementsResponse};

const RESOURCE: &str = "entitlements";

pub struct EntitlementReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
}

impl EntitlementReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self { store, identity, http: None, bus: None, clock: None }
    }

    pub fn with_http(mut self, http: Arc<HttpClient>) -> Self {
        self.http = Some(http);
        self
    }
    pub fn with_observer_bus(mut self, bus: Arc<ObserverBus>) -> Self {
        self.bus = Some(bus);
        self
    }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = Some(clock);
        self
    }

    pub fn get(&self, id: &str) -> RovenueResult<Option<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.get(&scope, id)?.map(row_to_entitlement))
    }

    pub fn list_all(&self) -> RovenueResult<Vec<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.list(&scope)?.into_iter().map(row_to_entitlement).collect())
    }

    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;

        let scope = self.identity.current_user_scope();
        let etag_repo = EtagRepo::new(&self.store);
        let prior_etag = etag_repo.get(RESOURCE)?;

        let mut req = HttpRequest::new("/v1/me/entitlements").user_scope(&scope);
        if let Some(ref e) = prior_etag {
            req = req.etag(e);
        }

        let resp = http.get_json::<EntitlementsResponse>(req)?;

        if resp.status == 304 {
            return Ok(()); // not modified — no observer fire
        }

        let body = resp.body.ok_or(RovenueError::Internal)?;
        let now = clock.now_unix_ms();
        let rows: Vec<_> = body
            .entitlements
            .into_iter()
            .map(|w| wire_to_row(w, now))
            .collect();

        EntitlementsRepo::new(&self.store).upsert_many(&scope, &rows)?;
        if let Some(etag) = resp.etag {
            etag_repo.put(RESOURCE, &etag, now)?;
        }

        if let Some(bus) = &self.bus {
            bus.emit(ChangeEvent::EntitlementsChanged);
        }

        Ok(())
    }
}

fn row_to_entitlement(r: crate::cache::entitlements::EntitlementRow) -> Entitlement {
    Entitlement {
        id: r.entitlement_id,
        is_active: r.is_active,
        product_id: r.product_id,
        expires_at_ms: r.expires_at_ms,
    }
}
```

- [ ] **Step 12.5: Run integration test**

Run: `cargo test -p librovenue --test entitlement_read_test`
Expected: 2 passed.

- [ ] **Step 12.6: Commit**

```
git add packages/core-rs/src/entitlements/reader.rs packages/core-rs/tests/fixtures packages/core-rs/tests/entitlement_read_test.rs
git commit -m "feat(core-rs): EntitlementReader.refresh — HTTP+ETag+observer"
```

---

## Task 13: PollingScheduler

**Files:**
- Create: `packages/core-rs/src/polling/mod.rs`
- Create: `packages/core-rs/src/polling/scheduler.rs`
- Modify: `packages/core-rs/src/lib.rs`
- Create: `packages/core-rs/tests/polling_test.rs`

- [ ] **Step 13.1: Write failing test**

Create `packages/core-rs/tests/polling_test.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::polling::PollingScheduler;
use serial_test::serial;

#[test]
#[serial]
fn fires_when_foreground() {
    let counter = Arc::new(Mutex::new(0u32));
    let c = Arc::clone(&counter);
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(30), move || {
        *c.lock().unwrap() += 1;
    });
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(150));
    scheduler.shutdown();
    let n = *counter.lock().unwrap();
    assert!(n >= 3, "expected at least 3 ticks in 150ms, got {n}");
}

#[test]
#[serial]
fn paused_in_background() {
    let counter = Arc::new(Mutex::new(0u32));
    let c = Arc::clone(&counter);
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(20), move || {
        *c.lock().unwrap() += 1;
    });
    scheduler.set_foreground(false);
    std::thread::sleep(Duration::from_millis(100));
    let n = *counter.lock().unwrap();
    scheduler.shutdown();
    assert_eq!(n, 0, "no ticks while background");
}

#[test]
#[serial]
fn shutdown_stops_thread_cleanly() {
    let scheduler = PollingScheduler::new();
    scheduler.register("entitlements", Duration::from_millis(10), || {});
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(30));
    scheduler.shutdown();
    // If shutdown leaks, future tests in the suite will time out.
    // Calling shutdown again is a no-op.
    scheduler.shutdown();
}
```

- [ ] **Step 13.2: Run, see failure**

Run: `cargo test -p librovenue --test polling_test`
Expected: FAIL.

- [ ] **Step 13.3: Implement scheduler**

Create `packages/core-rs/src/polling/scheduler.rs`:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Tick = Arc<dyn Fn() + Send + Sync>;

struct Registration {
    interval: Duration,
    last_fired: Mutex<Option<Instant>>,
    tick: Tick,
}

pub struct PollingScheduler {
    inner: Arc<SchedulerInner>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

struct SchedulerInner {
    registrations: Mutex<Vec<(String, Arc<Registration>)>>,
    foreground: AtomicBool,
    running: AtomicBool,
}

impl PollingScheduler {
    pub fn new() -> Self {
        let inner = Arc::new(SchedulerInner {
            registrations: Mutex::new(Vec::new()),
            foreground: AtomicBool::new(false),
            running: AtomicBool::new(true),
        });
        let inner_clone = Arc::clone(&inner);
        let handle = thread::spawn(move || run_loop(inner_clone));
        Self {
            inner,
            thread: Mutex::new(Some(handle)),
        }
    }

    pub fn register(&self, name: &str, interval: Duration, tick: impl Fn() + Send + Sync + 'static) {
        let mut regs = self.inner.registrations.lock().expect("regs poisoned");
        regs.push((
            name.to_string(),
            Arc::new(Registration {
                interval,
                last_fired: Mutex::new(None),
                tick: Arc::new(tick),
            }),
        ));
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.inner.foreground.store(foreground, Ordering::SeqCst);
    }

    pub fn shutdown(&self) {
        if self.inner.running.swap(false, Ordering::SeqCst) {
            // Wake up a sleeping loop quickly.
            self.inner.foreground.store(false, Ordering::SeqCst);
        }
        let mut g = self.thread.lock().expect("thread mutex poisoned");
        if let Some(h) = g.take() {
            let _ = h.join();
        }
    }
}

impl Drop for PollingScheduler {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_loop(inner: Arc<SchedulerInner>) {
    let mut tick_resolution = Duration::from_millis(10);
    while inner.running.load(Ordering::SeqCst) {
        if !inner.foreground.load(Ordering::SeqCst) {
            thread::sleep(tick_resolution);
            continue;
        }
        let regs = inner.registrations.lock().expect("regs poisoned").clone();
        let now = Instant::now();
        for (_name, reg) in regs {
            let mut last = reg.last_fired.lock().expect("last_fired poisoned");
            let due = match *last {
                None => true,
                Some(t) => now.duration_since(t) >= reg.interval,
            };
            if due {
                *last = Some(now);
                drop(last);
                (reg.tick)();
            }
        }
        thread::sleep(tick_resolution);
        if tick_resolution < Duration::from_millis(50) {
            tick_resolution = Duration::from_millis(20);
        }
    }
}
```

- [ ] **Step 13.4: Module root**

Create `packages/core-rs/src/polling/mod.rs`:

```rust
pub mod scheduler;
pub use scheduler::PollingScheduler;
```

Add `pub mod polling;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 13.5: Verify**

Run: `cargo test -p librovenue --test polling_test`
Expected: 3 passed (`serial_test` keeps them sequential so timings don't interfere).

- [ ] **Step 13.6: Commit**

```
git add packages/core-rs/src/polling packages/core-rs/src/lib.rs packages/core-rs/tests/polling_test.rs
git commit -m "feat(core-rs): PollingScheduler thread with foreground gate"
```

---

## Task 14: Wire RovenueCore — register_observer, refresh, set_foreground

**Files:**
- Modify: `packages/core-rs/src/api.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/src/lib.rs`
- Modify: `packages/core-rs/tests/integration_smoke.rs`

This task extends the FFI surface but **does not** auto-start the polling scheduler — `set_foreground(true)` is what kicks it off. The scheduler is created and given an Arc-cloned `EntitlementReader::refresh` closure at `RovenueCore::new` time.

- [ ] **Step 14.1: Write failing extension to smoke test**

Replace the contents of `packages/core-rs/tests/integration_smoke.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::observer::{ChangeEvent, Observer};
use rovenue::{Config, RovenueCore, SDK_VERSION};

#[test]
fn core_new_returns_handle() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).expect("core must construct");
    assert_eq!(core.get_version(), SDK_VERSION);
}

#[test]
fn current_user_has_anon_id_by_default() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).unwrap();
    let u = core.current_user();
    assert!(u.anon_id.starts_with("anon_"));
}

#[test]
fn identify_then_current_user_reflects_known_id() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).unwrap();
    core.identify("user_42".into()).unwrap();
    assert_eq!(core.current_user().known_user_id.as_deref(), Some("user_42"));
}

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

#[test]
fn register_observer_receives_identify() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).unwrap();
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    core.register_observer(Arc::clone(&cap) as Arc<dyn Observer>);
    core.identify("user_42".into()).unwrap();
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::IdentityChanged));
}

#[test]
fn entitlement_returns_none_when_empty() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).unwrap();
    assert!(core.entitlement("pro".into()).is_none());
    assert_eq!(core.entitlements_all().len(), 0);
}

#[test]
fn set_foreground_runs_without_panic() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).unwrap();
    core.set_foreground(true);
    std::thread::sleep(Duration::from_millis(20));
    core.set_foreground(false);
    core.shutdown();
}
```

- [ ] **Step 14.2: Run, see failure**

Run: `cargo test -p librovenue --test integration_smoke`
Expected: FAIL — `current_user`, `identify`, `register_observer`, `entitlement`, `entitlements_all`, `set_foreground`, `shutdown` not defined.

- [ ] **Step 14.3: Extend RovenueCore**

Replace `packages/core-rs/src/api.rs`:

```rust
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::cache::CacheStore;
use crate::config::Config;
use crate::entitlements::{Entitlement, EntitlementReader};
use crate::error::{RovenueError, RovenueResult};
use crate::identity::{IdentityManager, User};
use crate::observer::{Observer, ObserverBus};
use crate::polling::PollingScheduler;
use crate::time::{Clock, SystemClock};
use crate::transport::http_client::HttpClient;
use crate::version::SDK_VERSION;

const ENTITLEMENTS_INTERVAL_MS: u64 = 30_000;

pub struct RovenueCore {
    _config: Arc<Config>,
    bus: Arc<ObserverBus>,
    identity: Arc<IdentityManager>,
    entitlements: Arc<EntitlementReader>,
    scheduler: PollingScheduler,
}

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let bus = Arc::new(ObserverBus::default());
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Arc::new(CacheStore::open(&default_db_path()?)?);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let http = Arc::new(HttpClient::new(config.base_url.clone(), config.api_key.clone()));
        let reader = Arc::new(
            EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let scheduler = PollingScheduler::new();
        {
            let reader = Arc::clone(&reader);
            scheduler.register(
                "entitlements",
                Duration::from_millis(ENTITLEMENTS_INTERVAL_MS),
                move || {
                    let _ = reader.refresh();
                },
            );
        }
        Ok(Self {
            _config: Arc::new(config),
            bus,
            identity,
            entitlements: reader,
            scheduler,
        })
    }

    pub fn get_version(&self) -> String {
        SDK_VERSION.to_string()
    }

    pub fn current_user(&self) -> User {
        self.identity.current_user()
    }

    pub fn identify(&self, known_user_id: String) -> RovenueResult<()> {
        self.identity.identify(known_user_id)
    }

    pub fn entitlement(&self, id: String) -> Option<Entitlement> {
        self.entitlements.get(&id).ok().flatten()
    }

    pub fn entitlements_all(&self) -> Vec<Entitlement> {
        self.entitlements.list_all().unwrap_or_default()
    }

    pub fn refresh_entitlements(&self) -> RovenueResult<()> {
        self.entitlements.refresh()
    }

    pub fn register_observer(&self, obs: Arc<dyn Observer>) {
        self.bus.register(obs);
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.scheduler.set_foreground(foreground);
    }

    pub fn shutdown(&self) {
        self.scheduler.shutdown();
    }
}

fn default_db_path() -> RovenueResult<PathBuf> {
    let mut p = dirs_path().ok_or(RovenueError::Storage)?;
    p.push("rovenue.db");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| RovenueError::Storage)?;
    }
    Ok(p)
}

#[cfg(target_os = "macos")]
fn dirs_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push("Library/Application Support/Rovenue");
    Some(p)
}

#[cfg(all(target_os = "linux", not(any(target_os = "android", target_os = "ios"))))]
fn dirs_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| {
            let mut p = PathBuf::from(h);
            p.push(".local/share");
            p
        }))?;
    let mut p = base;
    p.push("rovenue");
    Some(p)
}

#[cfg(any(target_os = "windows", target_os = "android", target_os = "ios"))]
fn dirs_path() -> Option<PathBuf> {
    std::env::var_os("TMPDIR")
        .or_else(|| std::env::var_os("TEMP"))
        .map(|p| {
            let mut pb = PathBuf::from(p);
            pb.push("rovenue");
            pb
        })
}
```

- [ ] **Step 14.4: Update lib.rs re-exports**

Edit `packages/core-rs/src/lib.rs`. The file should currently declare all the new modules. Make sure these top-level re-exports exist (add ones that are missing, do not duplicate):

```rust
pub use api::RovenueCore;
pub use config::Config;
pub use entitlements::Entitlement;
pub use error::{RovenueError, RovenueResult};
pub use identity::User;
pub use observer::{ChangeEvent, Observer};
pub use version::SDK_VERSION;
```

- [ ] **Step 14.5: Update UDL to expose new types/methods**

Replace `packages/core-rs/src/librovenue.udl`:

```
namespace librovenue {
    string sdk_version();
};

[Error]
enum RovenueError {
    "NotConfigured",
    "InvalidApiKey",
    "ServerError",
    "NetworkUnavailable",
    "Timeout",
    "RateLimited",
    "Storage",
    "Internal",
};

dictionary Config {
    string api_key;
    string base_url;
    boolean debug;
};

dictionary User {
    string anon_id;
    string? known_user_id;
};

dictionary Entitlement {
    string id;
    boolean is_active;
    string? product_id;
    u64? expires_at_ms;
};

[Trait]
interface Observer {
    void on_change(ChangeEvent event);
};

enum ChangeEvent {
    "EntitlementsChanged",
    "IdentityChanged",
};

interface RovenueCore {
    [Throws=RovenueError]
    constructor(Config config);

    string get_version();

    User current_user();

    [Throws=RovenueError]
    void identify(string known_user_id);

    Entitlement? entitlement(string id);
    sequence<Entitlement> entitlements_all();

    [Throws=RovenueError]
    void refresh_entitlements();

    void register_observer(Observer obs);
    void set_foreground(boolean foreground);
    void shutdown();
};
```

UniFFI 0.25 supports `[Trait]` interfaces for callback-style observers (passing an `Arc<dyn Observer>` from the façade into Rust). If `[Trait]` syntax causes a UDL parse error, fall back to `callback interface Observer { ... };` — UniFFI 0.25 accepts that form for Swift+Kotlin.

- [ ] **Step 14.6: Verify**

Run: `cargo clean && cargo test -p librovenue`
Expected: all tests pass — including the new smoke tests.

Run: `cargo clippy -p librovenue --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 14.7: Commit**

```
git add packages/core-rs/src packages/core-rs/tests/integration_smoke.rs
git commit -m "feat(core-rs): RovenueCore FFI surface for M1 (identify, observer, entitlements, polling)"
```

---

## Task 15: Regenerate bindings + parity smoke

**Files:**
- (regenerates) `packages/sdk-swift/Sources/Rovenue/Generated/*`
- (regenerates) `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/*`

The host-triple `build-bindings.sh` from M0 is reused here. We just verify it still produces valid output now that the UDL has grown.

- [ ] **Step 15.1: Run the bindgen script**

```bash
source $HOME/.cargo/env
./packages/core-rs/scripts/build-bindings.sh
```

Expected: completes with `✓ bindings generated` and lists output files.

- [ ] **Step 15.2: Inspect Swift binding for new types**

```bash
grep -E 'class RovenueCore|struct (Config|User|Entitlement)|enum ChangeEvent|protocol Observer' packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift | head -20
```

Expected: each of `RovenueCore`, `Config`, `User`, `Entitlement`, `ChangeEvent`, `Observer` appears in the file.

- [ ] **Step 15.3: Inspect Kotlin binding**

```bash
grep -E '(class RovenueCore|data class (Config|User|Entitlement)|enum class ChangeEvent|interface Observer)' packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt | head -20
```

Expected: each declaration is present.

- [ ] **Step 15.4: Run parity script**

```bash
./scripts/sdk-parity.sh
```

Expected: exits 0. (Swift/Kotlin tests still verify `getVersion()` — they don't yet cover the new methods, that's a façade-plan job.)

- [ ] **Step 15.5: Commit**

(No source files change — but `.gitkeep` and any cargo lock updates may need staging. If `git status --short` is empty, skip the commit.)

```bash
git status --short
```

If empty, skip Step 15.6. Otherwise:

```
git add ...
git commit -m "chore(sdk): regenerate UniFFI bindings after M1 surface expansion"
```

---

## Task 16: CI workflow tweak — pull in new deps and run new tests

**Files:**
- Modify: `.github/workflows/sdk.yml`

- [ ] **Step 16.1: Inspect current sdk.yml**

Open `.github/workflows/sdk.yml` (created in M0). The `rust-core` job already runs `cargo test --workspace --all-targets`, which will pick up the new tests automatically. Verify nothing else needs changing.

- [ ] **Step 16.2: Add system deps for rusqlite-bundled on Linux**

`rusqlite = { features = ["bundled"] }` ships its own SQLite — but the build needs a C compiler. `ubuntu-latest` has gcc by default, so nothing should be needed. Add a sanity step early in the `rust-core` job for clarity:

In `.github/workflows/sdk.yml` find the `rust-core` job's `steps:` block, after `- uses: dtolnay/rust-toolchain@1.78.0` add a step (only if it isn't already there):

```yaml
      - name: System build deps (rusqlite-bundled)
        run: sudo apt-get update && sudo apt-get install -y build-essential
```

For the `bindgen-host` job, do the same. The `swift` job runs on macos-14 (Xcode toolchain ships clang). The `kotlin` job uses ubuntu — same build-essential step there too.

- [ ] **Step 16.3: Local sanity**

Run: `cargo test --workspace --all-targets`
Expected: full suite green.

- [ ] **Step 16.4: Commit**

```
git add .github/workflows/sdk.yml
git commit -m "ci(sdk): apt build-essential for rusqlite-bundled on ubuntu"
```

---

## Task 17: Update parity smoke script for new tests

**Files:**
- Modify: `scripts/sdk-parity.sh`

- [ ] **Step 17.1: Confirm RN count**

The RN test count remains 6 — `scripts/sdk-parity.sh` greps for `"6 passed"` from vitest. M1 doesn't add RN tests. No change needed.

- [ ] **Step 17.2: Add a Rust assertion to the parity script**

The script already proves things via per-platform test suites. To make M1 work visible, append a step that runs the new Rust tests by name and asserts they're present. Edit `scripts/sdk-parity.sh`, after the existing `echo "→ Rust librovenue version: $RUST_VER"` line, add:

```bash
echo "→ Rust core tests (M1 surface)"
cargo test -p librovenue --quiet \
    --test integration_smoke \
    --test entitlement_read_test \
    --test identity_test \
    --test polling_test \
    >/tmp/rovenue-rust-parity.log 2>&1
tail -3 /tmp/rovenue-rust-parity.log
echo "  ✓ Rust M1 tests passed"
```

- [ ] **Step 17.3: Run**

```bash
./scripts/sdk-parity.sh
```

Expected: passes. The new section prints summary lines for the M1 suite.

- [ ] **Step 17.4: Commit**

```
git add scripts/sdk-parity.sh
git commit -m "test(sdk): parity script exercises M1 rust suites"
```

---

## Task 18: Plan finalisation

- [ ] **Step 18.1: Verify nothing's left untracked that should be**

Run: `git status --short`
Expected: clean working tree. If `Cargo.lock` updated, stage it. If untracked test artifacts remain in `packages/sdk-swift/Sources/Rovenue/Generated/` or `packages/sdk-kotlin/.../generated/` — they should be gitignored.

- [ ] **Step 18.2: Run the full suite once more**

```bash
source $HOME/.cargo/env
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
./scripts/sdk-parity.sh
```

Expected: every command exits 0.

- [ ] **Step 18.3: Summarise commits since base**

```bash
git log --oneline main..HEAD
```

Expected: 17–18 commits with semantic prefixes (`feat(core-rs):`, `build(core-rs):`, `test(sdk):`, `chore(sdk):`, `ci(sdk):`).

- [ ] **Step 18.4: Hand off**

After verification, ask the controller whether to:
1. Merge to main locally (no push)
2. Push + open PR
3. Leave the branch in the worktree for further iteration

---

## Self-Review Notes

**Spec coverage:**
- §4.1 file layout — every M1-relevant module is created (`transport/`, `cache/`, `identity.rs`, `polling/`, `entitlements/`, `observer.rs`, `time.rs`). `audit/` and `crypto/` are M5+/M1.5+.
- §3.1 architecture — sync FFI surface (✓), façade-side bridging deferred (per scope decision).
- §5.1 cold start flow — `RovenueCore::new` opens SQLite, loads identity (gen if missing), constructs reader+scheduler, scheduler off until `set_foreground(true)`. Matches spec.
- §5.3 entitlement read — cache-first via `entitlement(id)`, polling via `set_foreground(true)`, refresh emits `EntitlementsChanged`. Matches.
- §5.4 identify — client-local (per memory note `rovenue_sdk_identify_is_client_local.md` — supersedes spec §5.4 original wording). No HTTP call from SDK.
- §5.7 polling lifecycle — `set_foreground(true)` enables ticks at 30s; `set_foreground(false)` pauses. Matches.
- §6.1 error enum — adds 4 of the spec's M1-relevant variants; remaining (`UserNotFound`, `EntitlementInactive`, `InsufficientCredits`, `DuplicatePurchase`, `ReceiptInvalid`, `Crypto`) land in M2/M3/M5.
- §6.3 retry policy — exp backoff with jitter (✓), 429 surfaced as `RateLimited` (per M1 simplification, full Retry-After honoring deferred to M2), fast-fail 4xx (✓), 409 success (✓).
- §6.7 observability — logger trait not added in M1; spec lists it as "post-V1" for built-in exporters, so defer.

**Placeholder scan:** no TBDs in any task; every code block is complete.

**Type consistency:** `Config { api_key, base_url, debug }`, `User { anon_id, known_user_id }`, `Entitlement { id, is_active, product_id, expires_at_ms }`, `ChangeEvent::{EntitlementsChanged, IdentityChanged}`, `Observer::on_change(ChangeEvent)` — same names across Rust + UDL + tests.

**Cross-task dependencies sanity:**
- Task 8 IdentityManager depends on Task 5 (CacheStore) + Task 4 (Clock) + Task 3 (ObserverBus). ✓ ordered correctly.
- Task 11 reader depends on Task 7 (entitlements + etag repos) + Task 8 (identity). ✓
- Task 12 reader.refresh depends on Task 10 (HttpClient). ✓
- Task 13 scheduler is independent (just `std::thread` + closures).
- Task 14 wires everything into `RovenueCore` — depends on every previous task.
- Task 15 regenerates bindings — depends on Task 14's UDL update.

**Known risk to surface to implementer:**
- UniFFI 0.25 `[Trait]` interfaces vs `callback interface` — Task 14.5 calls out the fallback. If callback-style is needed instead, the Rust side stays the same but UDL syntax changes.
- The polling tests in Task 13 use `serial_test` to avoid timing interference. Make sure that crate is in dev-dependencies (it's added in Task 1).
- Cross-thread access to `IdentityManager` — `Mutex<User>` guards the cached state. Document with a one-line comment if the implementer is uncertain.

---

*End of plan.*
