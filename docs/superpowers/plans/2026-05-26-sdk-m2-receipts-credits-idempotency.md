# SDK M2 — Receipts + Credits + Idempotency (+ M1 contract fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M2 milestone Rust-core slice: receipt posting for Apple StoreKit 2 + Google Play Billing, credit-ledger reads + `consume_credits` mutation with idempotency, plus the M1 server-contract bug fixes (`X-Rovenue-App-User-Id` header, `{data: T}` response envelope, real entitlement wire model). Adds 429 `Retry-After` honoring within the retry budget and a `set_foreground → refresh` end-to-end integration test that was deferred from M1.

**Architecture:** Sync FFI surface continues (per spec §3.2). `reqwest::blocking` POST gains `Idempotency-Key` middleware. SQLite cache evolves to schema v2 (new `credit_balance` table; `entitlements` columns rewritten to match `AccessResponseEntry`). All endpoint responses are deserialized through an `ApiEnvelope<T> = { data: T }` wrapper. Idempotency keys are client-generated `cuid2` strings reused across retries of the same logical call (so retries hit the server-side dedup window correctly).

**Tech Stack:** Same as M1. No new runtime deps. **No new dev deps** — the M1 mockito + tempfile + serial_test set covers everything.

**Non-goals for M2:**
- **Façade integration** — Swift `AsyncStream`, Kotlin `Flow`, RN hooks remain separate plans.
- **Stripe receipt POST** — Stripe is webhook-only on the server (per CLAUDE.md). No SDK-side endpoint exists; if/when needed, add to a later plan.
- **Server-side ETag** — `GET /v1/me/entitlements` doesn't emit `ETag`, so the `etag_cache` table lands no rows for it. We leave the M1 column + the HttpClient `If-None-Match` plumbing in place for future endpoints.
- **`/v1/subscribers/transfer`** — server-to-server identity merge. Customer backend's job; SDK identify() stays client-local (matches memory `rovenue_sdk_identify_is_client_local.md`).
- **`post_attributes`** — `/me/attributes` exists on the server but is not on the M2 critical path. M3+.
- **Receipt restoration** — `restore_purchases` (re-fetching all entitlements from the store) lands with façade work (StoreKit / Play Billing native calls live there).
- **sqlcipher / encrypted cache** — still deferred to M1.5+.

---

## Server Contract Reference (verified 2026-05-26)

Endpoints already implemented in `apps/api/src/routes/v1/`:

| Method | Path | Body | Response (envelope: `{ "data": <…> }`) |
|---|---|---|---|
| `GET` | `/v1/me/entitlements` | — | `{ "entitlements": { "<key>": { "isActive": bool, "expiresDate": ISO\|null, "store": string, "productIdentifier": string } } }` |
| `GET` | `/v1/me/credits` | — | `{ "balance": number }` |
| `POST` | `/v1/me/credits/spend` | `{ "amount": int>0, "description"?: string, "metadata"?: object }` | `{ "balance": number, "ledgerEntry": { "id": string, "amount": int, "balance": number, "type": string, "createdAt": ISO } }` |
| `POST` | `/v1/receipts/apple` | `{ "receipt": string, "appUserId": string, "productId": string }` | `{ "subscriber": {…}, "access": {…}, "credits": { "balance": number } }` |
| `POST` | `/v1/receipts/google` | `{ "receipt": string, "appUserId": string, "productId": string }` | (same shape as `/apple`) |

**Auth:** `Authorization: Bearer <publicApiKey>` (existing).

**User scope header:** `X-Rovenue-App-User-Id: <coreUserId>` (M1 was wrongly sending `X-Rovenue-User`).

**Idempotency:** `Idempotency-Key: <opaque string ≤255 chars>` REQUIRED on `/v1/receipts/*` and `/v1/me/credits/spend`. Server caches 2xx response for 24h scoped to project; same key + different body → `422`. Server adds `Idempotent-Replay: true` header on replayed responses.

**402 InsufficientCredits:** `POST /v1/me/credits/spend` returns `402` with body `{ "error": { "code": "...", "message": "Insufficient credits: N available, M requested" } }` when balance < amount.

---

## File Structure

**New crate files:**

- `src/cache/credits.rs` — `CreditBalanceRow` + `CreditBalanceRepo` (single-row per user_scope)
- `src/cache/schema_v2.rs` — schema v2 migration SQL (replaces entitlements columns + adds credit_balance + bumps schema_meta)
- `src/transport/api.rs` — `ApiEnvelope<T> = { data: T }` deser wrapper
- `src/transport/idempotency.rs` — cuid2 idempotency-key generator
- `src/receipts/mod.rs`, `src/receipts/types.rs`, `src/receipts/client.rs` — receipt wire models + `ReceiptClient::post_apple/post_google`
- `src/credits/mod.rs`, `src/credits/reader.rs`, `src/credits/types.rs` — `Credits` projection + `CreditReader::balance/refresh/consume`

**Modified files:**

- `packages/core-rs/src/error.rs` — `+UserNotFound, InsufficientCredits, EntitlementInactive, DuplicatePurchase, ReceiptInvalid`
- `packages/core-rs/src/librovenue.udl` — declare new types + 5 new FFI methods on `RovenueCore`
- `packages/core-rs/src/cache/mod.rs` — add `credits` module + bump `schema::LATEST` to 2
- `packages/core-rs/src/cache/schema.rs` — register v2 migration
- `packages/core-rs/src/cache/entitlements.rs` — `EntitlementRow` gains `store: String`, `product_identifier: String`, `expires_at_iso` becomes the source-of-truth (timestamps survive as `expires_at_ms` for legacy callers)
- `packages/core-rs/src/entitlements/types.rs` — wire model rewrites to match `AccessResponseEntry`; FFI `Entitlement` gains `store` + `expires_iso`
- `packages/core-rs/src/entitlements/api.rs` — `map_to_rows(map: HashMap<String, AccessResponseEntry>, now: u64) -> Vec<EntitlementRow>`
- `packages/core-rs/src/entitlements/reader.rs` — refresh hits `/v1/me/entitlements`, deserializes `ApiEnvelope<EntitlementsResponse>`, accepts the **map** shape
- `packages/core-rs/src/transport/http_client.rs` — header rename (`X-Rovenue-User` → `X-Rovenue-App-User-Id`), 429 within-budget retry, new `post_json` with `Idempotency-Key`
- `packages/core-rs/src/transport/mod.rs` — re-export `api`, `idempotency`
- `packages/core-rs/src/api.rs` — `RovenueCore` gains `post_apple_receipt`, `post_google_receipt`, `credit_balance`, `consume_credits`, registers a 2nd polling tick for credits
- `packages/core-rs/src/observer.rs` — `ChangeEvent::CreditBalanceChanged` variant
- `packages/core-rs/src/lib.rs` — module declarations + re-exports
- `scripts/sdk-parity.sh` — add new M2 Rust test suites to the parity block
- `.github/workflows/sdk.yml` — no new step; existing apt + 1.88 toolchain cover this

**New integration tests:**

- `packages/core-rs/tests/cache_credits_test.rs` — credit balance repo
- `packages/core-rs/tests/cache_schema_v2_test.rs` — v1→v2 migration roundtrip
- `packages/core-rs/tests/idempotency_test.rs` — cuid2 generator + key reuse across retries
- `packages/core-rs/tests/post_json_test.rs` — mockito-driven POST happy path + idempotent replay + 422 key conflict
- `packages/core-rs/tests/receipt_apple_test.rs` — `/v1/receipts/apple` end-to-end against mockito
- `packages/core-rs/tests/receipt_google_test.rs` — `/v1/receipts/google` end-to-end
- `packages/core-rs/tests/credits_test.rs` — `GET /me/credits` + `POST /me/credits/spend` + 402 mapping
- `packages/core-rs/tests/foreground_refresh_e2e_test.rs` — `set_foreground(true)` → polling tick → HTTP refresh observable (the M1-deferred test)

**Modified tests:**

- `packages/core-rs/tests/entitlement_read_test.rs` — fixture rewritten to map shape + envelope
- `packages/core-rs/tests/fixtures/entitlements_response.json` — new map shape under `data` envelope
- `packages/core-rs/tests/integration_smoke.rs` — extend smoke for new FFI methods
- `packages/core-rs/tests/http_client_test.rs` — update header expectation (`x-rovenue-app-user-id`) + 429 within-budget retry case

---

## Conventions

- **All FFI methods on `RovenueCore` remain blocking** (sync). Façades will wrap them later.
- **Lib name is `rovenue`** (`use rovenue::...` in tests). Package name is `librovenue`.
- **TDD per task** — failing test first, then implementation. Tests run via `cargo test -p librovenue --test <name>`.
- **Idempotency-Key reuse:** an SDK call that retries internally must reuse the **same** key across attempts. A *new* call from the user generates a *new* key. This matches the server's dedup window semantics.
- **Response unwrap:** every server response is `ApiEnvelope<T> { data: T }`. Use `resp.json::<ApiEnvelope<T>>()?.data` everywhere.
- **No new deps.** Rebuild on M1's set.

---

## Task 1: RovenueError gains receipt + credit variants

**Files:**
- Modify: `packages/core-rs/src/error.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/tests/error_test.rs`

