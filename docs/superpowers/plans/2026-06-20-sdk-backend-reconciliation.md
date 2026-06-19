# SDK ↔ Backend Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the Rovenue SDK with the current backend `/v1` contract: migrate the dead single-currency credit feature to the multi-currency virtual-currencies model, and add automatic (deduped) experiment-exposure logging.

**Architecture:** Changes flow bottom-up through four layers — Rust core (`packages/core-rs`) → uniffi bindings → native façades (`sdk-swift`, `sdk-kotlin`) + RN bridges (`sdk-rn/ios`, `sdk-rn/android`) → RN/JS (`sdk-rn/src`) → docs. The core owns the new VC cache + reader and the exposure tracker; exposure is fully internal (no UDL change). Credits become a breaking API rename to virtual currencies; client-side spend is removed (no public endpoint exists).

**Tech Stack:** Rust + uniffi, Swift (SwiftPM), Kotlin (Gradle), TypeScript (Expo module + vitest), rusqlite cache.

## Global Constraints

- Stay on `main`. Do NOT create or switch branches/worktrees (user manages branching).
- Generated uniffi bindings are **gitignored build artifacts** — never commit `sdk-swift/Sources/Rovenue/Generated/` or `sdk-kotlin/.../generated/`. Regenerate with `npm run sdk:bindings` from repo root.
- Backend contracts (verified, do not re-derive):
  - `GET /v1/virtual-currencies/me` → `{ "data": { "balances": { "<code>": <int> } } }` (public key, subscriber from context header).
  - `POST /v1/experiments/{id}/expose` → body `{ "variantId": string, "subscriberId": string }` (public key; parent `/v1` middleware handles auth + rate limit).
  - `POST /v1/receipts/{apple,google}` → response `data` now carries `virtualCurrencyBalances: { "<code>": <int> }` (and `access`).
  - The removed endpoints `GET /v1/me/credits` and `POST /v1/me/credits/spend` no longer exist.
- Test commands: core `cargo test` (in `packages/core-rs`); swift `swift test` (in `packages/sdk-swift`); kotlin `./gradlew testDebugUnitTest` (in `packages/sdk-kotlin`); RN `pnpm --filter @rovenue/react-native-sdk test` (vitest).
- Crate/workspace version is `0.7.0`; RN package is `0.3.0`. Bump both in the final task (breaking change).
- **Deviation note (approved during planning):** the `RovenueError::InsufficientCredits` variant and the JS `InsufficientCreditsError` class are **retained but unused** (no longer thrown by any client path), to avoid rippling an error-enum removal through every binding. The spec's "remove from surface" intent is satisfied behaviourally — nothing throws it.
- **Open detail to confirm in Task A4:** whether `POST /expose`'s `subscriberId` expects the app_user_id or the internal subscriber id. Default to sending the core's current user scope (app_user_id when identified, else rovenue_id); adjust if the endpoint rejects it.

---

## File Structure

**Rust core (`packages/core-rs`)**
- `src/cache/schema.rs` — add `MIGRATION_V8`, bump `LATEST` 7→8 (creates `virtual_currency_balance` + `experiment_exposure` tables).
- `src/cache/virtual_currencies.rs` — NEW: `VirtualCurrencyRepo` (multi-row balances per scope).
- `src/cache/exposure.rs` — NEW: `ExposureRepo` (dedup ledger).
- `src/cache/credits.rs` — DELETE (replaced by virtual_currencies.rs).
- `src/cache/mod.rs` — register new repos, drop credits.
- `src/credits/` — rename to `src/virtual_currencies/`: `reader.rs` (`VirtualCurrencyReader`), `types.rs` (wire types), `mod.rs`.
- `src/exposure/mod.rs` — NEW: `ExposureTracker`.
- `src/transport/http_client.rs` — VC GET endpoint; remove spend POST.
- `src/receipts/types.rs` + `src/receipts/client.rs` — `ReceiptResult.virtual_currencies`; parse `virtualCurrencyBalances`.
- `src/observer.rs` — rename `CreditBalanceChanged` → `VirtualCurrenciesChanged`.
- `src/api.rs` — swap credit methods for VC methods; wire exposure into `experiment()`; update `finish_receipt`.
- `src/librovenue.udl` — swap credit methods + `ReceiptResult` field + `ChangeEvent` variant.
- `tests/` — new `cache_virtual_currencies_test.rs`, `exposure_test.rs`; rewrite `cache_credits_test.rs`, `credits_test.rs`; extend `cache_migration_test.rs`, `observer_test.rs`, `receipt_apple_test.rs`/`receipt_google_test.rs`.

**Native (`sdk-swift`, `sdk-kotlin`, `sdk-rn/{ios,android}`)**
- `sdk-swift/Sources/Rovenue/Rovenue.swift` + `Types.swift` — VC methods + `PurchaseResult.virtualCurrencies`.
- `sdk-kotlin/.../Rovenue.kt` + `Types.kt` — same.
- `sdk-rn/ios/RovenueModule.swift` + `sdk-rn/android/.../RovenueModule.kt` — VC bridge methods, PurchaseResult mapper, event-name rename.

**RN/JS (`packages/sdk-rn/src`)**
- `specs/RovenueModule.types.ts` — VC native methods + `PurchaseResultDTO`.
- `api/virtualCurrencies.ts` — NEW (replaces `api/credits.ts`).
- `hooks/useVirtualCurrencies.ts` — NEW (replaces `hooks/useCreditBalance.ts`).
- `types.ts`, `core/eventBridge.ts`, `store/reactiveStore.ts`, `index.ts` — rename event + store slot + barrel.
- `__tests__/hooks.test.tsx`, new `api/virtualCurrencies.test.ts` — tests.

**Docs (`apps/docs/content/docs`)** — credit → virtual-currency sections.

---

## Phase A — Rust core

### Task A1: Cache schema v8 — virtual_currency_balance + experiment_exposure tables + repos

**Files:**
- Modify: `packages/core-rs/src/cache/schema.rs`
- Create: `packages/core-rs/src/cache/virtual_currencies.rs`
- Create: `packages/core-rs/src/cache/exposure.rs`
- Modify: `packages/core-rs/src/cache/mod.rs`
- Delete: `packages/core-rs/src/cache/credits.rs`
- Test: `packages/core-rs/tests/cache_virtual_currencies_test.rs`, extend `packages/core-rs/tests/cache_migration_test.rs`

**Interfaces:**
- Produces: `VirtualCurrencyRepo { get_all(user_scope) -> RovenueResult<BTreeMap<String,i64>>, upsert_all(user_scope, &BTreeMap<String,i64>, updated_at_ms) -> RovenueResult<()>, get(user_scope, code) -> RovenueResult<Option<i64>> }`; `ExposureRepo { is_exposed(user_scope, experiment_id, variant_id) -> RovenueResult<bool>, mark(user_scope, experiment_id, variant_id, exposed_at_ms) -> RovenueResult<()> }`. Both constructed as `::new(store: Arc<CacheStore>)` mirroring `CreditBalanceRepo`.
- Consumes: the existing `CacheStore::with_conn(|c| ...)` pattern and `params!` from `credits.rs`.

- [ ] **Step 1: Write the failing migration test**

Add to `packages/core-rs/tests/cache_migration_test.rs`:

```rust
#[test]
fn migration_v8_creates_virtual_currency_and_exposure_tables() {
    let store = rovenue::cache::test_open_in_memory();
    // schema is migrated to LATEST on open
    let version = store
        .with_conn(|c| {
            let v: u32 = c
                .query_row("SELECT version FROM schema_meta", [], |r| r.get(0))?;
            Ok(v)
        })
        .unwrap();
    assert_eq!(version, 8, "LATEST schema version should be 8");

    // both new tables must exist and be writable
    store
        .with_conn(|c| {
            c.execute(
                "INSERT INTO virtual_currency_balance (user_scope, code, balance, updated_at_ms) VALUES ('s','gold',5,1)",
                [],
            )?;
            c.execute(
                "INSERT INTO experiment_exposure (user_scope, experiment_id, variant_id, exposed_at_ms) VALUES ('s','e1','v1',1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}
```

