# Identity Client Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SDK client match the shipped backend identity model: rename the native identity contract `anonId/knownUserId` → `rovenueId/appUserId`, turn `identify()` into an optimistic-local + background server call to `POST /v1/identify`, and add `logOut()`/`reset()` that mints a fresh `rovenueId` — across the Rust core, UniFFI bindings, Swift/Kotlin façades, and the RN/TS + Expo-native layers.

**Architecture:** Identity lives in the Rust `librovenue` core (`IdentityManager` + a SQLite `identity` row). The native façades (Swift/Kotlin) and the RN module are thin wrappers over UniFFI-generated bindings. So: change the core + UDL first, regenerate bindings, then update each façade/native wrapper to mirror. `identify()` stays synchronous-feeling (optimistic local write + emit) and performs a best-effort `POST /v1/identify`; a `synced` flag drives a simple reconcile retry on init/scheduler tick. No legacy migration (no production data) — the local `identity` table is recreated via a cache-schema bump.

**Tech Stack:** Rust (UniFFI UDL, `rusqlite`, `reqwest`, `mockito` tests), Swift 5.9 / XCTest, Kotlin / Android library / JUnit5, React Native / Expo modules / TypeScript / Vitest. Conventional commits ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Source spec:** `docs/superpowers/specs/2026-06-15-identity-model-redesign-design.md` (D1/D2 rename, D4 logOut, D5 optimistic+sync; dual-read/legacy dropped per "no production data" amendment).

**Backend contract already on main:** `POST /v1/identify` (public key) — body `{ rovenueId, appUserId }`, returns `{ data: { subscriberId, appUserId, transferred } }`, 400 on unknown device / validation. Subscribers keyed by `rovenueId`; the device key travels in the `X-Rovenue-App-User-Id` header for all other SDK calls.

**Confirmed current state (verified on main):**
- `packages/core-rs/src/identity.rs` — `User { anon_id, known_user_id }`, `IdentityManager` (gen anon on first load via `anon_{cuid2}`, `current_user`, `current_user_scope` = known ?? anon, `identify(known_user_id)` local-only persist+emit). No `log_out`.
- `packages/core-rs/src/cache/identity.rs` — `IdentityRow { anon_id, known_user_id, created_at_ms }`, `IdentityRepo` (SELECT/UPSERT on `identity` table cols `anon_id, known_user_id, created_at_ms`).
- `packages/core-rs/src/librovenue.udl` — `dictionary User { string anon_id; string? known_user_id; }`, `User current_user();`, `void identify(string known_user_id);`.
- HTTP pattern: `HttpPostRequest::new(path).user_scope(scope).idempotency_key(key)` → `http.post_json::<Body, ApiEnvelope<Resp>>(req, &body)`; `X-Rovenue-App-User-Id` header set from `user_scope`. Example: `packages/core-rs/src/receipts/client.rs::post_apple`.
- `RovenueCore` (`api.rs`) holds `identity: Arc<IdentityManager>`, `receipts`, `offerings`, `account_tokens`, `sessions`, `session_dispatcher`, etc.; `current_user()`/`identify()` delegate to `identity`.
- RN: `sdk-rn/src/api/identity.ts` (currentUser, identify), `src/types.ts` `User { anonId, knownUserId|null }`, `src/specs/RovenueModule.types.ts` `UserDTO { anonId, knownUserId|null }` + `RovenueModuleSpec`, `src/index.ts` exports, `ios/RovenueModule.swift` + `android/.../RovenueModule.kt` AsyncFunction wiring.
- Swift façade `sdk-swift/Sources/Rovenue/Rovenue.swift` (`currentUser`, `identify`; no `logOut`). Kotlin façade `sdk-kotlin/.../Rovenue.kt` (same; Android library).
- Bindings regen: `./packages/core-rs/scripts/build-bindings.sh`.

---

## File Structure