- [ ] **Step 1.1: Write failing tests**

Append to `packages/core-rs/tests/error_test.rs`:

```rust
#[test]
fn user_not_found_displays() {
    assert_eq!(format!("{}", RovenueError::UserNotFound), "user not found");
}

#[test]
fn insufficient_credits_displays() {
    assert_eq!(format!("{}", RovenueError::InsufficientCredits), "insufficient credits");
}

#[test]
fn entitlement_inactive_displays() {
    assert_eq!(format!("{}", RovenueError::EntitlementInactive), "entitlement inactive");
}

#[test]
fn duplicate_purchase_displays() {
    assert_eq!(format!("{}", RovenueError::DuplicatePurchase), "duplicate purchase");
}

#[test]
fn receipt_invalid_displays() {
    assert_eq!(format!("{}", RovenueError::ReceiptInvalid), "receipt invalid");
}
```

- [ ] **Step 1.2: Run, see compile failure**

```bash
source $HOME/.cargo/env && cargo test -p librovenue --test error_test
```
Expected: FAIL — variants not defined.

- [ ] **Step 1.3: Extend the enum**

Edit `packages/core-rs/src/error.rs`. Add the five variants between `Storage` and `Internal`:

```rust
    #[error("user not found")]
    UserNotFound,

    #[error("insufficient credits")]
    InsufficientCredits,

    #[error("entitlement inactive")]
    EntitlementInactive,

    #[error("duplicate purchase")]
    DuplicatePurchase,

    #[error("receipt invalid")]
    ReceiptInvalid,
```

- [ ] **Step 1.4: Update UDL**

Edit `packages/core-rs/src/librovenue.udl`. Replace the `[Error] enum RovenueError { ... }` block with:

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
    "UserNotFound",
    "InsufficientCredits",
    "EntitlementInactive",
    "DuplicatePurchase",
    "ReceiptInvalid",
    "Internal",
};
```

- [ ] **Step 1.5: Verify**

```bash
cargo test -p librovenue --test error_test
```
Expected: 13 passed (8 M1 + 5 new).

```bash
cargo test -p librovenue
```
Expected: full suite green.

- [ ] **Step 1.6: Commit**

```bash
git add packages/core-rs/src/error.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/error_test.rs
git commit -m "feat(core-rs): RovenueError gains receipt + credit variants"
```

---

## Task 2: Header rename — `X-Rovenue-User` → `X-Rovenue-App-User-Id`

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs`
- Modify: `packages/core-rs/tests/http_client_test.rs`

The M1 SDK was sending the wrong header name. The server reads `x-rovenue-app-user-id`. This fix is mechanical but it WILL break every existing HTTP test that asserted `x-rovenue-user` — those need updating too.

- [ ] **Step 2.1: Update the failing test first (TDD-ish — the production code is wrong, so the test must match server reality)**

Edit `packages/core-rs/tests/http_client_test.rs`. Find every `.match_header("x-rovenue-user", "anon_123")` line and rename to `.match_header("x-rovenue-app-user-id", "anon_123")`. Save the file.

- [ ] **Step 2.2: Run, see failure**

```bash
source $HOME/.cargo/env && cargo test -p librovenue --test http_client_test
```
Expected: FAIL — server mismatch (mockito reports unmatched header).

- [ ] **Step 2.3: Fix the production header**

Edit `packages/core-rs/src/transport/http_client.rs`. Find the line:

```rust
                builder = builder.header("X-Rovenue-User", scope);
```

Replace with:

```rust
                builder = builder.header("X-Rovenue-App-User-Id", scope);
```

- [ ] **Step 2.4: Verify**

```bash
cargo test -p librovenue --test http_client_test
```
Expected: 5 passed.

Also update `packages/core-rs/tests/entitlement_read_test.rs` if it asserts on the old header (search for `x-rovenue-user`). The M1 file may not — check before editing.

```bash
grep -n 'x-rovenue-user' packages/core-rs/tests/*.rs
```
Expected: no matches after the fix.

```bash
cargo test -p librovenue
```
Expected: full suite green.

- [ ] **Step 2.5: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs packages/core-rs/tests/http_client_test.rs
git commit -m "fix(core-rs): use X-Rovenue-App-User-Id header (matches server contract)"
```

---

## Task 3: ApiEnvelope deser wrapper

**Files:**
- Create: `packages/core-rs/src/transport/api.rs`
- Modify: `packages/core-rs/src/transport/mod.rs`
- Create: `packages/core-rs/tests/api_envelope_test.rs`

Every server response is wrapped `{ "data": <…> }`. M1 deserialized the inner payload directly — that worked in mockito because we hand-rolled the JSON, but it does not work against the real server. This task introduces a `ApiEnvelope<T>` wrapper that callers use everywhere.

- [ ] **Step 3.1: Write failing test**

Create `packages/core-rs/tests/api_envelope_test.rs`:

```rust
use rovenue::transport::api::ApiEnvelope;
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct Payload {
    name: String,
    count: u32,
}

#[test]
fn unwraps_data_envelope() {
    let json = r#"{"data": {"name": "pro", "count": 7}}"#;
    let env: ApiEnvelope<Payload> = serde_json::from_str(json).unwrap();
    assert_eq!(env.data, Payload { name: "pro".into(), count: 7 });
}

#[test]
fn rejects_missing_data_field() {
    let json = r#"{"name": "pro", "count": 7}"#;
    let result: Result<ApiEnvelope<Payload>, _> = serde_json::from_str(json);
    assert!(result.is_err());
}
```

- [ ] **Step 3.2: Run, see failure**

```bash
cargo test -p librovenue --test api_envelope_test
```
Expected: FAIL — `transport::api` missing.

- [ ] **Step 3.3: Create `packages/core-rs/src/transport/api.rs`**

```rust
use serde::Deserialize;

/// Every Rovenue server response is wrapped `{ "data": <…> }` (success)
/// or `{ "error": { "code": "…", "message": "…" } }` (failure mapped via
/// HTTP status by HttpClient).
#[derive(Debug, Deserialize)]
pub struct ApiEnvelope<T> {
    pub data: T,
}
```

- [ ] **Step 3.4: Re-export from transport::mod**

Edit `packages/core-rs/src/transport/mod.rs`. Add the line:

```rust
pub mod api;
```

Place it alphabetically among the existing module declarations.

- [ ] **Step 3.5: Verify**

```bash
cargo test -p librovenue --test api_envelope_test
```
Expected: 2 passed.

- [ ] **Step 3.6: Commit**

```bash
git add packages/core-rs/src/transport/api.rs packages/core-rs/src/transport/mod.rs packages/core-rs/tests/api_envelope_test.rs
git commit -m "feat(core-rs): ApiEnvelope<T> deser wrapper for { data: T } responses"
```

---

## Task 4: Cache schema v2 — entitlements columns + credit_balance

**Files:**
- Modify: `packages/core-rs/src/cache/schema.rs`
- Modify: `packages/core-rs/src/cache/entitlements.rs`
- Create: `packages/core-rs/src/cache/credits.rs`
- Modify: `packages/core-rs/src/cache/mod.rs`
- Create: `packages/core-rs/tests/cache_schema_v2_test.rs`
- Create: `packages/core-rs/tests/cache_credits_test.rs`
- Modify: `packages/core-rs/tests/cache_entitlements_test.rs`

The `entitlements` table changes columns to match the server contract (`store`, `product_identifier`, `expires_iso`). The legacy `expires_at_ms` column is preserved as a denormalized read column so callers don't have to parse ISO. A new `credit_balance` table holds a single row per `user_scope`.

- [ ] **Step 4.1: Write failing schema migration test**

Create `packages/core-rs/tests/cache_schema_v2_test.rs`:

```rust
use rovenue::cache::CacheStore;
use tempfile::tempdir;

#[test]
fn fresh_db_runs_v1_then_v2() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).expect("open fresh db");
    assert_eq!(store.schema_version().unwrap(), 2);
    assert!(store.has_table("credit_balance").unwrap());
}

#[test]
fn entitlements_v2_columns_present() {
    let store = CacheStore::open_in_memory().unwrap();
    let count: i64 = store
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entitlements') \
                 WHERE name IN ('store','product_identifier','expires_iso')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 3, "v2 columns store/product_identifier/expires_iso must exist");
}

#[test]
fn upgrades_v1_db_in_place() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");

    // Manually create a v1 db.
    {
        use rusqlite::Connection;
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(rovenue::cache::schema::MIGRATION_V1).unwrap();
    }

    let store = CacheStore::open(&path).expect("reopen + upgrade v1→v2");
    assert_eq!(store.schema_version().unwrap(), 2);
    assert!(store.has_table("credit_balance").unwrap());
}
```

- [ ] **Step 4.2: Run, see failure**

```bash
cargo test -p librovenue --test cache_schema_v2_test
```
Expected: FAIL — v2 not registered.

- [ ] **Step 4.3: Extend `packages/core-rs/src/cache/schema.rs`**

Replace the whole file with:

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

pub const MIGRATION_V2: &str = r#"
ALTER TABLE entitlements ADD COLUMN store TEXT NOT NULL DEFAULT '';
ALTER TABLE entitlements ADD COLUMN product_identifier TEXT NOT NULL DEFAULT '';
ALTER TABLE entitlements ADD COLUMN expires_iso TEXT;

CREATE TABLE credit_balance (
    user_scope TEXT PRIMARY KEY,
    balance INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

UPDATE schema_meta SET version = 2;
"#;

pub const MIGRATIONS: &[&str] = &[MIGRATION_V1, MIGRATION_V2];
pub const LATEST: u32 = 2;
```