> If `cache::test_open_in_memory` does not exist, use the same in-memory open helper the existing `cache_migration_test.rs` already uses (read the top of that file and reuse its constructor).

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p librovenue --test cache_migration_test migration_v8 -- --nocapture`
Expected: FAIL (version is 7; tables missing).

- [ ] **Step 3: Add the migration and bump LATEST**

In `packages/core-rs/src/cache/schema.rs`, after the last existing `MIGRATION_V*` constant, add:

```rust
pub const MIGRATION_V8: &str = r#"
CREATE TABLE virtual_currency_balance (
    user_scope    TEXT NOT NULL,
    code          TEXT NOT NULL,
    balance       INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_scope, code)
);

CREATE TABLE experiment_exposure (
    user_scope    TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    variant_id    TEXT NOT NULL,
    exposed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_scope, experiment_id, variant_id)
);

UPDATE schema_meta SET version = 8;
"#;
```

Change the version constant:

```rust
pub const LATEST: u32 = 8;
```

Then register `MIGRATION_V8` in the migration runner exactly as the other migrations are registered (find where `MIGRATION_V7` is applied — typically a `match`/array stepping versions — and add the `7 => MIGRATION_V8` step in the same shape).

- [ ] **Step 4: Create the VC cache repo**

Create `packages/core-rs/src/cache/virtual_currencies.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::params;

use super::store::CacheStore;
use crate::error::{RovenueError, RovenueResult};

/// Per-scope multi-currency balances. Keyed by (user_scope, code); a scope
/// may hold balances in several currencies at once.
pub struct VirtualCurrencyRepo {
    store: Arc<CacheStore>,
}

impl VirtualCurrencyRepo {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    /// All balances for a scope, ordered by code for stable snapshotting.
    pub fn get_all(&self, user_scope: &str) -> RovenueResult<BTreeMap<String, i64>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT code, balance FROM virtual_currency_balance WHERE user_scope = ?1 ORDER BY code",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            let mut out = BTreeMap::new();
            while let Some(r) = rows.next()? {
                let code: String = r.get(0)?;
                let balance: i64 = r.get(1)?;
                out.insert(code, balance);
            }
            Ok(out)
        })
    }

    /// Single-currency convenience.
    pub fn get(&self, user_scope: &str, code: &str) -> RovenueResult<Option<i64>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT balance FROM virtual_currency_balance WHERE user_scope = ?1 AND code = ?2",
            )?;
            let mut rows = stmt.query(params![user_scope, code])?;
            if let Some(r) = rows.next()? {
                Ok(Some(r.get::<_, i64>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    /// Replace the full balance set for a scope (the server response is
    /// authoritative — currencies absent from `balances` are removed).
    pub fn upsert_all(
        &self,
        user_scope: &str,
        balances: &BTreeMap<String, i64>,
        updated_at_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "DELETE FROM virtual_currency_balance WHERE user_scope = ?1",
                params![user_scope],
            )?;
            for (code, balance) in balances {
                c.execute(
                    "INSERT INTO virtual_currency_balance (user_scope, code, balance, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![user_scope, code, balance, updated_at_ms as i64],
                )?;
            }
            Ok(())
        })
    }
}

// Silence unused-import lint if RovenueError isn't referenced directly.
const _: fn() -> Option<RovenueError> = || None;
```

> Adjust the `use super::store::CacheStore;` path to match how `credits.rs` imported the store type (open the old `credits.rs` before deleting it and copy its exact `use` lines + constructor signature).

- [ ] **Step 5: Create the exposure dedup repo**

Create `packages/core-rs/src/cache/exposure.rs`:

```rust
use std::sync::Arc;

use rusqlite::params;

use super::store::CacheStore;
use crate::error::RovenueResult;

/// Append-only dedup ledger: one row per (scope, experiment, variant) that
/// has already been reported as exposed. A variant change yields a new
/// (experiment_id, variant_id) pair → a fresh exposure.
pub struct ExposureRepo {
    store: Arc<CacheStore>,
}