- `packages/core-rs/src/identity.rs` — `User`/`IdentityManager`: field rename, optimistic `set_app_user_id`, `log_out`, `mark_synced`, `pending_app_user_id`.
- `packages/core-rs/src/cache/identity.rs` — `IdentityRow` rename + `synced` column; repo SQL.
- `packages/core-rs/src/cache/mod.rs` (or wherever the `identity` table DDL + schema version live) — column rename + `synced` + schema-version bump.
- `packages/core-rs/src/identify/{mod.rs,client.rs}` — new `IdentifyClient` (POST /v1/identify).
- `packages/core-rs/src/api.rs` — `RovenueCore.identify` (optimistic + server + reconcile), `log_out`, wire `IdentifyClient`, reconcile on init/scheduler.
- `packages/core-rs/src/librovenue.udl` — `User` rename, `identify(string app_user_id)`, add `void log_out();`.
- Generated bindings (committed): `sdk-swift/Sources/Rovenue/Generated/*`, `sdk-kotlin/.../generated/librovenue.kt`.
- `sdk-swift/Sources/Rovenue/Rovenue.swift` — `logOut()`; currentUser via renamed generated fields.
- `sdk-kotlin/.../Rovenue.kt` — `logOut()`.
- `sdk-rn/src/{types.ts,api/identity.ts,index.ts}`, `src/specs/RovenueModule.types.ts`, `ios/RovenueModule.swift`, `android/.../RovenueModule.kt` — rename + `logOut`.
- `apps/docs/content/docs/reference/{methods.mdx,types.mdx}` — `logOut`, `currentUser` shape, identify semantics.

---

## Phase 1 — Rust core: rename `anonId/knownUserId` → `rovenueId/appUserId`

**Why:** Establish the new field names everywhere in the core before adding behavior. Pure rename — no behavior change. No production data, so the local `identity` table is recreated via a schema-version bump rather than column-migrated.

### Task 1.1: Rename the SQLite identity row + table

**Files:**
- Modify: `packages/core-rs/src/cache/identity.rs`
- Modify: the `identity` table DDL + cache schema version (grep `CREATE TABLE.*identity` and the schema/`user_version` constant under `packages/core-rs/src/cache/`)
- Test: `packages/core-rs/tests/cache_identity_test.rs`

- [ ] **Step 1: Update the failing test first**