- [ ] **Step 4.4: Update `EntitlementRow` to carry v2 columns**

Replace `packages/core-rs/src/cache/entitlements.rs`:

```rust
use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone, PartialEq)]
pub struct EntitlementRow {
    pub entitlement_id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    pub product_identifier: String,
    pub store: String,
    pub expires_iso: Option<String>,
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
                       (user_scope, entitlement_id, is_active, product_id,
                        expires_at_ms, updated_at_ms, store, product_identifier, expires_iso)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(user_scope, entitlement_id) DO UPDATE SET
                       is_active = excluded.is_active,
                       product_id = excluded.product_id,
                       expires_at_ms = excluded.expires_at_ms,
                       updated_at_ms = excluded.updated_at_ms,
                       store = excluded.store,
                       product_identifier = excluded.product_identifier,
                       expires_iso = excluded.expires_iso",
                )?;
                for r in rows {
                    stmt.execute(params![
                        user_scope,
                        r.entitlement_id,
                        r.is_active as i64,
                        r.product_id,
                        r.expires_at_ms.map(|v| v as i64),
                        r.updated_at_ms as i64,
                        r.store,
                        r.product_identifier,
                        r.expires_iso,
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
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms,
                        store, product_identifier, expires_iso
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
                    store: r.get(5)?,
                    product_identifier: r.get(6)?,
                    expires_iso: r.get(7)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list(&self, user_scope: &str) -> RovenueResult<Vec<EntitlementRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms,
                        store, product_identifier, expires_iso
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
                    store: r.get(5)?,
                    product_identifier: r.get(6)?,
                    expires_iso: r.get(7)?,
                });
            }
            Ok(out)
        })
    }
}
```

- [ ] **Step 4.5: Update existing entitlements test for new fields**

Edit `packages/core-rs/tests/cache_entitlements_test.rs`. Every `EntitlementRow { ... }` literal that doesn't yet specify `store`, `product_identifier`, `expires_iso` must be updated. Replace the file content with:

```rust
use rovenue::cache::CacheStore;
use rovenue::cache::entitlements::{EntitlementRow, EntitlementsRepo};
use rovenue::cache::etag::EtagRepo;

fn row(entitlement_id: &str) -> EntitlementRow {
    EntitlementRow {
        entitlement_id: entitlement_id.into(),
        is_active: true,
        product_id: Some("monthly".into()),
        product_identifier: "monthly".into(),
        store: "APP_STORE".into(),
        expires_iso: Some("2099-01-01T00:00:00Z".into()),
        expires_at_ms: Some(1_700_000_000_000),
        updated_at_ms: 1,
    }
}

#[test]
fn upsert_and_get_one() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    repo.upsert_many("user_42", &[row("pro")]).unwrap();
    let got = repo.get("user_42", "pro").unwrap().unwrap();
    assert!(got.is_active);
    assert_eq!(got.entitlement_id, "pro");
    assert_eq!(got.product_identifier, "monthly");
    assert_eq!(got.store, "APP_STORE");
}

#[test]
fn list_all_for_user_scope() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    repo.upsert_many("user_42", &[row("pro"), row("lifetime")]).unwrap();
    repo.upsert_many("other", &[row("pro")]).unwrap();
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

- [ ] **Step 4.6: Write credit balance repo test**

Create `packages/core-rs/tests/cache_credits_test.rs`:

```rust
use rovenue::cache::credits::{CreditBalanceRepo, CreditBalanceRow};
use rovenue::cache::CacheStore;

#[test]
fn empty_balance_is_none() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    assert!(repo.get("user_42").unwrap().is_none());
}

#[test]
fn upsert_and_read() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    repo.upsert(&CreditBalanceRow {
        user_scope: "user_42".into(),
        balance: 100,
        updated_at_ms: 1,
    })
    .unwrap();
    let got = repo.get("user_42").unwrap().unwrap();
    assert_eq!(got.balance, 100);

    repo.upsert(&CreditBalanceRow {
        user_scope: "user_42".into(),
        balance: 75,
        updated_at_ms: 2,
    })
    .unwrap();
    let got = repo.get("user_42").unwrap().unwrap();
    assert_eq!(got.balance, 75);
    assert_eq!(got.updated_at_ms, 2);
}

#[test]
fn scopes_are_isolated() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    repo.upsert(&CreditBalanceRow { user_scope: "a".into(), balance: 5, updated_at_ms: 1 }).unwrap();
    repo.upsert(&CreditBalanceRow { user_scope: "b".into(), balance: 9, updated_at_ms: 1 }).unwrap();
    assert_eq!(repo.get("a").unwrap().unwrap().balance, 5);
    assert_eq!(repo.get("b").unwrap().unwrap().balance, 9);
}
```

- [ ] **Step 4.7: Run, see failure**

```bash
cargo test -p librovenue --test cache_credits_test
```
Expected: FAIL — `cache::credits` missing.

- [ ] **Step 4.8: Create `packages/core-rs/src/cache/credits.rs`**

```rust
use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone, PartialEq)]
pub struct CreditBalanceRow {
    pub user_scope: String,
    pub balance: i64,
    pub updated_at_ms: u64,
}