impl ExposureRepo {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    pub fn is_exposed(
        &self,
        user_scope: &str,
        experiment_id: &str,
        variant_id: &str,
    ) -> RovenueResult<bool> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT 1 FROM experiment_exposure
                 WHERE user_scope = ?1 AND experiment_id = ?2 AND variant_id = ?3",
            )?;
            let mut rows = stmt.query(params![user_scope, experiment_id, variant_id])?;
            Ok(rows.next()?.is_some())
        })
    }

    pub fn mark(
        &self,
        user_scope: &str,
        experiment_id: &str,
        variant_id: &str,
        exposed_at_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO experiment_exposure
                   (user_scope, experiment_id, variant_id, exposed_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![user_scope, experiment_id, variant_id, exposed_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
```

- [ ] **Step 6: Register the new repos and remove credits**

In `packages/core-rs/src/cache/mod.rs`: remove the `pub mod credits;` line and any `pub use credits::...`; add:

```rust
pub mod virtual_currencies;
pub mod exposure;
pub use virtual_currencies::VirtualCurrencyRepo;
pub use exposure::ExposureRepo;
```

Delete `packages/core-rs/src/cache/credits.rs`.

- [ ] **Step 7: Write the repo round-trip test**

Create `packages/core-rs/tests/cache_virtual_currencies_test.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;

use rovenue::cache::{VirtualCurrencyRepo, ExposureRepo};

fn open() -> Arc<rovenue::cache::CacheStore> {
    // mirror the helper used by cache_credits_test.rs / cache_migration_test.rs
    Arc::new(rovenue::cache::test_open_in_memory())
}

#[test]
fn vc_repo_replaces_full_balance_set() {
    let store = open();
    let repo = VirtualCurrencyRepo::new(Arc::clone(&store));

    let mut m1 = BTreeMap::new();
    m1.insert("gold".to_string(), 10);
    m1.insert("gems".to_string(), 3);
    repo.upsert_all("scope", &m1, 100).unwrap();
    assert_eq!(repo.get("scope", "gold").unwrap(), Some(10));
    assert_eq!(repo.get_all("scope").unwrap(), m1);

    // server is authoritative: 'gems' dropped, 'gold' updated
    let mut m2 = BTreeMap::new();
    m2.insert("gold".to_string(), 7);
    repo.upsert_all("scope", &m2, 200).unwrap();
    assert_eq!(repo.get_all("scope").unwrap(), m2);
    assert_eq!(repo.get("scope", "gems").unwrap(), None);
}

#[test]
fn exposure_repo_dedups() {
    let store = open();
    let repo = ExposureRepo::new(Arc::clone(&store));
    assert!(!repo.is_exposed("s", "e1", "v1").unwrap());
    repo.mark("s", "e1", "v1", 1).unwrap();
    assert!(repo.is_exposed("s", "e1", "v1").unwrap());
    // a different variant is not yet exposed
    assert!(!repo.is_exposed("s", "e1", "v2").unwrap());
}
```

> Match `open()` to the real in-memory helper exported by the cache module (check `cache_credits_test.rs` for the exact symbol; if it's not `test_open_in_memory`, use the one it imports and update both new test files).

- [ ] **Step 8: Run the cache tests**

Run: `cargo test -p librovenue --test cache_virtual_currencies_test --test cache_migration_test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core-rs/src/cache packages/core-rs/tests/cache_virtual_currencies_test.rs packages/core-rs/tests/cache_migration_test.rs
git commit -m "feat(core): cache schema v8 — virtual_currency_balance + experiment_exposure tables"
```

---

### Task A2: VirtualCurrencyReader — replace CreditReader

**Files:**
- Rename dir: `packages/core-rs/src/credits/` → `packages/core-rs/src/virtual_currencies/` (`reader.rs`, `types.rs`, `mod.rs`)
- Modify: `packages/core-rs/src/lib.rs` (module declaration)
- Test: `packages/core-rs/tests/credits_test.rs` → rewrite as `packages/core-rs/tests/virtual_currencies_test.rs`

**Interfaces:**
- Produces: `VirtualCurrencyReader { balances() -> BTreeMap<String,i64>, balance(code: &str) -> i64, refresh() -> RovenueResult<()>, set_balances(scope, &BTreeMap<String,i64>, now_ms) -> RovenueResult<()>, maybe_refresh_async(staleness_ms) }`.
- Consumes: `VirtualCurrencyRepo` (Task A1), `ApiEnvelope<T>` from `transport::api`, `HttpRequest` from `transport::types`, the existing observer handle + clock + identity wiring that `CreditReader` held.

- [ ] **Step 1: Write the failing reader test**

Create `packages/core-rs/tests/virtual_currencies_test.rs` (mirror the structure of the old `credits_test.rs` — read it first for the mock-http + identity harness it uses):

```rust
// Uses the same mockito + in-memory-cache harness as the old credits_test.rs.
// Server returns the VC envelope shape: { data: { balances: { code: n } } }.

#[test]
fn refresh_parses_balances_envelope_and_caches_them() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"data":{"balances":{"gold":42,"gems":7}}}"#)
        .create();

    let core = test_core_with_base_url(&server.url()); // reuse old harness helper
    core.refresh_virtual_currencies().unwrap();

    assert_eq!(core.virtual_currency("gold".into()), 42);
    assert_eq!(core.virtual_currency("gems".into()), 7);
    assert_eq!(core.virtual_currency("missing".into()), 0);
    let all = core.virtual_currency_balances();
    assert_eq!(all.get("gold"), Some(&42));
}
```

> `test_core_with_base_url` stands for whatever constructor the old `credits_test.rs` used to build a `RovenueCore` pointed at the mock server. Reuse it verbatim.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p librovenue --test virtual_currencies_test`
Expected: FAIL (method/endpoint absent).

- [ ] **Step 3: Rename the module + types**

Rename the directory `src/credits/` to `src/virtual_currencies/`. In `src/lib.rs`, change `mod credits;` (or `pub mod credits;`) to `mod virtual_currencies;` (keep the same visibility).

In `src/virtual_currencies/types.rs`, replace the old credit wire types (`CreditBalanceWire`, `SpendBody`, `SpendResponse`) with:

```rust
use serde::Deserialize;
use std::collections::HashMap;

/// Wire shape of GET /v1/virtual-currencies/me's `data` field.
#[derive(Debug, Deserialize)]
pub struct VcBalancesWire {
    pub balances: HashMap<String, i64>,
}
```

- [ ] **Step 4: Rewrite the reader**

In `src/virtual_currencies/reader.rs`, keep the existing struct fields, constructor, `maybe_refresh_async`, and observer/clock/identity wiring from `CreditReader` (do not change those). Rename the type to `VirtualCurrencyReader`, swap its repo field type to `VirtualCurrencyRepo`, and replace the balance/refresh/consume methods with:

```rust
use std::collections::BTreeMap;

use crate::cache::VirtualCurrencyRepo;
use crate::observer::ChangeEvent;
use crate::transport::api::ApiEnvelope;
use crate::transport::types::HttpRequest;
use crate::error::{RovenueError, RovenueResult};
use super::types::VcBalancesWire;

impl VirtualCurrencyReader {
    /// All cached balances for the current user scope (code → balance).
    pub fn balances(&self) -> BTreeMap<String, i64> {
        let scope = self.identity.current_user_scope();
        self.repo.get_all(&scope).unwrap_or_default()
    }

    /// One currency's cached balance, or 0 when absent.
    pub fn balance(&self, code: &str) -> i64 {
        let scope = self.identity.current_user_scope();
        self.repo.get(&scope, code).ok().flatten().unwrap_or(0)
    }

    /// GET /v1/virtual-currencies/me → replace the cached balance set.
    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;
        let scope = self.identity.current_user_scope();

        let resp = http.get_json::<ApiEnvelope<VcBalancesWire>>(
            HttpRequest::new("/v1/virtual-currencies/me").user_scope(&scope),
        )?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        let balances: BTreeMap<String, i64> = body.data.balances.into_iter().collect();
        self.set_balances(&scope, &balances, clock.now_unix_ms())
    }

    /// Persist a balance set and emit `VirtualCurrenciesChanged` if it changed.
    pub fn set_balances(
        &self,
        scope: &str,
        balances: &BTreeMap<String, i64>,
        now_ms: u64,
    ) -> RovenueResult<()> {
        let changed = self.repo.get_all(scope).map(|prev| &prev != balances).unwrap_or(true);
        self.repo.upsert_all(scope, balances, now_ms)?;
        if changed {
            self.observer.emit(ChangeEvent::VirtualCurrenciesChanged);
        }
        Ok(())
    }
}
```

> Names to align with the existing struct: `self.repo`, `self.http`, `self.clock`, `self.identity`, `self.observer` — match whatever the old `CreditReader` called these fields. `resp.body`, `http.get_json`, and `clock.now_unix_ms()` follow the exact pattern from the old `CreditReader::refresh` (Task reference: `src/credits/reader.rs:57-67`). `self.observer.emit(...)` mirrors the old `store_and_emit`; reuse the same observer handle/method name.

Update `src/virtual_currencies/mod.rs` to export `VirtualCurrencyReader` and the types module.

> **Note — A2 is committed together with the observer/api/UDL changes below as one green checkpoint.** The reader references `ChangeEvent::VirtualCurrenciesChanged` and `api.rs` exposes the new methods; because uniffi processes the UDL at build time, the crate only compiles once the observer enum, `api.rs` methods, and UDL all move together. Steps 5–10 complete that atomic unit; the single `cargo test` + commit is at the end.

- [ ] **Step 5: Rename the observer variant**

In `packages/core-rs/src/observer.rs`, change:

```rust
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    CreditBalanceChanged,
    RemoteConfigChanged,
}
```

to:

```rust
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    VirtualCurrenciesChanged,
    RemoteConfigChanged,
}
```

Update any other `match`/usage of `CreditBalanceChanged` across the crate (grep `CreditBalanceChanged` and rename each to `VirtualCurrenciesChanged`).

- [ ] **Step 6: Replace the api.rs methods**

In `packages/core-rs/src/api.rs`, the field `self.credits` becomes `self.virtual_currencies` (rename in the struct definition and constructor where the reader is built — it's now `VirtualCurrencyReader::new(...)`). Replace the three credit methods (`credit_balance`, `refresh_credits`, `consume_credits` at `api.rs:308-325`) with:

```rust
pub fn virtual_currency_balances(&self) -> std::collections::HashMap<String, i64> {
    let out = self.virtual_currencies.balances().into_iter().collect();
    self.virtual_currencies.maybe_refresh_async(STALENESS_MS);
    out
}

pub fn virtual_currency(&self, code: String) -> i64 {
    let out = self.virtual_currencies.balance(&code);
    self.virtual_currencies.maybe_refresh_async(STALENESS_MS);
    out
}

pub fn refresh_virtual_currencies(&self) -> RovenueResult<()> {
    self.virtual_currencies.refresh()
}
```

- [ ] **Step 7: Update the UDL**

In `packages/core-rs/src/librovenue.udl`, replace the credit method block (lines ~117-123):

```
i64 credit_balance();

[Throws=RovenueError]
void refresh_credits();

[Throws=RovenueError]
i64 consume_credits(i64 amount, string? description);
```

with:

```
record<string, i64> virtual_currency_balances();

i64 virtual_currency(string code);

[Throws=RovenueError]
void refresh_virtual_currencies();
```

Change the `ChangeEvent` enum entry `"CreditBalanceChanged"` → `"VirtualCurrenciesChanged"`.

(Leave the `RovenueError` enum and the `InsufficientCredits` variant unchanged — see Global Constraints deviation note.)

- [ ] **Step 8: Write the observer test for the rename**

In `packages/core-rs/tests/observer_test.rs`, update any assertion referencing `CreditBalanceChanged` to `VirtualCurrenciesChanged`, and add:

```rust
#[test]
fn refresh_virtual_currencies_emits_virtual_currencies_changed() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_body(r#"{"data":{"balances":{"gold":1}}}"#)
        .create();
    let (core, events) = test_core_recording_events(&server.url()); // reuse harness
    core.refresh_virtual_currencies().unwrap();
    assert!(events.lock().unwrap().contains(&ChangeEvent::VirtualCurrenciesChanged));
}
```

> Reuse the event-recording observer harness already present in `observer_test.rs` (it registers a test observer and collects events); only the endpoint + variant name change.

- [ ] **Step 9: Run the reader + observer tests**

Run: `cargo test -p librovenue --test virtual_currencies_test --test observer_test`
Expected: PASS (the crate now compiles — reader + api + observer + UDL are all aligned).

- [ ] **Step 10: Commit the whole virtual-currency reader unit**

```bash
git rm packages/core-rs/tests/credits_test.rs
git add packages/core-rs/src/virtual_currencies packages/core-rs/src/lib.rs packages/core-rs/src/api.rs packages/core-rs/src/observer.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/virtual_currencies_test.rs packages/core-rs/tests/observer_test.rs
git commit -m "feat(core): VirtualCurrencyReader + FFI methods replace CreditReader; rename change event"
```

---

### Task A3: Receipt hydration → virtual_currencies

**Files:**
- Modify: `packages/core-rs/src/receipts/types.rs`
- Modify: `packages/core-rs/src/receipts/client.rs`
- Modify: `packages/core-rs/src/api.rs` (`finish_receipt`)
- Modify: `packages/core-rs/src/librovenue.udl` (`ReceiptResult`)
- Test: `packages/core-rs/tests/receipt_apple_test.rs`

**Interfaces:**
- Produces: `ReceiptResult { subscriber_id, app_user_id, virtual_currencies: HashMap<String,i64>, entitlements }`.
- Consumes: `VirtualCurrencyReader::set_balances` (A2).

- [ ] **Step 1: Update the failing receipt test**

In `packages/core-rs/tests/receipt_apple_test.rs`, change the mocked receipt response body to carry `virtualCurrencyBalances` and assert the new field. Find the existing apple-receipt success test and update its mock body + assertions:

```rust
// mock response body — replace the old `creditBalance` field:
.with_body(r#"{"data":{"subscriberId":"sub_1","appUserId":"u1","access":{...},"virtualCurrencyBalances":{"gold":12}}}"#)
// ... after posting the receipt:
let result = core.post_apple_receipt(receipt, product_id, None).unwrap();
assert_eq!(result.virtual_currencies.get("gold"), Some(&12));
assert_eq!(core.virtual_currency("gold".into()), 12);
```

> Keep the existing `access` object exactly as the current test has it; only swap the credit field for `virtualCurrencyBalances` and the assertion.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p librovenue --test receipt_apple_test`
Expected: FAIL (field `virtual_currencies` missing).

- [ ] **Step 3: Update ReceiptResult + the post outcome**

In `packages/core-rs/src/receipts/types.rs`, change:

```rust
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
    pub entitlements: Vec<Entitlement>,
}
```

to:

```rust
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub virtual_currencies: std::collections::HashMap<String, i64>,
    pub entitlements: Vec<Entitlement>,
}
```

In `packages/core-rs/src/receipts/client.rs`, find the response wire struct + the `ReceiptPostOutcome` it builds. Replace its `credit_balance: i64` field (deserialized from the old `creditBalance`) with:

```rust
#[serde(rename = "virtualCurrencyBalances", default)]
pub virtual_currency_balances: std::collections::HashMap<String, i64>,
```

and carry it onto `ReceiptPostOutcome` as `virtual_currencies: HashMap<String,i64>`.

- [ ] **Step 4: Update finish_receipt**

In `packages/core-rs/src/api.rs`, replace `finish_receipt` (currently `api.rs:368-385`):

```rust
fn finish_receipt(&self, scope: &str, outcome: ReceiptPostOutcome) -> ReceiptResult {
    let now = self.clock.now_unix_ms();
    match outcome.access {
        Some(access) => {
            let _ = self.entitlements.hydrate(scope, access, now);
        }
        None => {
            let _ = self.entitlements.refresh();
        }
    }
    let balances: std::collections::BTreeMap<String, i64> =
        outcome.virtual_currencies.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let _ = self.virtual_currencies.set_balances(scope, &balances, now);
    ReceiptResult {
        subscriber_id: outcome.subscriber_id,
        app_user_id: outcome.app_user_id,
        virtual_currencies: outcome.virtual_currencies,
        entitlements: self.entitlements.list_all().unwrap_or_default(),
    }
}
```

- [ ] **Step 5: Update the UDL ReceiptResult**

In `packages/core-rs/src/librovenue.udl`, change (lines ~64-69):

```
dictionary ReceiptResult {
    string subscriber_id;
    string app_user_id;
    i64 credit_balance;
    sequence<Entitlement> entitlements;
};
```

to:

```
dictionary ReceiptResult {
    string subscriber_id;
    string app_user_id;
    record<string, i64> virtual_currencies;
    sequence<Entitlement> entitlements;
};
```

- [ ] **Step 6: Run receipt tests**

Run: `cargo test -p librovenue --test receipt_apple_test --test receipt_google_test`
Expected: PASS. (Apply the same body/assertion swap to `receipt_google_test.rs` if it has a credit assertion.)

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/receipts packages/core-rs/src/api.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/receipt_apple_test.rs packages/core-rs/tests/receipt_google_test.rs
git commit -m "feat(core): receipts hydrate virtual_currencies from virtualCurrencyBalances"
```