In `packages/core-rs/tests/cache_identity_test.rs`, rename every `anon_id`→`rovenue_id` and `known_user_id`→`app_user_id` in the `IdentityRow` literals and assertions (e.g. `persist_and_reload`, `save_is_upsert_keeps_one_row`). Run `cargo test -p librovenue --test cache_identity_test` → expect FAIL (fields don't exist yet).

- [ ] **Step 2: Rename `IdentityRow` + repo SQL**

In `packages/core-rs/src/cache/identity.rs`:
```rust
#[derive(Debug, Clone)]
pub struct IdentityRow {
    pub rovenue_id: String,
    pub app_user_id: Option<String>,
    pub synced: bool,
    pub created_at_ms: u64,
}
```
Update `load()` SELECT to `SELECT rovenue_id, app_user_id, synced, created_at_ms FROM identity WHERE id = 1` and map `synced: r.get::<_, i64>(2)? != 0`, `created_at_ms: r.get::<_, i64>(3)? as u64`. Update `save()` INSERT/ON CONFLICT to the four columns (`rovenue_id, app_user_id, synced, created_at_ms`), binding `row.synced as i64`.

- [ ] **Step 3: Update the table DDL + bump schema version**

Find the `identity` table `CREATE TABLE` (cache schema setup) and change it to:
```sql
CREATE TABLE IF NOT EXISTS identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rovenue_id TEXT NOT NULL,
  app_user_id TEXT,
  synced INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);
```
Bump the cache schema/`user_version` (or migration list) by one so existing local dev DBs are recreated cleanly (no production data → no data migration needed). If the cache uses a numbered-migrations list, add a migration that `DROP TABLE IF EXISTS identity` then recreates it with the new shape.

- [ ] **Step 4: Run** `cargo test -p librovenue --test cache_identity_test` → PASS.

- [ ] **Step 5: Commit** `refactor(core): rename identity row to rovenueId/appUserId + add synced column`.

### Task 1.2: Rename `User`/`IdentityManager` fields + UDL

**Files:**
- Modify: `packages/core-rs/src/identity.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Test: `packages/core-rs/tests/identity_test.rs`

- [ ] **Step 1: Update the failing tests first**

In `packages/core-rs/tests/identity_test.rs`, rename fields in assertions: `current_user().anon_id`→`.rovenue_id`, `known_user_id`→`app_user_id`; keep the existing test intents (`first_load_generates_anon_id` → rename to `first_load_generates_rovenue_id` asserting `rovenue_id` starts with `rov_`; `current_user_returns_known_id_for_scope_when_present` → assert `current_user_scope()` returns the app_user_id). Run `cargo test -p librovenue --test identity_test` → FAIL.

- [ ] **Step 2: Rename in `identity.rs`**

```rust
#[derive(Debug, Clone)]
pub struct User {
    pub rovenue_id: String,
    pub app_user_id: Option<String>,
}
```
In `IdentityManager::new`: generate `rovenue_id: format!("rov_{}", cuid2::create_id())`, `app_user_id: None`, `synced: true`. Map `User { rovenue_id: row.rovenue_id, app_user_id: row.app_user_id }`. Update `current_user_scope` to `u.app_user_id.clone().unwrap_or_else(|| u.rovenue_id.clone())`. In `identify`, rename the local field writes to `app_user_id` (behavior otherwise unchanged for now — Phase 3 reworks it). When constructing `IdentityRow` for persistence, include `synced: true` for now (Phase 3 changes this).

- [ ] **Step 3: Rename in the UDL**

In `packages/core-rs/src/librovenue.udl`:
```
dictionary User {
    string rovenue_id;
    string? app_user_id;
};
```
Change `void identify(string known_user_id);` → `void identify(string app_user_id);` (line ~92).

- [ ] **Step 4: Fix any other core references**

Run `cargo build -p librovenue` and fix every reference to `.anon_id`/`.known_user_id`/`anon_id`/`known_user_id` in `src/` (e.g. `api.rs` `identify(known_user_id)` param, any event payloads). Run `cargo test -p librovenue --test identity_test` → PASS.

- [ ] **Step 5: Commit** `refactor(core)!: rename User/UDL identity fields to rovenueId/appUserId`.

---

## Phase 2 — Rust core: `logOut()` / `reset()`

**Why:** Shared-device sign-out must mint a fresh `rovenueId` so the next user can't inherit entitlements.

**Files:**
- Modify: `packages/core-rs/src/identity.rs`, `packages/core-rs/src/api.rs`, `packages/core-rs/src/librovenue.udl`
- Test: `packages/core-rs/tests/identity_test.rs`, `packages/core-rs/tests/api_*` (logout integration if one exists)

### Task 2.1: `IdentityManager::log_out`

- [ ] **Step 1: Failing test**

Add to `identity_test.rs`:
```rust
#[test]
fn log_out_mints_new_rovenue_id_and_clears_app_user_id_and_emits() {
    // build manager with a Capture observer (mirror existing tests' setup)
    let before = mgr.current_user().rovenue_id;
    mgr.identify("user_1".into()).unwrap();
    mgr.log_out().unwrap();
    let after = mgr.current_user();
    assert_ne!(after.rovenue_id, before);
    assert!(after.rovenue_id.starts_with("rov_"));
    assert_eq!(after.app_user_id, None);
    // an IdentityChanged event was emitted for the log_out
    assert!(capture.events().iter().any(|e| matches!(e, ChangeEvent::IdentityChanged)));
}
```
Run `cargo test -p librovenue --test identity_test log_out` → FAIL.

- [ ] **Step 2: Implement `log_out` in `identity.rs`**

```rust
pub fn log_out(&self) -> RovenueResult<()> {
    let new_row = IdentityRow {
        rovenue_id: format!("rov_{}", cuid2::create_id()),
        app_user_id: None,
        synced: true,
        created_at_ms: self.clock.now_unix_ms(),
    };
    IdentityRepo::new(&self.store).save(&new_row)?;
    {
        let mut u = self.cached.lock().expect("identity mutex poisoned");
        u.rovenue_id = new_row.rovenue_id.clone();
        u.app_user_id = None;
    }
    self.bus.emit(ChangeEvent::IdentityChanged);
    Ok(())
}
```

- [ ] **Step 3: Run** `cargo test -p librovenue --test identity_test` → PASS. **Commit** `feat(core): IdentityManager.log_out mints fresh rovenueId`.

### Task 2.2: `RovenueCore::log_out` clears scope-bound caches + UDL

- [ ] **Step 1: Identify the caches to clear**

Read `api.rs` + the modules behind `account_tokens` (`AccountTokenStore`), `sessions` (`SessionBuffer`), and the entitlement/credit readers/caches. Each holds state keyed by the previous identity scope. Find (or add) a `clear()` on each that the test can observe. Prefer existing clear/reset methods; add a minimal `clear()` only where none exists.

- [ ] **Step 2: Failing test**

Add an API-level test (mirror `new_for_test` harness) asserting: after seeding an app account token + a buffered session + identifying, `core.log_out()` results in a fresh `current_user().rovenue_id`, `app_user_id == None`, and the account-token store / session buffer report empty. Run → FAIL.

- [ ] **Step 3: Implement `RovenueCore::log_out`**

```rust
pub fn log_out(&self) -> RovenueResult<()> {
    self.identity.log_out()?;
    self.account_tokens.clear();
    self.sessions.clear();
    // entitlements/credits readers are scope-driven; drop any cached snapshot
    self.entitlements.invalidate();
    self.credits.invalidate();
    Ok(())
}
```
Adapt method names to whatever the modules actually expose (Step 1). If a reader has no cache to clear, omit that line and note it.

- [ ] **Step 4: UDL** — add to `interface RovenueCore` (next to `identify`): `void log_out();`. (No `[Throws]` unless `log_out` returns an error type; it returns `RovenueResult<()>` → add `[Throws=RovenueError]`.)

- [ ] **Step 5: Run** the API test + `cargo test -p librovenue` → PASS. **Commit** `feat(core): RovenueCore.log_out resets identity + scope-bound caches`.

---

## Phase 3 — Rust core: `identify()` optimistic-local + `POST /v1/identify` + reconcile

**Why:** `identify()` must bind the label server-side (so purchases follow the user) while staying offline-friendly.

**Files:**
- Create: `packages/core-rs/src/identify/mod.rs`, `packages/core-rs/src/identify/client.rs`
- Modify: `packages/core-rs/src/identity.rs` (`set_app_user_id` optimistic + `synced`/`pending` helpers), `packages/core-rs/src/api.rs`, `packages/core-rs/src/lib.rs`
- Test: `packages/core-rs/tests/identify_test.rs` (new), fixture `packages/core-rs/tests/fixtures/identify_response.json`

### Task 3.1: `IdentifyClient`

- [ ] **Step 1: Failing test + fixture**

`packages/core-rs/tests/fixtures/identify_response.json`:
```json
{ "data": { "subscriberId": "sub_1", "appUserId": "user_1", "transferred": false } }
```
`packages/core-rs/tests/identify_test.rs`:
```rust
use std::sync::Arc;
use std::time::Duration;
use rovenue::identify::IdentifyClient;
use rovenue::transport::http_client::HttpClient;

fn http(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn identify_client_posts_rovenue_and_app_user_id() {
    let mut server = mockito::Server::new();
    let m = server.mock("POST", "/v1/identify")
        .match_header("authorization", "Bearer pk_test")
        .match_body(mockito::Matcher::PartialJsonString(
            r#"{"rovenueId":"rov_x","appUserId":"user_1"}"#.into()))
        .with_status(200)
        .with_body(include_str!("fixtures/identify_response.json"))
        .create();
    let client = IdentifyClient::new(Arc::new(http(&server.url())));
    let res = client.identify("rov_x", "user_1").unwrap();
    m.assert();
    assert_eq!(res.transferred, false);
}
```
Run `cargo test -p librovenue --test identify_test` → FAIL (module missing).

- [ ] **Step 2: Implement the client**

`packages/core-rs/src/identify/mod.rs`:
```rust
pub mod client;
pub use client::{IdentifyClient, IdentifyResult};
```
`packages/core-rs/src/identify/client.rs` (mirror `receipts/client.rs`):
```rust
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

#[derive(Debug, Clone, Serialize)]
struct IdentifyBody<'a> {
    #[serde(rename = "rovenueId")]
    rovenue_id: &'a str,
    #[serde(rename = "appUserId")]
    app_user_id: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdentifyResult {
    #[serde(rename = "subscriberId")]
    pub subscriber_id: String,
    #[serde(rename = "appUserId")]
    pub app_user_id: String,
    pub transferred: bool,
}

pub struct IdentifyClient { http: Arc<HttpClient> }

impl IdentifyClient {
    pub fn new(http: Arc<HttpClient>) -> Self { Self { http } }

    pub fn identify(&self, rovenue_id: &str, app_user_id: &str) -> RovenueResult<IdentifyResult> {
        let body = IdentifyBody { rovenue_id, app_user_id };
        let resp = self.http.post_json::<IdentifyBody, ApiEnvelope<IdentifyResult>>(
            HttpPostRequest::new("/v1/identify").user_scope(rovenue_id),
            &body,
        )?;
        resp.body.and_then(|e| e.data).ok_or(RovenueError::Internal)
    }
}
```
(Match `ApiEnvelope`'s actual shape — read `transport/api.rs`; the `.body`/`.data` access mirrors `offerings/client.rs`.) Add `pub mod identify;` + `pub use identify::{IdentifyClient, IdentifyResult};` to `lib.rs`.

- [ ] **Step 3: Run** → PASS. **Commit** `feat(core): IdentifyClient POST /v1/identify`.

### Task 3.2: Optimistic local set + `synced` plumbing in `IdentityManager`

- [ ] **Step 1: Failing test** (in `identity_test.rs`)

Assert: a new `set_app_user_id("user_1")` sets `current_user().app_user_id == Some("user_1")`, persists with `synced=false`, emits IdentityChanged; `mark_synced()` flips the persisted row to `synced=true`; `pending_app_user_id()` returns `Some("user_1")` while unsynced and `None` after `mark_synced`. Run → FAIL.

- [ ] **Step 2: Implement**

Replace the body of `identify` (now local-only `set_app_user_id`) so it writes `synced: false` and keep helpers:
```rust
/// Optimistic local label set. Persists synced=false; caller syncs to server.
pub fn set_app_user_id(&self, app_user_id: String) -> RovenueResult<bool> {
    if app_user_id.trim().is_empty() { return Err(RovenueError::InvalidApiKey); }
    let (changed, rovenue_id) = {
        let mut u = self.cached.lock().expect("identity mutex poisoned");
        let changed = u.app_user_id.as_deref() != Some(app_user_id.as_str());
        if changed { u.app_user_id = Some(app_user_id.clone()); }
        (changed, u.rovenue_id.clone())
    };
    if changed {
        IdentityRepo::new(&self.store).save(&IdentityRow {
            rovenue_id, app_user_id: Some(app_user_id), synced: false,
            created_at_ms: self.clock.now_unix_ms(),
        })?;
        self.bus.emit(ChangeEvent::IdentityChanged);
    }
    Ok(changed)
}

pub fn mark_synced(&self) -> RovenueResult<()> {
    let row = { let u = self.cached.lock().expect("poisoned");
        IdentityRow { rovenue_id: u.rovenue_id.clone(), app_user_id: u.app_user_id.clone(),
                      synced: true, created_at_ms: self.clock.now_unix_ms() } };
    IdentityRepo::new(&self.store).save(&row)
}

/// The app_user_id awaiting server confirmation, if any.
pub fn pending_app_user_id(&self) -> Option<String> {
    let row = IdentityRepo::new(&self.store).load().ok().flatten();
    row.and_then(|r| if r.synced { None } else { r.app_user_id })
}

pub fn rovenue_id(&self) -> String { self.cached.lock().expect("poisoned").rovenue_id.clone() }
```
(`log_out` already writes `synced:true`.) Run → PASS. **Commit** `feat(core): optimistic set_app_user_id + synced/pending helpers`.

### Task 3.3: Wire `RovenueCore::identify` (optimistic + server + reconcile)

- [ ] **Step 1: Failing test** (`identify_test.rs`, core-level using `new_for_test` with a mockito base_url)

Cases:
1. `core.identify("user_1")` with the server mock returning 200 → `current_user().app_user_id == Some("user_1")` and the identity row is `synced` (assert via a follow-up that `reconcile` makes no second call — or expose a test seam).
2. Server returns 500/unreachable → `identify` still returns Ok (optimistic), `current_user().app_user_id == Some("user_1")`, and a subsequent `core.reconcile_identity()` (with the mock now 200) performs the POST and marks synced.
Run → FAIL.

- [ ] **Step 2: Implement in `api.rs`**

Add `identify: Arc<IdentifyClient>` to `RovenueCore`; construct it in `from_store` as `Arc::new(IdentifyClient::new(Arc::clone(&http)))`. Replace `identify`:
```rust
pub fn identify(&self, app_user_id: String) -> RovenueResult<()> {
    let changed = self.identity.set_app_user_id(app_user_id.clone())?; // optimistic + emit
    if changed {
        let rovenue_id = self.identity.rovenue_id();
        // best-effort sync; offline failures are retried by reconcile_identity
        match self.identify.identify(&rovenue_id, &app_user_id) {
            Ok(_) => { let _ = self.identity.mark_synced(); }
            Err(e) => { /* log via bus/log; keep synced=false */ let _ = e; }
        }
    }
    Ok(())
}

/// Re-sends a pending (offline) identify. Called on init + each scheduler tick.
pub fn reconcile_identity(&self) {
    if let Some(app_user_id) = self.identity.pending_app_user_id() {
        let rovenue_id = self.identity.rovenue_id();
        if self.identify.identify(&rovenue_id, &app_user_id).is_ok() {
            let _ = self.identity.mark_synced();
        }
    }
}
```
Call `reconcile_identity()` once near the end of `from_store` (spawn on the existing dispatcher/scheduler so it's non-blocking — mirror how the polling scheduler kicks off), and add a `reconcile_identity()` call to the polling-scheduler tick body. Keep `identify` on the UDL as `[Throws=RovenueError] void identify(string app_user_id);` (already renamed in Phase 1).

- [ ] **Step 3: Run** `cargo test -p librovenue` → PASS. **Commit** `feat(core): identify() optimistic-local + POST /v1/identify with offline reconcile`.

---

## Phase 4 — Regenerate UniFFI bindings

**Files:** generated Swift + Kotlin (committed build output).

- [ ] **Step 1: Run** `./packages/core-rs/scripts/build-bindings.sh` → expect success.
- [ ] **Step 2: Verify** `grep -nE "rovenueId|rovenue_id|appUserId|app_user_id|logOut|log_out|func identify|fun identify" packages/sdk-swift/Sources/Rovenue/Generated/*.swift packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt` → shows renamed `User` fields, `logOut`, and `identify(appUserId)` in both.
- [ ] **Step 3: Sanity** `cargo build -p librovenue --release` → success.
- [ ] **Step 4: Commit** `chore(sdk): regenerate Swift/Kotlin bindings for identity rename + logOut`.

---

## Phase 5 — Swift façade

**Files:** `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, `Types.swift`; tests under `packages/sdk-swift/Tests/RovenueTests/`.

- [ ] **Step 1: Failing test**

Add `IdentityTests` asserting: `currentUser()` exposes `.rovenueId` / `.appUserId` (the generated `User` fields), and `Rovenue.shared.logOut()` exists and runs.

**REQUIRED test isolation (added by commit `0dfcf69`):** identity writes to the Rust core's on-disk SQLite cache, which persists across tests. Use the existing `Support/TestHome.swift` helper — call `isolateRovenueHome(self)` at the **very top of `setUp()`**, before `Rovenue.resetForTesting()` / `Rovenue.configure(...)`. Mirror the other suites (e.g. `RovenueTests.swift`) that already do this. Without it, `identify`/`logOut` state leaks between tests and causes flakes. Run `swift test --package-path packages/sdk-swift --filter IdentityTests` → FAIL.

- [ ] **Step 2: Implement**

`identify(_:)` already forwards to `core.identify`; signature unchanged (still takes the customer id string). Add:
```swift
@available(iOS 15.0, macOS 12.0, *)
public func logOut() async throws {
    Self.emit(LogEntry(level: "info", message: "logOut"))
    try await dispatcher.run { [core] in
        do { try core.logOut() } catch let e as RovenueError { throw mapError(e) }
    }
}
```
Fix any `Types.swift`/call-site references to the old `User.anonId`/`knownUserId` → `rovenueId`/`appUserId` (the generated type changed). Run `swift test --package-path packages/sdk-swift` → PASS.

- [ ] **Step 3: Commit** `feat(swift): logOut() + currentUser rovenueId/appUserId`.

---

## Phase 6 — Kotlin façade

**Files:** `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, `Types.kt`; tests under `src/test/kotlin/dev/rovenue/sdk/`.

- [ ] **Step 1: Failing test**

Add `IdentityTest.kt` asserting `currentUser()` exposes `rovenueId`/`appUserId` and `Rovenue.logOut()` exists (mirror `RovenueTest.kt` harness + `resetForTesting()`). Run `./gradlew :sdk-kotlin:testDebugUnitTest --tests "*IdentityTest*"` → FAIL.

- [ ] **Step 2: Implement**

```kotlin
@Throws(RovenueException::class)
suspend fun logOut() {
    emit(LogEntry(level = "info", message = "logOut"))
    try { dispatcher.run { core.logOut() } }
    catch (e: Throwable) {
        emit(LogEntry(level = "error", message = "logOut failed: ${e.message ?: e.javaClass.simpleName}"))
        throw e
    }
}
```
Fix any references to the old generated `User.anonId`/`knownUserId`. Run `./gradlew :sdk-kotlin:testDebugUnitTest` → PASS.

- [ ] **Step 3: Commit** `feat(kotlin): logOut() + currentUser rovenueId/appUserId`.

---

## Phase 7 — RN/TS + Expo native modules

**Files:** `sdk-rn/src/types.ts`, `src/specs/RovenueModule.types.ts`, `src/api/identity.ts`, `src/index.ts`, `ios/RovenueModule.swift`, `android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`; tests `sdk-rn/src/__tests__/`.

### Task 7.1: TS types + identity API + logOut

- [ ] **Step 1: Failing test**

In `sdk-rn/src/__tests__/api.test.ts` (mirror the existing `_mockNative` harness): update `currentUser` expectations to `{ rovenueId, appUserId }`, and add a test that `Rovenue.logOut()` calls the native `logOut`. Update `_mockNative.ts` to expose `logOut` + the renamed `currentUser` DTO. Run `pnpm --filter @rovenue/sdk-rn test api` → FAIL.

- [ ] **Step 2: Implement**

`src/types.ts`:
```ts
export type User = { rovenueId: string; appUserId: string | null };
```
`src/specs/RovenueModule.types.ts`:
```ts
export type UserDTO = { rovenueId: string; appUserId: string | null };
export interface RovenueModuleSpec {
  // ...
  currentUser(): Promise<UserDTO>;
  identify(appUserId: string): Promise<void>;
  logOut(): Promise<void>;
  // ...
}
```
`src/api/identity.ts`:
```ts
export async function currentUser(): Promise<User> {
  return call(() => getNative().currentUser());
}
export async function identify(appUserId: string): Promise<void> {
  return call(() => getNative().identify(appUserId));
}
export async function logOut(): Promise<void> {
  return call(() => getNative().logOut());
}
```
`src/index.ts`: add `logOut` to the imports from `./api/identity` and to the exported `Rovenue` object. Run `pnpm --filter @rovenue/sdk-rn test api` → PASS.

- [ ] **Step 3: Commit** `feat(sdk-rn): rovenueId/appUserId + logOut on identity API`.

### Task 7.2: Expo native modules (iOS + Android)

- [ ] **Step 1: Update iOS** `sdk-rn/ios/RovenueModule.swift`:
```swift
AsyncFunction("currentUser") { () -> [String: Any?] in
    let u = await Rovenue.shared.currentUser()
    return ["rovenueId": u.rovenueId, "appUserId": u.appUserId as Any?]
}
AsyncFunction("identify") { (appUserId: String) in
    try await Rovenue.shared.identify(appUserId)
}
AsyncFunction("logOut") {
    try await Rovenue.shared.logOut()
}
```

- [ ] **Step 2: Update Android** `sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`:
```kotlin
AsyncFunction("currentUser") Coroutine { ->
    val u = Rovenue.shared.currentUser()
    mapOf("rovenueId" to u.rovenueId, "appUserId" to u.appUserId)
}
AsyncFunction("identify") Coroutine { appUserId: String -> Rovenue.shared.identify(appUserId) }
AsyncFunction("logOut") Coroutine { -> Rovenue.shared.logOut() }
```

- [ ] **Step 3: Verify** `grep -rn "anonId\|knownUserId" packages/sdk-rn/ios packages/sdk-rn/android packages/sdk-rn/src` → returns nothing. Run `pnpm --filter @rovenue/sdk-rn test && pnpm --filter @rovenue/sdk-rn build` → PASS.

- [ ] **Step 4: Commit** `feat(sdk-rn): wire logOut + rovenueId/appUserId through Expo iOS/Android modules`.

---

## Phase 8 — Docs (SDK reference)

**Files:** `apps/docs/content/docs/reference/methods.mdx`, `reference/types.mdx` (and `platforms/*` if they show `currentUser`/`identify`).

- [ ] **Step 1:** Document `logOut()` (all three platforms), update `currentUser()` return shape to `{ rovenueId, appUserId }`, and `identify(appUserId)` now performs a server-side bind + auto-transfer (cross-link the rewritten `guides/identifying-users.mdx`). Remove any `anonId`/`knownUserId` references.
- [ ] **Step 2:** `pnpm --filter @rovenue/docs build` → PASS (internal-link validation).
- [ ] **Step 3: Commit** `docs: SDK reference for logOut + rovenueId/appUserId + server identify`.

---

## Final verification

- [ ] `cargo test -p librovenue` — green.
- [ ] Bindings regenerated & committed (Phase 4).
- [ ] `swift test --package-path packages/sdk-swift` — green; `logOut` present.
- [ ] `./gradlew :sdk-kotlin:testDebugUnitTest` — green.
- [ ] `pnpm --filter @rovenue/sdk-rn test && pnpm --filter @rovenue/sdk-rn build` — green; no `anonId`/`knownUserId` anywhere in `packages/sdk-rn`.
- [ ] `pnpm --filter @rovenue/docs build` — green.
- [ ] Repo-wide `grep -rn "anon_id\|known_user_id\|anonId\|knownUserId" packages apps | grep -v Generated` — only intentional leftovers (none expected).

## Notes / deferred (YAGNI)

- **No legacy migration** (no production data): the local `identity` table is recreated via the cache schema bump; no anonId→rovenueId reconciliation of existing installs.
- **Offline reconcile** is a single pending-`appUserId` retry on init + scheduler tick — not a general offline mutation queue.
- The backend `POST /v1/identify` already enforces the auto-transfer + advisory locks; the client does not re-implement merge logic.
- `currentUser()` remains an instant local cache read (no network).