pub struct CreditBalanceRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> CreditBalanceRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, user_scope: &str) -> RovenueResult<Option<CreditBalanceRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT user_scope, balance, updated_at_ms FROM credit_balance WHERE user_scope = ?1",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            if let Some(r) = rows.next()? {
                Ok(Some(CreditBalanceRow {
                    user_scope: r.get(0)?,
                    balance: r.get(1)?,
                    updated_at_ms: r.get::<_, i64>(2)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn upsert(&self, row: &CreditBalanceRow) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO credit_balance (user_scope, balance, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(user_scope) DO UPDATE SET
                   balance = excluded.balance,
                   updated_at_ms = excluded.updated_at_ms",
                params![row.user_scope, row.balance, row.updated_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
```

- [ ] **Step 4.9: Add module to cache::mod**

Edit `packages/core-rs/src/cache/mod.rs`. Add `pub mod credits;` alphabetically among the existing module declarations.

- [ ] **Step 4.10: Verify**

```bash
cargo test -p librovenue --test cache_schema_v2_test \
  --test cache_credits_test --test cache_entitlements_test \
  --test cache_migration_test --test cache_identity_test
```
Expected: all green.

```bash
cargo test -p librovenue
```
Expected: existing v1-shape tests in `entitlement_read_test.rs` may now fail because the wire mapper still produces v1-shape rows — those are fixed in Task 5.

If `entitlement_read_test.rs` fails here, that is expected — proceed to the next task without committing yet. Otherwise commit:

- [ ] **Step 4.11: Commit (only if all tests pass; otherwise defer commit to end of Task 5)**

```bash
git add packages/core-rs/src/cache packages/core-rs/tests/cache_schema_v2_test.rs packages/core-rs/tests/cache_credits_test.rs packages/core-rs/tests/cache_entitlements_test.rs
git commit -m "feat(core-rs): cache schema v2 — entitlement columns + credit_balance table"
```

---

## Task 5: Entitlement wire model rewrite (map shape + envelope)

**Files:**
- Modify: `packages/core-rs/src/entitlements/types.rs`
- Modify: `packages/core-rs/src/entitlements/api.rs`
- Modify: `packages/core-rs/src/entitlements/reader.rs`
- Modify: `packages/core-rs/tests/entitlement_read_test.rs`
- Modify: `packages/core-rs/tests/fixtures/entitlements_response.json`

The M1 wire model expected `entitlements: [{ id, is_active, product_id, expires_at_ms }]`. The server actually returns `entitlements: { "<key>": { isActive, expiresDate, store, productIdentifier } }` under a `data` envelope. This task rewrites the deser path.

- [ ] **Step 5.1: Replace `packages/core-rs/tests/fixtures/entitlements_response.json`**

```json
{
  "data": {
    "entitlements": {
      "pro": {
        "isActive": true,
        "expiresDate": "2030-01-01T00:00:00.000Z",
        "store": "APP_STORE",
        "productIdentifier": "monthly"
      },
      "lifetime": {
        "isActive": false,
        "expiresDate": null,
        "store": "PLAY_STORE",
        "productIdentifier": "lifetime_v1"
      }
    }
  }
}
```

- [ ] **Step 5.2: Update `entitlement_read_test.rs` assertions for new fields**

Edit `packages/core-rs/tests/entitlement_read_test.rs`. Replace the body assertions in `refresh_populates_cache_and_emits_observer` with:

```rust
    let pro = reader.get("pro").unwrap().unwrap();
    assert!(pro.is_active);
    assert_eq!(pro.product_identifier, "monthly");
    assert_eq!(pro.store, "APP_STORE");
    assert_eq!(pro.expires_iso.as_deref(), Some("2030-01-01T00:00:00.000Z"));
```

Leave the `second_refresh_sends_if_none_match_and_is_no_op_on_304` test untouched (the server doesn't emit ETag in production, but mockito-supplied ETag still drives the cache-hit branch correctly — keeps the SDK's ETag plumbing exercised for future endpoints).

The `Entitlement` FFI struct gains the new fields in Task 6's UDL update; for now this test is updated only after Task 6 too. Skip the field-rename in this step if it's going to compile-fail; the editor will tell you.

- [ ] **Step 5.3: Replace `packages/core-rs/src/entitlements/types.rs`**

```rust
use serde::Deserialize;

/// FFI-visible entitlement projection.
#[derive(Debug, Clone, PartialEq)]
pub struct Entitlement {
    pub id: String,
    pub is_active: bool,
    pub product_identifier: String,
    pub store: String,
    pub expires_iso: Option<String>,
}

/// Wire model: server returns `{ data: { entitlements: { "<key>": EntitlementWire } } }`.
#[derive(Debug, Deserialize)]
pub struct EntitlementWire {
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "expiresDate")]
    pub expires_date: Option<String>,
    pub store: String,
    #[serde(rename = "productIdentifier")]
    pub product_identifier: String,
}

#[derive(Debug, Deserialize)]
pub struct EntitlementsResponse {
    pub entitlements: std::collections::HashMap<String, EntitlementWire>,
}
```

- [ ] **Step 5.4: Replace `packages/core-rs/src/entitlements/api.rs`**

```rust
use std::collections::HashMap;

use crate::cache::entitlements::EntitlementRow;

use super::types::EntitlementWire;

pub fn map_to_rows(map: HashMap<String, EntitlementWire>, updated_at_ms: u64) -> Vec<EntitlementRow> {
    map.into_iter()
        .map(|(key, w)| EntitlementRow {
            entitlement_id: key,
            is_active: w.is_active,
            product_id: Some(w.product_identifier.clone()),
            product_identifier: w.product_identifier,
            store: w.store,
            expires_iso: w.expires_date.clone(),
            // Parse ISO into ms for denorm; failure → None.
            expires_at_ms: w.expires_date.as_deref().and_then(parse_iso_to_ms),
            updated_at_ms,
        })
        .collect()
}

fn parse_iso_to_ms(iso: &str) -> Option<u64> {
    // Minimal parser: server emits RFC3339 ms-precision (`YYYY-MM-DDTHH:MM:SS.sssZ`).
    // We only need a best-effort conversion for legacy callers; on parse failure return None.
    let primitive = iso.strip_suffix('Z').or(Some(iso))?;
    let mut parts = primitive.splitn(2, 'T');
    let date = parts.next()?;
    let time = parts.next()?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let m: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let (hms, ms_frac) = match time.split_once('.') {
        Some((a, b)) => (a, b.trim_end_matches('Z')),
        None => (time, "0"),
    };
    let mut t = hms.split(':');
    let h: u32 = t.next()?.parse().ok()?;
    let mn: u32 = t.next()?.parse().ok()?;
    let s: u32 = t.next()?.parse().ok()?;
    let ms: u64 = ms_frac.chars().take(3).collect::<String>().parse().unwrap_or(0);

    // Days from civil (Howard Hinnant's date algorithm).
    let yy = if m <= 2 { y - 1 } else { y };
    let era = (if yy >= 0 { yy } else { yy - 399 }) / 400;
    let yoe = (yy - era * 400) as u64;
    let mp = if m > 2 { m as u64 - 3 } else { m as u64 + 9 };
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era as i64 * 146_097 + doe as i64 - 719_468;
    let secs = days_since_epoch * 86_400 + (h as i64) * 3600 + (mn as i64) * 60 + s as i64;
    if secs < 0 {
        return None;
    }
    Some((secs as u64) * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_z_iso_to_ms() {
        let ms = parse_iso_to_ms("2030-01-01T00:00:00.000Z").unwrap();
        // 2030-01-01T00:00:00Z = 1893456000 sec.
        assert_eq!(ms, 1_893_456_000_000);
    }

    #[test]
    fn parses_without_fraction() {
        let ms = parse_iso_to_ms("2030-01-01T00:00:00Z").unwrap();
        assert_eq!(ms, 1_893_456_000_000);
    }
}
```

- [ ] **Step 5.5: Update `packages/core-rs/src/entitlements/reader.rs`**

Replace the file with:

```rust
use std::sync::Arc;

use crate::cache::entitlements::EntitlementsRepo;
use crate::cache::etag::EtagRepo;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::api::map_to_rows;
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

    pub fn with_http(mut self, http: Arc<HttpClient>) -> Self { self.http = Some(http); self }
    pub fn with_observer_bus(mut self, bus: Arc<ObserverBus>) -> Self { self.bus = Some(bus); self }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self { self.clock = Some(clock); self }

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

        let resp = http.get_json::<ApiEnvelope<EntitlementsResponse>>(req)?;

        if resp.status == 304 {
            return Ok(());
        }

        let body = resp.body.ok_or(RovenueError::Internal)?;
        let now = clock.now_unix_ms();
        let rows = map_to_rows(body.data.entitlements, now);
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
        product_identifier: r.product_identifier,
        store: r.store,
        expires_iso: r.expires_iso,
    }
}
```

- [ ] **Step 5.6: Verify**

```bash
source $HOME/.cargo/env && cargo test -p librovenue --test entitlement_read_test
```
Expected: 2 passed.

```bash
cargo test -p librovenue
```
Expected: full suite green (everything compatible now).

- [ ] **Step 5.7: Commit (combining Tasks 4 + 5 if Task 4 didn't commit)**

```bash
git add packages/core-rs/src/cache packages/core-rs/src/entitlements packages/core-rs/tests packages/core-rs/tests/fixtures
git commit -m "feat(core-rs): cache schema v2 + entitlement map+envelope wire model"
```

---

## Task 6: Update FFI `Entitlement` + UDL + smoke test for new fields

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/tests/integration_smoke.rs`

The UDL `dictionary Entitlement` currently has `id, is_active, product_id, expires_at_ms`. Rename to match the new Rust struct.

- [ ] **Step 6.1: Edit UDL**

Edit `packages/core-rs/src/librovenue.udl`. Replace the `dictionary Entitlement { … }` block with:

```
dictionary Entitlement {
    string id;
    boolean is_active;
    string product_identifier;
    string store;
    string? expires_iso;
};
```

- [ ] **Step 6.2: Verify rust build is still clean**

```bash
source $HOME/.cargo/env && cargo build -p librovenue
```
Expected: clean. (`include_scaffolding!` will regenerate at compile.)

- [ ] **Step 6.3: Update smoke test reference if any**

```bash
grep -n 'product_id\|expires_at_ms' packages/core-rs/tests/integration_smoke.rs
```
If any line in `integration_smoke.rs` reads from the old fields, update it. (M1 smoke didn't read these fields specifically — likely no change.)

- [ ] **Step 6.4: Verify full suite**

```bash
cargo test -p librovenue
```
Expected: all green.

- [ ] **Step 6.5: Commit**

```bash
git add packages/core-rs/src/librovenue.udl packages/core-rs/tests/integration_smoke.rs
git commit -m "feat(core-rs): Entitlement FFI carries store + product_identifier + expires_iso"
```

---

## Task 7: 429 Retry-After full honoring within budget

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs`
- Modify: `packages/core-rs/src/transport/retry.rs`
- Modify: `packages/core-rs/tests/http_client_test.rs`

M1 surfaces a single 429 as `RateLimited` without honoring the wait. M2 waits up to `Retry-After` (capped at 30s) and retries within the budget. If the budget is exhausted, still surfaces `RateLimited`.

- [ ] **Step 7.1: Add a retry-after upper bound constant**

Edit `packages/core-rs/src/transport/retry.rs`. Add at the top:

```rust
/// We never wait more than this on a server-driven Retry-After.
/// Beyond this the client should fail open with RateLimited.
pub const RETRY_AFTER_MAX: Duration = Duration::from_secs(30);
```

- [ ] **Step 7.2: Update test for new behavior**

Edit `packages/core-rs/tests/http_client_test.rs`. Replace the `rate_limit_returns_rate_limited_error` test with:

```rust
#[test]
fn rate_limited_then_success_within_budget() {
    let mut server = mockito::Server::new();
    let m1 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "0")
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
fn rate_limited_exceeds_max_wait_surfaces_error() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "120") // 120s > RETRY_AFTER_MAX (30s) → don't wait, fail
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3);
    let err = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::RateLimited));
    m.assert();
}