---

### Task A4: Automatic exposure tracking

**Files:**
- Create: `packages/core-rs/src/exposure/mod.rs`
- Modify: `packages/core-rs/src/lib.rs` (declare module)
- Modify: `packages/core-rs/src/api.rs` (`experiment()` wires the tracker; construct tracker in `new`)
- Modify: `packages/core-rs/src/transport/http_client.rs` (expose POST helper if not already generic)
- Test: `packages/core-rs/tests/exposure_test.rs`

**Interfaces:**
- Produces: `ExposureTracker { maybe_track(&self, assignment: &ExperimentAssignment) }` — fire-and-forget; spawns a thread that POSTs `/v1/experiments/{id}/expose` and on HTTP success calls `ExposureRepo::mark`.
- Consumes: `ExposureRepo` (A1), the http client's generic `post_json`, `identity.current_user_scope()`.

- [ ] **Step 1: Write the failing exposure test**

Create `packages/core-rs/tests/exposure_test.rs` (reuse the mock-server + core harness):

```rust
// Verifies: first experiment(key) read fires exactly one POST /expose;
// repeated reads dedup; experiments_all() fires nothing.

#[test]
fn experiment_read_fires_one_exposure_then_dedups() {
    let mut server = mockito::Server::new();
    // remote config seeds one assignment for key "paywall" (experiment e1 / variant v1)
    seed_remote_config(&mut server); // reuse harness that stubs GET /v1/config

    let expose = server
        .mock("POST", "/v1/experiments/e1/expose")
        .match_body(mockito::Matcher::PartialJson(
            serde_json::json!({ "variantId": "v1" }),
        ))
        .with_status(202)
        .expect(1) // exactly once despite multiple reads
        .create();

    let core = test_core_with_base_url(&server.url());
    core.refresh_remote_config().unwrap();

    // multiple reads → still one exposure
    let _ = core.experiment("paywall".into());
    let _ = core.experiment("paywall".into());
    std::thread::sleep(std::time::Duration::from_millis(200)); // let async POST land

    expose.assert();
}

#[test]
fn experiments_all_does_not_fire_exposure() {
    let mut server = mockito::Server::new();
    seed_remote_config(&mut server);
    let expose = server.mock("POST", "/v1/experiments/e1/expose").expect(0).create();
    let core = test_core_with_base_url(&server.url());
    core.refresh_remote_config().unwrap();
    let _ = core.experiments_all();
    std::thread::sleep(std::time::Duration::from_millis(100));
    expose.assert();
}
```

> `seed_remote_config` / `test_core_with_base_url` reuse the remote-config test harness already in the suite (see `config_test.rs` / `offerings_test.rs` for how a `RovenueCore` is built against a mock server). The assignment ids (`e1`/`v1`) must match the seeded config payload.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p librovenue --test exposure_test`
Expected: FAIL (no POST is made).

- [ ] **Step 3: Implement the tracker**

Create `packages/core-rs/src/exposure/mod.rs`:

```rust
use std::sync::Arc;

use serde::Serialize;

use crate::cache::ExposureRepo;
use crate::identity::IdentityManager;
use crate::offerings::types::ExperimentAssignment; // adjust path to where ExperimentAssignment is defined
use crate::time::Clock;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;
use crate::transport::api::ApiEnvelope;

#[derive(Serialize)]
struct ExposeBody<'a> {
    #[serde(rename = "variantId")]
    variant_id: &'a str,
    #[serde(rename = "subscriberId")]
    subscriber_id: &'a str,
}

/// Best-effort, deduped experiment-exposure reporter. Reads stay non-blocking:
/// the POST runs on a spawned thread and only marks the dedup ledger on success,
/// so a failed report is retried on the next read.
pub struct ExposureTracker {
    repo: ExposureRepo,
    http: Option<Arc<HttpClient>>,
    clock: Option<Arc<dyn Clock>>,
    identity: Arc<IdentityManager>,
}

impl ExposureTracker {
    pub fn new(
        repo: ExposureRepo,
        http: Option<Arc<HttpClient>>,
        clock: Option<Arc<dyn Clock>>,
        identity: Arc<IdentityManager>,
    ) -> Arc<Self> {
        Arc::new(Self { repo, http, clock, identity })
    }

    pub fn maybe_track(self: &Arc<Self>, assignment: &ExperimentAssignment) {
        let (http, clock) = match (self.http.as_ref(), self.clock.as_ref()) {
            (Some(h), Some(c)) => (Arc::clone(h), Arc::clone(c)),
            _ => return,
        };
        let scope = self.identity.current_user_scope();
        let experiment_id = assignment.experiment_id.clone();
        let variant_id = assignment.variant_id.clone();

        // Cheap synchronous dedup check before spawning.
        if self.repo.is_exposed(&scope, &experiment_id, &variant_id).unwrap_or(false) {
            return;
        }

        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let path = format!("/v1/experiments/{experiment_id}/expose");
            let body = ExposeBody { variant_id: &variant_id, subscriber_id: &scope };
            let res = http.post_json::<ExposeBody, ApiEnvelope<serde_json::Value>>(
                HttpPostRequest::new(&path).user_scope(&scope),
                &body,
            );
            if res.is_ok() {
                let _ = this.repo.mark(&scope, &experiment_id, &variant_id, clock.now_unix_ms());
            }
        });
    }
}
```

> Adjust the `use` paths (`ExperimentAssignment`, `HttpClient`, `Clock`, `IdentityManager`) to the actual module locations — grep for `pub struct ExperimentAssignment` and `current_user_scope`. The `post_json` signature matches `CreditReader::consume`'s usage (Task reference `src/credits/reader.rs:69-92`). If the expose endpoint rejects a 202-with-empty-body deserialize, change the response type to a tolerant `ApiEnvelope<serde_json::Value>` or a unit decode — confirm against the live route.

Declare the module in `src/lib.rs`: `mod exposure;`.

- [ ] **Step 4: Wire it into experiment() and the constructor**

In `packages/core-rs/src/api.rs`, in `RovenueCore::new`, build the tracker after the cache store + http + identity exist:

```rust
let exposure = ExposureTracker::new(
    ExposureRepo::new(Arc::clone(&cache_store)),
    http.clone(),
    clock.clone(),
    Arc::clone(&identity),
);
```

(store it as `self.exposure`). Match the exact names of the local `cache_store`/`http`/`clock`/`identity` bindings already in `new`.

Change `experiment()` (currently `api.rs:481-485`):

```rust
pub fn experiment(&self, key: String) -> Option<ExperimentAssignment> {
    let out = self.remote_config.experiment(&key);
    self.remote_config.maybe_refresh_async(STALENESS_MS);
    if let Some(ref a) = out {
        self.exposure.maybe_track(a);
    }
    out
}
```

Leave `experiments_all()` untouched (no exposure).

- [ ] **Step 5: Run the exposure tests**

Run: `cargo test -p librovenue --test exposure_test`
Expected: PASS.

- [ ] **Step 6: Run the full core suite**

Run: `cargo test -p librovenue`
Expected: PASS (all suites, including the rewritten cache/credits/receipt tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/exposure packages/core-rs/src/lib.rs packages/core-rs/src/api.rs packages/core-rs/tests/exposure_test.rs
git commit -m "feat(core): automatic deduped experiment-exposure tracking on experiment(key)"
```

---

## Phase B — Regenerate bindings

### Task B1: Regenerate uniffi bindings

**Files:** none committed (generated dirs are gitignored).

- [ ] **Step 1: Regenerate**

Run (from repo root): `npm run sdk:bindings`
Expected: rebuilds `librovenue` and regenerates Swift bindings under `packages/sdk-swift/Sources/Rovenue/Generated/` and Kotlin under `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/`. The generated `ChangeEvent` now has `VirtualCurrenciesChanged`, the generated `RovenueCore` exposes `virtualCurrencyBalances()/virtualCurrency(code)/refreshVirtualCurrencies()`, and `ReceiptResult.virtualCurrencies` is a map.

- [ ] **Step 2: Verify generation succeeded**

Run: `grep -rl "virtualCurrencyBalances\|VirtualCurrenciesChanged" packages/sdk-swift/Sources/Rovenue/Generated packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated`
Expected: at least one match in each generated tree. No commit (artifacts are gitignored).

---

## Phase C — Native façades + RN bridges