#[test]
fn rate_limited_budget_exhausted_surfaces_error() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "0")
        .expect(2) // 2 attempts, both rate-limited
        .create();

    let c = client(&server.url()).with_max_attempts(2).with_min_backoff(Duration::from_millis(1));
    let err = c
        .get_json::<DummyEntitlements>(HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"))
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::RateLimited));
    m.assert();
}
```

- [ ] **Step 7.3: Run, see failure (only the new ones)**

```bash
cargo test -p librovenue --test http_client_test
```
Expected: 4 of the 5 prior tests pass; the 3 new ones fail because M1's `RetryAfter` branch returns immediately.

- [ ] **Step 7.4: Update HttpClient retry loop**

Edit `packages/core-rs/src/transport/http_client.rs`. Replace the `RetryDecision::RetryAfter(_)` arm with:

```rust
                        RetryDecision::RetryAfter(d) => {
                            use super::retry::RETRY_AFTER_MAX;
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited);
                            }
                            last_err = RovenueError::RateLimited;
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
```

- [ ] **Step 7.5: Verify**

```bash
cargo test -p librovenue --test http_client_test
```
Expected: 7 passed (5 prior + 2 new — `rate_limited_then_success_within_budget`, `rate_limited_exceeds_max_wait_surfaces_error`, `rate_limited_budget_exhausted_surfaces_error` replace the M1 single test).

Adjust expected count if your local copy still has the old test name — count what actually runs.

- [ ] **Step 7.6: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs packages/core-rs/src/transport/retry.rs packages/core-rs/tests/http_client_test.rs
git commit -m "feat(core-rs): honor Retry-After within budget, cap at 30s"
```

---

## Task 8: Idempotency-Key generator

**Files:**
- Create: `packages/core-rs/src/transport/idempotency.rs`
- Modify: `packages/core-rs/src/transport/mod.rs`
- Create: `packages/core-rs/tests/idempotency_test.rs`

- [ ] **Step 8.1: Write failing test**

Create `packages/core-rs/tests/idempotency_test.rs`:

```rust
use rovenue::transport::idempotency::IdempotencyKey;

#[test]
fn new_key_has_prefix_and_is_unique() {
    let k1 = IdempotencyKey::new();
    let k2 = IdempotencyKey::new();
    assert!(k1.as_str().starts_with("idem_"));
    assert_ne!(k1.as_str(), k2.as_str());
}

#[test]
fn clone_keeps_the_same_string() {
    let k = IdempotencyKey::new();
    let s1 = k.as_str().to_owned();
    let cloned = k.clone();
    assert_eq!(cloned.as_str(), s1);
}

#[test]
fn key_under_255_chars() {
    let k = IdempotencyKey::new();
    assert!(k.as_str().len() <= 255, "server rejects keys > 255 chars");
}
```

- [ ] **Step 8.2: Run, see failure**

```bash
cargo test -p librovenue --test idempotency_test
```
Expected: FAIL.

- [ ] **Step 8.3: Create `packages/core-rs/src/transport/idempotency.rs`**

```rust
/// An opaque key the SDK attaches via the `Idempotency-Key` header.
/// Reused across all retry attempts of the same logical call — that's how
/// the server's 24h dedup window discriminates "this is a retry" from
/// "this is a new request."
#[derive(Debug, Clone)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new() -> Self {
        Self(format!("idem_{}", cuid2::create_id()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for IdempotencyKey {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 8.4: Wire into transport::mod**

Edit `packages/core-rs/src/transport/mod.rs`. Add `pub mod idempotency;` alphabetically.

- [ ] **Step 8.5: Verify**

```bash
cargo test -p librovenue --test idempotency_test
```
Expected: 3 passed.

- [ ] **Step 8.6: Commit**

```bash
git add packages/core-rs/src/transport/idempotency.rs packages/core-rs/src/transport/mod.rs packages/core-rs/tests/idempotency_test.rs
git commit -m "feat(core-rs): IdempotencyKey generator (cuid2 backed)"
```

---

## Task 9: HttpClient.post_json with Idempotency-Key

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs`
- Modify: `packages/core-rs/src/transport/types.rs`
- Create: `packages/core-rs/tests/post_json_test.rs`

`post_json` adds a `B: Serialize` request body and the `Idempotency-Key` header. Retries reuse the key. 422 (idempotency key conflict) maps to `Internal` (programmer error — caller used same key for different payload).

- [ ] **Step 9.1: Extend `HttpRequest` for POST**

Edit `packages/core-rs/src/transport/types.rs`. Append:

```rust
pub struct HttpPostRequest<'a> {
    pub path: &'a str,
    pub user_scope: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

impl<'a> HttpPostRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self { path, user_scope: None, idempotency_key: None }
    }
    pub fn user_scope(mut self, scope: &'a str) -> Self { self.user_scope = Some(scope); self }
    pub fn idempotency_key(mut self, key: &'a str) -> Self { self.idempotency_key = Some(key); self }
}
```

- [ ] **Step 9.2: Write failing test**

Create `packages/core-rs/tests/post_json_test.rs`:

```rust
use std::time::Duration;

use rovenue::transport::http_client::HttpClient;
use rovenue::transport::types::HttpPostRequest;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct Body { amount: u32 }

#[derive(Debug, Deserialize, PartialEq)]
struct Response { data: BodyOut }

#[derive(Debug, Deserialize, PartialEq)]
struct BodyOut { balance: u32 }

fn client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test_abc".into())
        .with_max_attempts(2)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn post_json_sends_idempotency_key_and_body() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("authorization", "Bearer pk_test_abc")
        .match_header("x-rovenue-app-user-id", "anon_42")
        .match_header("idempotency-key", "idem_test_123")
        .match_header("content-type", "application/json")
        .match_body(r#"{"amount":10}"#)
        .with_status(200)
        .with_body(r#"{"data":{"balance":90}}"#)
        .create();

    let c = client(&server.url());
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_test_123"),
            &Body { amount: 10 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body.unwrap().data.balance, 90);
    m.assert();
}

#[test]
fn post_json_idempotent_replay_header_observed() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", "idem_test_xyz")
        .with_status(200)
        .with_header("Idempotent-Replay", "true")
        .with_body(r#"{"data":{"balance":50}}"#)
        .create();

    let c = client(&server.url());
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_test_xyz"),
            &Body { amount: 5 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m.assert();
}

#[test]
fn post_json_422_idempotency_conflict_maps_to_internal() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .with_status(422)
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3);
    let err = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_conflict"),
            &Body { amount: 5 },
        )
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::Internal));
    m.assert();
}

#[test]
fn post_json_retries_reuse_same_idempotency_key() {
    let mut server = mockito::Server::new();
    // First attempt: 503. Second attempt: 200. Both must carry the same key.
    let key = "idem_reuse_test";
    let m1 = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", key)
        .with_status(503)
        .expect(1)
        .create();
    let m2 = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", key)
        .with_status(200)
        .with_body(r#"{"data":{"balance":42}}"#)
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3).with_min_backoff(Duration::from_millis(1));
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key(key),
            &Body { amount: 5 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m1.assert();
    m2.assert();
}
```

- [ ] **Step 9.3: Run, see failure**

```bash
cargo test -p librovenue --test post_json_test
```
Expected: FAIL — `post_json` does not exist.

- [ ] **Step 9.4: Implement post_json**

Edit `packages/core-rs/src/transport/http_client.rs`. Add the method below `get_json`. First add the import at the top:

```rust
use serde::Serialize;
```

Then add the method inside `impl HttpClient`:

```rust
    pub fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        req: super::types::HttpPostRequest<'_>,
        body: &B,
    ) -> RovenueResult<HttpResponse<T>> {
        use super::retry::{backoff, classify, RetryDecision, RETRY_AFTER_MAX};

        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable;

        let payload =
            serde_json::to_vec(body).map_err(|_| RovenueError::Internal)?;

        for attempt in 0..self.max_attempts {
            let mut builder = self
                .inner
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json");
            if let Some(scope) = req.user_scope {
                builder = builder.header("X-Rovenue-App-User-Id", scope);
            }
            if let Some(key) = req.idempotency_key {
                builder = builder.header("Idempotency-Key", key);
            }
            // Each attempt sends the same payload bytes (reusing payload Vec).
            let req_built = builder.body(payload.clone());

            match req_built.send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs);

                    // 422 = idempotency-key conflict (different body for same key).
                    if status == 422 {
                        return Err(RovenueError::Internal);
                    }
                    // 402 = InsufficientCredits (only used by /me/credits/spend, but harmless to surface).
                    if status == 402 {
                        return Err(RovenueError::InsufficientCredits);
                    }

                    match classify(Some(status), retry_after) {
                        RetryDecision::Success => {
                            let body = if status == 204 {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal)?)
                            };
                            return Ok(HttpResponse { status, etag: None, body });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError
                            } else {
                                RovenueError::NetworkUnavailable
                            };
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(d) => {
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited);
                            }
                            last_err = RovenueError::RateLimited;
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
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
```

- [ ] **Step 9.5: Verify**

```bash
cargo test -p librovenue --test post_json_test
```
Expected: 4 passed.

- [ ] **Step 9.6: Commit**

```bash
git add packages/core-rs/src/transport packages/core-rs/tests/post_json_test.rs
git commit -m "feat(core-rs): HttpClient.post_json with Idempotency-Key + 402/422 mapping"
```

---

## Task 10: ReceiptClient module — types

**Files:**
- Create: `packages/core-rs/src/receipts/mod.rs`
- Create: `packages/core-rs/src/receipts/types.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 10.1: Create `packages/core-rs/src/receipts/types.rs`**

```rust
use serde::{Deserialize, Serialize};

/// Body of POST /v1/receipts/{apple|google}.
#[derive(Debug, Serialize)]
pub struct ReceiptBody<'a> {
    pub receipt: &'a str,
    #[serde(rename = "appUserId")]
    pub app_user_id: &'a str,
    #[serde(rename = "productId")]
    pub product_id: &'a str,
}

/// Wire model for the receipt response body (inside the `data` envelope).
#[derive(Debug, Deserialize)]
pub struct ReceiptResponse {
    pub subscriber: ReceiptSubscriber,
    pub credits: ReceiptCredits,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptSubscriber {
    pub id: String,
    #[serde(rename = "appUserId")]
    pub app_user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptCredits {
    pub balance: i64,
}

/// FFI-visible projection. `access` from the server is dropped here —
/// the caller should call `entitlements_all()` to read the cache; we
/// refresh entitlements + emit observer instead of duplicating the
/// access map onto the receipt response struct.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
}
```

- [ ] **Step 10.2: Module root**

Create `packages/core-rs/src/receipts/mod.rs`:

```rust
pub mod client;
pub mod types;

pub use client::ReceiptClient;
pub use types::ReceiptResult;
```

(Note: `client` will be added in Task 11; for now this `mod.rs` may not compile until that file exists. Defer this `mod.rs` write until Task 11 if you'd rather batch.)

To keep this task self-contained, instead write a temporary `mod.rs` that exposes only `types`:

```rust
pub mod types;

pub use types::ReceiptResult;
```

Add `pub mod receipts;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 10.3: Verify build**

```bash
cargo build -p librovenue
```
Expected: clean.

- [ ] **Step 10.4: Commit**

```bash
git add packages/core-rs/src/receipts packages/core-rs/src/lib.rs
git commit -m "feat(core-rs): receipt wire types + ReceiptResult projection"
```

---

## Task 11: ReceiptClient — post_apple + post_google

**Files:**
- Create: `packages/core-rs/src/receipts/client.rs`
- Modify: `packages/core-rs/src/receipts/mod.rs`
- Create: `packages/core-rs/tests/receipt_apple_test.rs`
- Create: `packages/core-rs/tests/receipt_google_test.rs`

- [ ] **Step 11.1: Write failing test (Apple)**

Create `packages/core-rs/tests/receipt_apple_test.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;

use rovenue::receipts::ReceiptClient;
use rovenue::transport::http_client::HttpClient;

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

#[test]
fn post_apple_success() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/apple")
        .match_header("authorization", "Bearer pk_test")
        .match_header("x-rovenue-app-user-id", "anon_99")
        .match_header("idempotency-key", "idem_apple_001")
        .match_body(r#"{"receipt":"<jws>","appUserId":"anon_99","productId":"pro_monthly"}"#)
        .with_status(200)
        .with_body(r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"anon_99"},"access":{},"credits":{"balance":120}}}"#)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let result = c
        .post_apple("<jws>", "anon_99", "pro_monthly", "idem_apple_001")
        .unwrap();
    assert_eq!(result.subscriber_id, "sub_1");
    assert_eq!(result.app_user_id, "anon_99");
    assert_eq!(result.credit_balance, 120);
    m.assert();
}

#[test]
fn post_apple_403_is_fatal() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/apple")
        .with_status(403)
        .expect(1)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let err = c.post_apple("<jws>", "anon_99", "pro", "idem_x").unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::ServerError));
    m.assert();
}
```

- [ ] **Step 11.2: Write failing test (Google)**

Create `packages/core-rs/tests/receipt_google_test.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;

use rovenue::receipts::ReceiptClient;
use rovenue::transport::http_client::HttpClient;

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

#[test]
fn post_google_success() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/google")
        .match_header("authorization", "Bearer pk_test")
        .match_header("x-rovenue-app-user-id", "anon_99")
        .match_header("idempotency-key", "idem_google_001")
        .match_body(r#"{"receipt":"play.purchase.token","appUserId":"anon_99","productId":"pro_monthly_v2"}"#)
        .with_status(200)
        .with_body(r#"{"data":{"subscriber":{"id":"sub_2","appUserId":"anon_99"},"access":{},"credits":{"balance":0}}}"#)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let result = c
        .post_google("play.purchase.token", "anon_99", "pro_monthly_v2", "idem_google_001")
        .unwrap();
    assert_eq!(result.subscriber_id, "sub_2");
    assert_eq!(result.credit_balance, 0);
    m.assert();
}
```

- [ ] **Step 11.3: Run, see failure**

```bash
cargo test -p librovenue --test receipt_apple_test --test receipt_google_test
```
Expected: FAIL — `ReceiptClient` missing.

- [ ] **Step 11.4: Create `packages/core-rs/src/receipts/client.rs`**

```rust
use std::sync::Arc;

use crate::error::RovenueResult;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::types::{ReceiptBody, ReceiptResponse, ReceiptResult};

pub struct ReceiptClient {
    http: Arc<HttpClient>,
}

impl ReceiptClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    pub fn post_apple(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> RovenueResult<ReceiptResult> {
        self.post("/v1/receipts/apple", receipt, app_user_id, product_id, idempotency_key)
    }

    pub fn post_google(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> RovenueResult<ReceiptResult> {
        self.post("/v1/receipts/google", receipt, app_user_id, product_id, idempotency_key)
    }

    fn post(
        &self,
        path: &str,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> RovenueResult<ReceiptResult> {
        let body = ReceiptBody { receipt, app_user_id, product_id };
        let resp = self.http.post_json::<ReceiptBody, ApiEnvelope<ReceiptResponse>>(
            HttpPostRequest::new(path)
                .user_scope(app_user_id)
                .idempotency_key(idempotency_key),
            &body,
        )?;
        let body = resp.body.ok_or(crate::error::RovenueError::Internal)?.data;
        Ok(ReceiptResult {
            subscriber_id: body.subscriber.id,
            app_user_id: body.subscriber.app_user_id,
            credit_balance: body.credits.balance,
        })
    }
}
```

- [ ] **Step 11.5: Update `packages/core-rs/src/receipts/mod.rs`**

```rust
pub mod client;
pub mod types;

pub use client::ReceiptClient;
pub use types::ReceiptResult;
```

- [ ] **Step 11.6: Verify**

```bash
cargo test -p librovenue --test receipt_apple_test --test receipt_google_test
```
Expected: 3 passed.

- [ ] **Step 11.7: Commit**

```bash
git add packages/core-rs/src/receipts packages/core-rs/tests/receipt_apple_test.rs packages/core-rs/tests/receipt_google_test.rs
git commit -m "feat(core-rs): ReceiptClient.post_apple + post_google with idempotency"
```

---

## Task 12: CreditReader — cache + refresh + consume

**Files:**
- Create: `packages/core-rs/src/credits/mod.rs`
- Create: `packages/core-rs/src/credits/types.rs`
- Create: `packages/core-rs/src/credits/reader.rs`
- Modify: `packages/core-rs/src/lib.rs`
- Modify: `packages/core-rs/src/observer.rs`
- Create: `packages/core-rs/tests/credits_test.rs`

- [ ] **Step 12.1: Add `CreditBalanceChanged` ChangeEvent variant**

Edit `packages/core-rs/src/observer.rs`. Replace the `ChangeEvent` enum with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    EntitlementsChanged,
    IdentityChanged,
    CreditBalanceChanged,
}
```

- [ ] **Step 12.2: Write failing tests**

Create `packages/core-rs/tests/credits_test.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::credits::CreditReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) { self.0.lock().unwrap().push(e); }
}

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

fn fixture() -> (Arc<CacheStore>, Arc<ObserverBus>, Arc<Capture>, Arc<IdentityManager>) {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    (store, bus, cap, identity)
}

#[test]
fn refresh_populates_balance_and_emits_observer() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/credits")
        .with_status(200)
        .with_body(r#"{"data":{"balance":42}}"#)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    assert_eq!(reader.balance().unwrap(), 0); // empty cache returns 0

    reader.refresh().unwrap();
    assert_eq!(reader.balance().unwrap(), 42);

    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::CreditBalanceChanged));
    m.assert();
}

#[test]
fn refresh_no_change_when_balance_same() {
    let mut server = mockito::Server::new();
    let first = server
        .mock("GET", "/v1/me/credits")
        .with_status(200)
        .with_body(r#"{"data":{"balance":7}}"#)
        .expect(2)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    reader.refresh().unwrap();
    let count_after_first = cap.0.lock().unwrap().iter()
        .filter(|e| **e == ChangeEvent::CreditBalanceChanged)
        .count();

    reader.refresh().unwrap();
    let count_after_second = cap.0.lock().unwrap().iter()
        .filter(|e| **e == ChangeEvent::CreditBalanceChanged)
        .count();
    assert_eq!(count_after_first, count_after_second, "unchanged balance must not re-emit");
    first.assert();
}

#[test]
fn consume_decrements_balance_and_emits() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", "idem_spend_1")
        .match_body(r#"{"amount":10}"#)
        .with_status(200)
        .with_body(r#"{"data":{"balance":40,"ledgerEntry":{"id":"le_1","amount":-10,"balance":40,"type":"spend","createdAt":"2030-01-01T00:00:00.000Z"}}}"#)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    let new_balance = reader.consume(10, None, "idem_spend_1").unwrap();
    assert_eq!(new_balance, 40);
    assert_eq!(reader.balance().unwrap(), 40);
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::CreditBalanceChanged));
    m.assert();
}