### Task C1: Swift façade (sdk-swift)

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Types.swift`
- Test: existing sdk-swift test target

**Interfaces:**
- Produces: `Rovenue.virtualCurrencyBalances() async -> [String: Int64]`, `Rovenue.virtualCurrency(_ code: String) async -> Int64`, `Rovenue.refreshVirtualCurrencies() async throws`; `PurchaseResult.virtualCurrencies: [String: Int64]`.

- [ ] **Step 1: Replace the credit methods**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, replace the credit block (`creditBalance`/`refreshCredits`/`consumeCredits`, lines ~271-317) with:

```swift
    /// Read the cached virtual-currency balances (code → amount). Empty if uncached.
    public func virtualCurrencyBalances() async -> [String: Int64] {
        await dispatcher.runNonThrowing { [core] in
            core.virtualCurrencyBalances()
        }
    }

    /// One currency's cached balance, or 0 if absent.
    public func virtualCurrency(_ code: String) async -> Int64 {
        await dispatcher.runNonThrowing { [core] in
            core.virtualCurrency(code: code)
        }
    }

    /// Force a refresh of virtual-currency balances against the server.
    /// On change, emits `.virtualCurrenciesChanged`.
    public func refreshVirtualCurrencies() async throws {
        Self.emit(LogEntry(level: "info", message: "refreshVirtualCurrencies"))
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshVirtualCurrencies()
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "refreshVirtualCurrencies ok"))
        } catch {
            Self.emit(LogEntry(level: "error", message: "refreshVirtualCurrencies failed: \(error.localizedDescription)"))
            throw error
        }
    }
```

- [ ] **Step 2: Update PurchaseResult + its mapper**

In `packages/sdk-swift/Sources/Rovenue/Types.swift`, change `PurchaseResult` (lines ~115-134): replace `public let creditBalance: Int64` with `public let virtualCurrencies: [String: Int64]` and update the `init` accordingly.

Find where the façade builds a `PurchaseResult` from the core's `ReceiptResult`/`PurchaseResult` (grep `creditBalance:` in `Rovenue.swift`) and change `creditBalance: r.creditBalance` → `virtualCurrencies: r.virtualCurrencies`.

- [ ] **Step 3: Update any Swift test referencing creditBalance**

Grep the sdk-swift test target for `creditBalance`/`consumeCredits`/`creditBalanceChanged` and update to the VC equivalents (`virtualCurrencies`, `refreshVirtualCurrencies`, `.virtualCurrenciesChanged`).

- [ ] **Step 4: Run swift tests**

Run (in `packages/sdk-swift`): `swift test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue
git commit -m "feat(sdk-swift): virtual-currency façade methods; PurchaseResult.virtualCurrencies"
```

---

### Task C2: Kotlin façade (sdk-kotlin)

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Types.kt`
- Test: existing sdk-kotlin unit tests

**Interfaces:**
- Produces: `Rovenue.virtualCurrencyBalances(): Map<String, Long>`, `Rovenue.virtualCurrency(code: String): Long`, `Rovenue.refreshVirtualCurrencies()`; `PurchaseResult.virtualCurrencies: Map<String, Long>`.

- [ ] **Step 1: Replace the credit methods**

In `Rovenue.kt`, replace the credit block (lines ~336-370) with:

```kotlin
    /** Cached virtual-currency balances (code → amount). Empty if uncached. */
    suspend fun virtualCurrencyBalances(): Map<String, Long> =
        dispatcher.run { core.virtualCurrencyBalances() }

    /** One currency's cached balance, or 0 if absent. */
    suspend fun virtualCurrency(code: String): Long =
        dispatcher.run { core.virtualCurrency(code) }

    /** Force a refresh of virtual-currency balances against the server.
     *  On change, emits ChangeEvent.VIRTUAL_CURRENCIES_CHANGED. */
    @Throws(RovenueException::class)
    suspend fun refreshVirtualCurrencies() {
        emit(LogEntry(level = "info", message = "refreshVirtualCurrencies"))
        try {
            dispatcher.run { core.refreshVirtualCurrencies() }
            emit(LogEntry(level = "info", message = "refreshVirtualCurrencies ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "refreshVirtualCurrencies failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }
```

- [ ] **Step 2: Update PurchaseResult + its mapper**

In `Types.kt`, change `PurchaseResult` (lines ~66-72): replace `val creditBalance: Long,` with `val virtualCurrencies: Map<String, Long>,`.

Find where the façade builds `PurchaseResult` from the core result (grep `creditBalance` in `Rovenue.kt`) and change `creditBalance = r.creditBalance` → `virtualCurrencies = r.virtualCurrencies`.

- [ ] **Step 3: Update Kotlin tests referencing creditBalance**

Grep `src/test` for `creditBalance`/`consumeCredits`/`CREDIT_BALANCE_CHANGED` and update to VC equivalents (`virtualCurrencies`, `refreshVirtualCurrencies`, `VIRTUAL_CURRENCIES_CHANGED`).

- [ ] **Step 4: Run kotlin tests**

Run (in `packages/sdk-kotlin`): `./gradlew testDebugUnitTest`
Expected: PASS. (Per project note: use `testDebugUnitTest`, not a compile-only task.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src
git commit -m "feat(sdk-kotlin): virtual-currency façade methods; PurchaseResult.virtualCurrencies"
```

---

### Task C3: RN iOS bridge

**Files:**
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`

**Interfaces:**
- Produces (native module): `virtualCurrencies(): [String: Double]`, `virtualCurrency(code): Double`, `refreshVirtualCurrencies()`; `PurchaseResultDTO.virtualCurrencies`; event name `"VIRTUAL_CURRENCIES_CHANGED"`.

- [ ] **Step 1: Replace the credit bridge functions**

In `packages/sdk-rn/ios/RovenueModule.swift`, replace the credit functions (lines ~91-99):

```swift
        AsyncFunction("creditBalance") { () -> Double in
            // Long → Double is lossless up to 2^53.
            Double(await Rovenue.shared.creditBalance())
        }
        AsyncFunction("refreshCredits") { try await Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") { (amount: Double, description: String?) -> Double in
            let b = try await Rovenue.shared.consumeCredits(Int64(amount), description: description)
            return Double(b)
        }
```

with:

```swift
        AsyncFunction("virtualCurrencies") { () -> [String: Double] in
            // Long → Double is lossless up to 2^53.
            await Rovenue.shared.virtualCurrencyBalances().mapValues { Double($0) }
        }
        AsyncFunction("virtualCurrency") { (code: String) -> Double in
            Double(await Rovenue.shared.virtualCurrency(code))
        }
        AsyncFunction("refreshVirtualCurrencies") { try await Rovenue.shared.refreshVirtualCurrencies() }
```

- [ ] **Step 2: Update the PurchaseResult mapper**

Replace `dtoFromPurchaseResult` (lines ~323-330):

```swift
    private static func dtoFromPurchaseResult(_ r: PurchaseResult) -> [String: Any?] {
        [
            "entitlements": r.entitlements.map(dtoFromEntitlement),
            "virtualCurrencies": r.virtualCurrencies.mapValues { Double($0) },
            "productId": r.productId,
            "storeTransactionId": r.storeTransactionId,
        ]
    }
```

- [ ] **Step 3: Rename the change-event mapping case**

Find the `eventName(_:)` helper in this file (it maps `ChangeEvent` → the SCREAMING_SNAKE strings the JS bridge expects) and rename its `.creditBalanceChanged` case to `.virtualCurrenciesChanged` returning `"VIRTUAL_CURRENCIES_CHANGED"`.

Run: `grep -n "creditBalanceChanged\|CREDIT_BALANCE_CHANGED" packages/sdk-rn/ios/RovenueModule.swift`
Then update each hit to the VC name.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-rn/ios): virtual-currency bridge methods + event rename"
```

> No standalone unit test for the bridge here; correctness is exercised by the RN JS tests in Phase D against the mock native module, plus the native façade tests in C1.

---

### Task C4: RN Android bridge

**Files:**
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

- [ ] **Step 1: Replace the credit bridge functions**

Replace lines ~94-100:

```kotlin
        AsyncFunction("creditBalance") Coroutine { ->
            Rovenue.shared.creditBalance().toDouble()
        }
        AsyncFunction("refreshCredits") Coroutine { -> Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") Coroutine { amount: Double, description: String? ->
            Rovenue.shared.consumeCredits(amount.toLong(), description).toDouble()
        }