#[test]
fn consume_402_returns_insufficient_credits() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .with_status(402)
        .with_body(r#"{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient credits: 5 available, 10 requested"}}"#)
        .create();

    let (store, _bus, _cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::new(rovenue::observer::ObserverBus::default()))
        .with_clock(Arc::new(SystemClock));

    let err = reader.consume(10, None, "idem_spend_fail").unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::InsufficientCredits));
    m.assert();
}
```

- [ ] **Step 12.3: Run, see failure**

```bash
cargo test -p librovenue --test credits_test
```
Expected: FAIL — `credits` module missing.

- [ ] **Step 12.4: Create `packages/core-rs/src/credits/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct CreditBalance {
    pub balance: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreditBalanceWire {
    pub balance: i64,
}

#[derive(Debug, Serialize)]
pub struct SpendBody<'a> {
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct SpendResponse {
    pub balance: i64,
}
```

- [ ] **Step 12.5: Create `packages/core-rs/src/credits/reader.rs`**

```rust
use std::sync::Arc;

use crate::cache::credits::{CreditBalanceRepo, CreditBalanceRow};
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::{HttpPostRequest, HttpRequest};

use super::types::{CreditBalanceWire, SpendBody, SpendResponse};

pub struct CreditReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
}

impl CreditReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self { store, identity, http: None, bus: None, clock: None }
    }
    pub fn with_http(mut self, http: Arc<HttpClient>) -> Self { self.http = Some(http); self }
    pub fn with_observer_bus(mut self, bus: Arc<ObserverBus>) -> Self { self.bus = Some(bus); self }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self { self.clock = Some(clock); self }

    pub fn balance(&self) -> RovenueResult<i64> {
        let scope = self.identity.current_user_scope();
        let repo = CreditBalanceRepo::new(&self.store);
        Ok(repo.get(&scope)?.map(|r| r.balance).unwrap_or(0))
    }

    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;
        let scope = self.identity.current_user_scope();

        let resp = http.get_json::<ApiEnvelope<CreditBalanceWire>>(
            HttpRequest::new("/v1/me/credits").user_scope(&scope),
        )?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        self.store_and_emit(&scope, body.data.balance, clock.now_unix_ms())
    }

    pub fn consume(
        &self,
        amount: i64,
        description: Option<&str>,
        idempotency_key: &str,
    ) -> RovenueResult<i64> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;
        let scope = self.identity.current_user_scope();

        let resp = http.post_json::<SpendBody, ApiEnvelope<SpendResponse>>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope(&scope)
                .idempotency_key(idempotency_key),
            &SpendBody { amount, description },
        )?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        let new_balance = body.data.balance;
        self.store_and_emit(&scope, new_balance, clock.now_unix_ms())?;
        Ok(new_balance)
    }

    fn store_and_emit(&self, scope: &str, balance: i64, now: u64) -> RovenueResult<()> {
        let repo = CreditBalanceRepo::new(&self.store);
        let prior = repo.get(scope)?.map(|r| r.balance);
        repo.upsert(&CreditBalanceRow {
            user_scope: scope.to_string(),
            balance,
            updated_at_ms: now,
        })?;
        if prior != Some(balance) {
            if let Some(bus) = &self.bus {
                bus.emit(ChangeEvent::CreditBalanceChanged);
            }
        }
        Ok(())
    }
}
```

- [ ] **Step 12.6: Module root**

Create `packages/core-rs/src/credits/mod.rs`:

```rust
pub mod reader;
pub mod types;

pub use reader::CreditReader;
pub use types::CreditBalance;
```

Add `pub mod credits;` to `packages/core-rs/src/lib.rs`.

- [ ] **Step 12.7: Verify**

```bash
cargo test -p librovenue --test credits_test
```
Expected: 4 passed.

```bash
cargo test -p librovenue
```
Expected: full suite green.

- [ ] **Step 12.8: Commit**

```bash
git add packages/core-rs/src/credits packages/core-rs/src/observer.rs packages/core-rs/src/lib.rs packages/core-rs/tests/credits_test.rs
git commit -m "feat(core-rs): CreditReader — cache, refresh, consume, observer"
```

---

## Task 13: RovenueCore — wire receipt + credit FFI methods

**Files:**
- Modify: `packages/core-rs/src/api.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/tests/integration_smoke.rs`

The constructor now builds a `ReceiptClient` and a `CreditReader`, plus registers a 2nd polling tick for credits (60s interval; entitlements stay at 30s).

- [ ] **Step 13.1: Extend `RovenueCore` struct + constructor**

Edit `packages/core-rs/src/api.rs`. The `RovenueCore` struct gains two fields:

```rust
pub struct RovenueCore {
    _config: Arc<Config>,
    bus: Arc<ObserverBus>,
    identity: Arc<IdentityManager>,
    entitlements: Arc<EntitlementReader>,
    credits: Arc<CreditReader>,
    receipts: Arc<ReceiptClient>,
    scheduler: PollingScheduler,
}
```

Replace the `RovenueCore::new` body with:

```rust
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

        let entitlements = Arc::new(
            EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let credits = Arc::new(
            CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let receipts = Arc::new(ReceiptClient::new(Arc::clone(&http)));

        let scheduler = PollingScheduler::new();
        {
            let reader = Arc::clone(&entitlements);
            scheduler.register("entitlements", Duration::from_secs(30), move || {
                let _ = reader.refresh();
            });
        }
        {
            let reader = Arc::clone(&credits);
            scheduler.register("credits", Duration::from_secs(60), move || {
                let _ = reader.refresh();
            });
        }

        Ok(Self {
            _config: Arc::new(config),
            bus,
            identity,
            entitlements,
            credits,
            receipts,
            scheduler,
        })
    }
```

Update imports at the top of `api.rs`:

```rust
use crate::credits::CreditReader;
use crate::receipts::{ReceiptClient, ReceiptResult};
use crate::transport::idempotency::IdempotencyKey;
```

(Keep all existing imports.)

- [ ] **Step 13.2: Add the new public methods**

Add the following methods inside `impl RovenueCore`:

```rust
    pub fn credit_balance(&self) -> i64 {
        self.credits.balance().unwrap_or(0)
    }

    pub fn refresh_credits(&self) -> RovenueResult<()> {
        self.credits.refresh()
    }

    pub fn consume_credits(&self, amount: i64, description: Option<String>) -> RovenueResult<i64> {
        if amount <= 0 {
            return Err(RovenueError::Internal);
        }
        let key = IdempotencyKey::new();
        self.credits.consume(amount, description.as_deref(), key.as_str())
    }

    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_apple(&receipt, &scope, &product_id, key.as_str())?;
        // After a successful purchase the cache is stale.
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
    }

    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_google(&receipt, &scope, &product_id, key.as_str())?;
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
    }
```

- [ ] **Step 13.3: Update UDL**

Edit `packages/core-rs/src/librovenue.udl`. Add the new `ReceiptResult` dictionary and the new methods. Replace the `interface RovenueCore { … }` block with:

```
dictionary ReceiptResult {
    string subscriber_id;
    string app_user_id;
    i64 credit_balance;
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

    i64 credit_balance();

    [Throws=RovenueError]
    void refresh_credits();

    [Throws=RovenueError]
    i64 consume_credits(i64 amount, string? description);

    [Throws=RovenueError]
    ReceiptResult post_apple_receipt(string receipt, string product_id);

    [Throws=RovenueError]
    ReceiptResult post_google_receipt(string receipt, string product_id);

    void register_observer(Observer obs);
    void set_foreground(boolean foreground);
    void shutdown();
};
```

- [ ] **Step 13.4: Extend smoke tests**

Edit `packages/core-rs/tests/integration_smoke.rs`. Append (do not remove existing M1 tests):

```rust
#[test]
fn credit_balance_starts_zero() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new_for_test(cfg).unwrap();
    assert_eq!(core.credit_balance(), 0);
}

#[test]
fn consume_credits_rejects_zero_or_negative() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new_for_test(cfg).unwrap();
    assert!(matches!(
        core.consume_credits(0, None),
        Err(rovenue::RovenueError::Internal)
    ));
    assert!(matches!(
        core.consume_credits(-5, None),
        Err(rovenue::RovenueError::Internal)
    ));
}
```

The `new_for_test` constructor (added in M1 Task 14) creates the core against an in-memory cache. Verify it's still present; if it was inadvertently removed, re-add it as `pub(crate)` mirroring M1's pattern.

- [ ] **Step 13.5: Verify**

```bash
cargo test -p librovenue
```
Expected: full suite green.

- [ ] **Step 13.6: Commit**

```bash
git add packages/core-rs/src packages/core-rs/tests/integration_smoke.rs
git commit -m "feat(core-rs): RovenueCore — receipts + credits + idempotency FFI"
```

---

## Task 14: `set_foreground → refresh` end-to-end integration test

**Files:**
- Create: `packages/core-rs/tests/foreground_refresh_e2e_test.rs`

The deferred M1 test. We can't easily inject the server URL into `RovenueCore::new` (it uses `default_db_path` and live SystemClock), so this test exercises `EntitlementReader` + `PollingScheduler` directly, mirroring how `RovenueCore` wires them.

- [ ] **Step 14.1: Write the test**

Create `packages/core-rs/tests/foreground_refresh_e2e_test.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::entitlements::EntitlementReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::polling::PollingScheduler;
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;
use serial_test::serial;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) { self.0.lock().unwrap().push(e); }
}

#[test]
#[serial]
fn polling_refresh_fires_when_foreground() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"data":{"entitlements":{"pro":{"isActive":true,"expiresDate":null,"store":"APP_STORE","productIdentifier":"monthly"}}}}"#)
        .expect_at_least(1)
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
    let http = Arc::new(
        HttpClient::new(server.url(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    );
    let reader = Arc::new(
        EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
            .with_http(Arc::clone(&http))
            .with_observer_bus(Arc::clone(&bus))
            .with_clock(Arc::new(SystemClock)),
    );

    let scheduler = PollingScheduler::new();
    {
        let r = Arc::clone(&reader);
        scheduler.register("entitlements", Duration::from_millis(40), move || {
            let _ = r.refresh();
        });
    }
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(200));
    scheduler.shutdown();

    let events = cap.0.lock().unwrap().clone();
    assert!(
        events.iter().any(|e| *e == ChangeEvent::EntitlementsChanged),
        "polling tick must have emitted at least one EntitlementsChanged"
    );
    m.assert();
}

#[test]
#[serial]
fn polling_does_not_fire_in_background() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"data":{"entitlements":{}}}"#)
        .expect(0)
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let http = Arc::new(
        HttpClient::new(server.url(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    );
    let reader = Arc::new(
        EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
            .with_http(Arc::clone(&http))
            .with_observer_bus(Arc::clone(&bus))
            .with_clock(Arc::new(SystemClock)),
    );

    let scheduler = PollingScheduler::new();
    {
        let r = Arc::clone(&reader);
        scheduler.register("entitlements", Duration::from_millis(20), move || {
            let _ = r.refresh();
        });
    }
    // set_foreground(false) is the default; sleep, then assert no calls.
    std::thread::sleep(Duration::from_millis(80));
    scheduler.shutdown();
    m.assert();
}
```

- [ ] **Step 14.2: Verify**

```bash
cargo test -p librovenue --test foreground_refresh_e2e_test
```
Expected: 2 passed.

- [ ] **Step 14.3: Commit**

```bash
git add packages/core-rs/tests/foreground_refresh_e2e_test.rs
git commit -m "test(core-rs): set_foreground → polling → refresh end-to-end"
```

---

## Task 15: Regenerate UniFFI bindings + parity smoke

**Files:**
- (regenerates) Swift/Kotlin binding files
- Modify: `scripts/sdk-parity.sh`

- [ ] **Step 15.1: Run the bindgen script**

```bash
source $HOME/.cargo/env
./packages/core-rs/scripts/build-bindings.sh
```
Expected: `✓ bindings generated`.

- [ ] **Step 15.2: Verify Swift binding picks up new types**

```bash
grep -E '(struct ReceiptResult|func postAppleReceipt|func postGoogleReceipt|func creditBalance|func consumeCredits|enum ChangeEvent)' packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift | head -10
```
Expected: each one appears at least once.

- [ ] **Step 15.3: Verify Kotlin binding picks up new types**

```bash
grep -E '(data class ReceiptResult|postAppleReceipt|postGoogleReceipt|creditBalance|consumeCredits|enum class ChangeEvent)' packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt | head -10
```
Expected: each one appears.

- [ ] **Step 15.4: Extend `scripts/sdk-parity.sh`**

Edit `scripts/sdk-parity.sh`. Find the block that runs the M1 Rust test suite (added in M1 Task 17). Add the M2 suite names to the `--test` list:

```bash
cargo test -p librovenue --quiet \
    --test integration_smoke \
    --test entitlement_read_test \
    --test identity_test \
    --test polling_test \
    --test post_json_test \
    --test receipt_apple_test \
    --test receipt_google_test \
    --test credits_test \
    --test foreground_refresh_e2e_test \
    >/tmp/rovenue-rust-parity.log 2>&1
```

- [ ] **Step 15.5: Run parity script**

```bash
./scripts/sdk-parity.sh
```
Expected: exits 0.

- [ ] **Step 15.6: Commit**

```bash
git add scripts/sdk-parity.sh
git status --short
```

If any binding files changed (most are gitignored — only `.gitkeep` survives), stage them too. Then:

```bash
git commit -m "test(sdk): parity script exercises M2 rust suites"
```

If only `scripts/sdk-parity.sh` changed, that single commit covers Task 15.

---

## Task 16: Plan finalisation — fmt/clippy/test/parity

- [ ] **Step 16.1: Format check + fix**

```bash
source $HOME/.cargo/env && cargo fmt --all -- --check
```
If diffs reported, run `cargo fmt --all` and commit as `style(core-rs): cargo fmt after M2`. Match M1's pattern.

- [ ] **Step 16.2: Clippy**

```bash
cargo clippy -p librovenue --all-targets -- -D warnings
```
Expected: clean. If a lint fires, address it inline. The plan's code targets the exact lint level M1 passed under.

- [ ] **Step 16.3: Full test sweep**

```bash
cargo test --workspace --all-targets
```
Expected: every test passes.

- [ ] **Step 16.4: Parity script**

```bash
./scripts/sdk-parity.sh
```
Expected: exits 0.

- [ ] **Step 16.5: Summarise commits since main**

```bash
git log --oneline main..HEAD
```
Expected: 15–17 commits with `feat(core-rs):`, `fix(core-rs):`, `test(core-rs):`, `test(sdk):`, `style(core-rs):`.

- [ ] **Step 16.6: Hand-off**

After verification, ask the controller whether to:
1. Merge to main locally (no push)
2. Push + open PR
3. Leave the branch in the worktree for further iteration

---

## Self-Review Notes

**Spec coverage:**
- M2 receipt posting (Apple, Google) — Tasks 10, 11 land the SDK side; server endpoints already exist.
- Credits read + spend — Tasks 4, 12 land cache + reader + FFI; server `/me/credits` + `/me/credits/spend` already exist.
- Idempotency-Key — Tasks 8, 9 generator + middleware; server middleware already exists.
- 429 Retry-After full honoring — Task 7 (M1 deferred).
- M1 error-variant gaps (UserNotFound, InsufficientCredits, EntitlementInactive, DuplicatePurchase, ReceiptInvalid) — Task 1.
- M1 contract bugs (`X-Rovenue-App-User-Id` header, `{data: T}` envelope, entitlement map shape) — Tasks 2, 3, 4, 5, 6.
- `set_foreground → refresh` e2e test (M1 deferred) — Task 14.

**Out of scope (deferred):**
- Façade integration (Swift AsyncStream, Kotlin Flow, RN hooks) — separate plans.
- Stripe receipt POST — no server endpoint; Stripe is webhook-only.
- `restore_purchases`, `post_attributes` — façade / M3+.
- `/v1/subscribers/transfer` — customer backend's job, SDK identify() stays client-local.
- sqlcipher — M1.5+.
- Apple Root CA chain pinning — server side, M1 simplification stands.

**Placeholder scan:** No TBDs; every code block is complete.

**Type consistency:**
- `EntitlementRow { entitlement_id, is_active, product_id, product_identifier, store, expires_iso, expires_at_ms, updated_at_ms }` (Task 4) used identically in Tasks 5, 6.
- `Entitlement { id, is_active, product_identifier, store, expires_iso }` (Task 5) used in Task 6 UDL.
- `ReceiptResult { subscriber_id, app_user_id, credit_balance }` (Tasks 10, 11, 13) consistent across Rust + UDL.
- `ChangeEvent::{EntitlementsChanged, IdentityChanged, CreditBalanceChanged}` (Task 12) consistent everywhere.
- `IdempotencyKey::new() -> "idem_<cuid2>"` (Task 8) used identically in Task 13.
- `HttpPostRequest { path, user_scope, idempotency_key }` (Task 9) used in Tasks 11, 12.

**Cross-task dependencies:**
- Task 4 (schema v2) blocks Task 5 (wire model rewrite uses new `EntitlementRow` shape).
- Task 5 must commit together with Task 4 to keep tree green.
- Task 8 (key generator) blocks Task 9 (post_json uses key).
- Task 9 blocks Tasks 11 (receipt client uses post_json) and 12 (credit consume uses post_json).
- Task 12 (CreditReader + CreditBalanceChanged variant) blocks Task 13 (RovenueCore wires CreditReader + emits variant).
- Task 13 blocks Task 15 (bindings regen depends on UDL update).

**Known risks to surface to implementer:**
- The Rust toolchain is 1.88 (from M1). No further bump expected; M2 introduces no new deps.
- `parse_iso_to_ms` in Task 5 is a hand-rolled minimal parser; the embedded unit test in `api.rs` mod tests guards it. If the server ever switches to nanosecond precision or a different timezone offset, this will silently truncate — server is currently `.000Z` only.
- The polling thread interval for credits is `60s` (vs entitlements `30s`). If both happen to fire within the same tick window, the registrations run sequentially in the loop (one tick resolution apart). Both refreshes hit `/me/credits` and `/me/entitlements` respectively — different endpoints, no contention.
- After a successful receipt POST, Task 13 fires `entitlements.refresh()` + `credits.refresh()` synchronously (blocks the caller). Façade plans may want to wrap these in a background dispatch — out of scope here.

---

*End of plan.*