```

with:

```kotlin
        AsyncFunction("virtualCurrencies") Coroutine { ->
            Rovenue.shared.virtualCurrencyBalances().mapValues { it.value.toDouble() }
        }
        AsyncFunction("virtualCurrency") Coroutine { code: String ->
            Rovenue.shared.virtualCurrency(code).toDouble()
        }
        AsyncFunction("refreshVirtualCurrencies") Coroutine { -> Rovenue.shared.refreshVirtualCurrencies() }
```

- [ ] **Step 2: Update the PurchaseResult mapper**

Replace lines ~290-295:

```kotlin
    private fun dtoFromPurchaseResult(r: PurchaseResult): Map<String, Any?> = mapOf(
        "entitlements"      to r.entitlements.map(::dtoFromEntitlement),
        "virtualCurrencies" to r.virtualCurrencies.mapValues { it.value.toDouble() },
        "productId"         to r.productId,
        "storeTransactionId" to r.storeTransactionId,
    )
```

- [ ] **Step 3: Event name**

The Android bridge sends `event.name` (the generated Kotlin enum constant). After Task B1 regeneration the constant is `VIRTUAL_CURRENCIES_CHANGED`, so the `OnStartObserving` block needs no change. Verify:

Run: `grep -n "CREDIT_BALANCE_CHANGED\|creditBalance" packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
Expected: no matches after the edits above.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-rn/android): virtual-currency bridge methods"
```

---

## Phase D — RN / JS

### Task D1: Native spec types

**Files:**
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`

**Interfaces:**
- Produces: spec methods `virtualCurrencies(): Promise<Record<string, number>>`, `virtualCurrency(code: string): Promise<number>`, `refreshVirtualCurrencies(): Promise<void>`; `PurchaseResultDTO.virtualCurrencies: Record<string, number>`.

- [ ] **Step 1: Replace the Credits block in the spec**

In `RovenueModule.types.ts`, replace:

```ts
  // Credits
  creditBalance(): Promise<number>;
  refreshCredits(): Promise<void>;
  consumeCredits(amount: number, description: string | null): Promise<number>;
```

with:

```ts
  // Virtual currencies (multi-currency; reads only — spend is server-side)
  virtualCurrencies(): Promise<Record<string, number>>;
  virtualCurrency(code: string): Promise<number>;
  refreshVirtualCurrencies(): Promise<void>;
```

- [ ] **Step 2: Update PurchaseResultDTO**

Replace `creditBalance: number;` in `PurchaseResultDTO` with `virtualCurrencies: Record<string, number>;`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/react-native-sdk exec tsc --noEmit`
Expected: errors in `api/credits.ts`, `hooks/useCreditBalance.ts`, `index.ts`, `types.ts` (fixed in D2–D4). The spec file itself must be error-free.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/src/specs/RovenueModule.types.ts
git commit -m "feat(sdk-rn): virtual-currency native spec methods"
```

---

### Task D2: Virtual-currencies JS API

**Files:**
- Create: `packages/sdk-rn/src/api/virtualCurrencies.ts`
- Delete: `packages/sdk-rn/src/api/credits.ts`
- Test: `packages/sdk-rn/src/api/virtualCurrencies.test.ts`

**Interfaces:**
- Produces: `virtualCurrencies(): Promise<Record<string, number>>`, `virtualCurrency(code: string): Promise<number>`, `refreshVirtualCurrencies(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/api/virtualCurrencies.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { virtualCurrencies, virtualCurrency, refreshVirtualCurrencies } from "./virtualCurrencies";

const calls: string[] = [];
const mockNative: any = {
  virtualCurrencies: async () => { calls.push("all"); return { gold: 5, gems: 2 }; },
  virtualCurrency: async (code: string) => { calls.push(`one:${code}`); return code === "gold" ? 5 : 0; },
  refreshVirtualCurrencies: async () => { calls.push("refresh"); },
};

describe("virtualCurrencies api", () => {
  beforeEach(() => { calls.length = 0; _setNativeForTesting(mockNative); });

  it("reads the balances map", async () => {
    expect(await virtualCurrencies()).toEqual({ gold: 5, gems: 2 });
    expect(calls).toContain("all");
  });
  it("reads a single currency, 0 when absent", async () => {
    expect(await virtualCurrency("gold")).toBe(5);
    expect(await virtualCurrency("silver")).toBe(0);
  });
  it("refreshes", async () => {
    await refreshVirtualCurrencies();
    expect(calls).toContain("refresh");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/react-native-sdk test virtualCurrencies`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the api module**

Create `packages/sdk-rn/src/api/virtualCurrencies.ts`:

```ts
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/** All virtual-currency balances (code → amount). */
export async function virtualCurrencies(): Promise<Record<string, number>> {
  return call(() => getNative().virtualCurrencies());
}

/** One currency's balance; 0 when the code is absent. */
export async function virtualCurrency(code: string): Promise<number> {
  return call(() => getNative().virtualCurrency(code));
}

/** Force a refresh of virtual-currency balances from the server. */
export async function refreshVirtualCurrencies(): Promise<void> {
  return call(() => getNative().refreshVirtualCurrencies());
}
```

Delete `packages/sdk-rn/src/api/credits.ts`.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @rovenue/react-native-sdk test virtualCurrencies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git rm packages/sdk-rn/src/api/credits.ts
git add packages/sdk-rn/src/api/virtualCurrencies.ts packages/sdk-rn/src/api/virtualCurrencies.test.ts
git commit -m "feat(sdk-rn): virtualCurrencies JS api (replaces credits)"
```

---

### Task D3: useVirtualCurrencies hooks

**Files:**
- Create: `packages/sdk-rn/src/hooks/useVirtualCurrencies.ts`
- Delete: `packages/sdk-rn/src/hooks/useCreditBalance.ts`
- Test: `packages/sdk-rn/src/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces: `useVirtualCurrencies(): Record<string, number>`, `useVirtualCurrency(code: string): number`. Both read store slot `"virtualCurrencies"`.

- [ ] **Step 1: Write the failing hook test**

In `packages/sdk-rn/src/__tests__/hooks.test.tsx`, replace the `useCreditBalance` test with (and update the import):

```tsx
import { useVirtualCurrencies, useVirtualCurrency } from "../hooks/useVirtualCurrencies";
import { store } from "../store/reactiveStore";

it("useVirtualCurrencies reflects the store slot", async () => {
  store.set("virtualCurrencies", { gold: 9 });
  const { result } = renderHook(() => useVirtualCurrencies());
  expect(result.current).toEqual({ gold: 9 });
});

it("useVirtualCurrency returns 0 for an absent code", async () => {
  store.set("virtualCurrencies", { gold: 9 });
  const { result } = renderHook(() => useVirtualCurrency("silver"));
  expect(result.current).toBe(0);
});
```

> Keep the file's existing `renderHook`/mock-native setup; only swap the credit case. If the mock native is asserted on, add `virtualCurrencies: async () => ({})` to it.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/react-native-sdk test hooks`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the hook module**

Create `packages/sdk-rn/src/hooks/useVirtualCurrencies.ts`:

```ts
import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";

const EMPTY: Record<string, number> = {};

function loadIfNeeded(): void {
  if (store.get("virtualCurrencies") === undefined) {
    getNative()
      .virtualCurrencies()
      .then((m) => store.set("virtualCurrencies", m))
      .catch(() => {});
  }
}

/** Reactive map of all virtual-currency balances (code → amount). */
export function useVirtualCurrencies(): Record<string, number> {
  useEffect(loadIfNeeded, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.get<Record<string, number>>("virtualCurrencies") ?? EMPTY,
    () => EMPTY,
  );
}

/** Reactive single-currency balance; 0 when absent. */
export function useVirtualCurrency(code: string): number {
  const all = useVirtualCurrencies();
  return all[code] ?? 0;
}
```

Delete `packages/sdk-rn/src/hooks/useCreditBalance.ts`.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @rovenue/react-native-sdk test hooks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git rm packages/sdk-rn/src/hooks/useCreditBalance.ts
git add packages/sdk-rn/src/hooks/useVirtualCurrencies.ts packages/sdk-rn/src/__tests__/hooks.test.tsx
git commit -m "feat(sdk-rn): useVirtualCurrencies/useVirtualCurrency hooks (replace useCreditBalance)"
```

---

### Task D4: types, store, event bridge, barrel

**Files:**
- Modify: `packages/sdk-rn/src/types.ts`
- Modify: `packages/sdk-rn/src/store/reactiveStore.ts`
- Modify: `packages/sdk-rn/src/core/eventBridge.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Test: `packages/sdk-rn/src/__tests__/eventBridge.test.ts`

**Interfaces:**
- Produces: `ChangeEvent` union member `'VIRTUAL_CURRENCIES_CHANGED'`; `PurchaseResult.virtualCurrencies`; store slot `"virtualCurrencies"`; `Rovenue.virtualCurrencies/virtualCurrency/refreshVirtualCurrencies`; `useVirtualCurrencies`/`useVirtualCurrency` exports.

- [ ] **Step 1: Update types.ts**

In `packages/sdk-rn/src/types.ts`:
- In `PurchaseResult`, replace `creditBalance: number;` with `virtualCurrencies: Record<string, number>;`.
- In the `ChangeEvent` union, replace `| 'CREDIT_BALANCE_CHANGED'` with `| 'VIRTUAL_CURRENCIES_CHANGED'`.

- [ ] **Step 2: Update the reactive store slot type**

In `packages/sdk-rn/src/store/reactiveStore.ts`, change the `StoreSlot` union member `"creditBalance"` → `"virtualCurrencies"`, and add `Record<string, number>` to the `StoreValue` union:

```ts
type StoreSlot =
  | "user"
  | "virtualCurrencies"
  | "entitlementsAll"
  | "remoteConfig"
  | `entitlement:${string}`;

type StoreValue =
  | User
  | number
  | Record<string, number>
  | Entitlement
  | Entitlement[]
  | RemoteConfig
  | null;
```

- [ ] **Step 3: Update the event bridge**

In `packages/sdk-rn/src/core/eventBridge.ts`, replace the credit case:

```ts
        case "CREDIT_BALANCE_CHANGED": {
          const balance = await native.creditBalance();
          store.set("creditBalance", balance);
          break;
        }
```

with:

```ts
        case "VIRTUAL_CURRENCIES_CHANGED": {
          const balances = await native.virtualCurrencies();
          store.set("virtualCurrencies", balances);
          break;
        }
```

- [ ] **Step 4: Update the barrel (index.ts)**

In `packages/sdk-rn/src/index.ts`:
- Change the import `import { creditBalance, refreshCredits, consumeCredits } from "./api/credits";` to `import { virtualCurrencies, virtualCurrency, refreshVirtualCurrencies } from "./api/virtualCurrencies";`.
- Change `export { useCreditBalance } from "./hooks/useCreditBalance";` to `export { useVirtualCurrencies, useVirtualCurrency } from "./hooks/useVirtualCurrencies";`.
- In the `Rovenue` object, replace the three lines `creditBalance, refreshCredits, consumeCredits,` with `virtualCurrencies, virtualCurrency, refreshVirtualCurrencies,`.
- Update the header comment list `useCreditBalance` → `useVirtualCurrencies`.
- (Leave `InsufficientCreditsError` exported — retained-but-unused per Global Constraints.)

- [ ] **Step 5: Update the eventBridge test**

In `packages/sdk-rn/src/__tests__/eventBridge.test.ts`, replace the `CREDIT_BALANCE_CHANGED` case test with `VIRTUAL_CURRENCIES_CHANGED`, asserting the mock native `virtualCurrencies()` is called and the store slot `"virtualCurrencies"` is set. Add `virtualCurrencies: async () => ({ gold: 3 })` to the mock native used in that file.

- [ ] **Step 6: Run the full RN suite + typecheck**

Run: `pnpm --filter @rovenue/react-native-sdk exec tsc --noEmit && pnpm --filter @rovenue/react-native-sdk test`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src/types.ts packages/sdk-rn/src/store/reactiveStore.ts packages/sdk-rn/src/core/eventBridge.ts packages/sdk-rn/src/index.ts packages/sdk-rn/src/__tests__/eventBridge.test.ts
git commit -m "feat(sdk-rn): wire virtual-currencies through types, store, event bridge, barrel"
```

---

## Phase E — Docs + version bumps

### Task E1: Docs + version bumps

**Files:**
- Modify: `apps/docs/content/docs/platforms/react-native.mdx`, `platforms/ios-swift.mdx`, `platforms/android-kotlin.mdx`, `getting-started/core-concepts.mdx`, `getting-started/quickstart.mdx`, `resources/migrating-from-revenuecat.mdx`
- Modify: `packages/sdk-rn/package.json`, root `Cargo.toml`

- [ ] **Step 1: Find all credit references in docs**

Run: `grep -rln "creditBalance\|consumeCredits\|refreshCredits\|useCreditBalance\|credit balance" apps/docs/content/docs`

- [ ] **Step 2: Rewrite each hit**

For each file, replace the credit API examples with the virtual-currencies equivalents:
- `Rovenue.creditBalance()` → `Rovenue.virtualCurrencies()` (returns a `{ code: amount }` map) and `Rovenue.virtualCurrency(code)`.
- `Rovenue.refreshCredits()` → `Rovenue.refreshVirtualCurrencies()`.
- `useCreditBalance()` → `useVirtualCurrencies()` / `useVirtualCurrency(code)`.
- **Remove** any `consumeCredits` / client-side spend example. Add one sentence: "Spending virtual currency is a server-side operation — call the secret-key `POST /v1/virtual-currencies/:appUserId/:code/transactions` from your backend." (mirror the wording in `migrating-from-revenuecat.mdx`).
- Swift/Kotlin platform docs: `creditBalance()`/`consumeCredits()` → `virtualCurrencyBalances()`/`virtualCurrency(code)`/`refreshVirtualCurrencies()`.

- [ ] **Step 3: Bump versions**

In `packages/sdk-rn/package.json`, bump `"version"` `0.3.0` → `0.4.0`. In root `Cargo.toml`, bump `version = "0.7.0"` → `version = "0.8.0"`. (Breaking change.)

- [ ] **Step 4: Verify no stale credit references remain in docs**

Run: `grep -rn "creditBalance\|consumeCredits\|useCreditBalance" apps/docs/content/docs`
Expected: no matches (except any intentional "migrating from single-currency credits" historical note).

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs packages/sdk-rn/package.json Cargo.toml
git commit -m "docs(sdk): migrate credit docs to virtual currencies; bump SDK versions"
```

---

## Final verification

- [ ] **Run every layer's suite:**
  - `cargo test -p librovenue` → PASS
  - `npm run sdk:bindings` → regenerates cleanly
  - `cd packages/sdk-swift && swift test` → PASS
  - `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest` → PASS
  - `pnpm --filter @rovenue/react-native-sdk exec tsc --noEmit && pnpm --filter @rovenue/react-native-sdk test` → PASS
- [ ] **Grep for stragglers:** `grep -rn "credit_balance\|creditBalance\|consumeCredits\|me/credits\|CreditBalanceChanged\|CREDIT_BALANCE_CHANGED" packages/ --include=*.rs --include=*.swift --include=*.kt --include=*.ts` → only the retained-but-unused `InsufficientCredits`/`InsufficientCreditsError` identifiers should remain.
```
