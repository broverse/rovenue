# SDK Purchase Freshness & Round-Trip Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the SDK purchase path from 3 network round-trips to 1, eliminate the cold-resume entitlement/credit staleness window without ever blocking a read, and stop redundant receipt re-verification on re-posts.

**Architecture:** All changes are in the Rust core (`packages/core-rs`) plus a one-line FFI dictionary addition consumed by the Swift/Kotlin/RN façades. The receipt POST response (which already carries `access` + `credits.balance`) hydrates the SQLite cache directly instead of triggering two follow-up GETs; reads gain a stale-while-revalidate guard; receipt idempotency keys become deterministic.

**Tech Stack:** Rust, rusqlite (SQLite cache), uniffi (FFI), reqwest (HTTP), mockito + serial_test (tests).

**Spec:** `docs/superpowers/specs/2026-06-16-sdk-purchase-freshness-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core-rs/src/transport/idempotency.rs` | Idempotency key minting | Add deterministic `for_receipt` constructor (B) |
| `packages/core-rs/src/entitlements/types.rs` | Entitlement wire/FFI types | (read-only reference) |
| `packages/core-rs/src/receipts/types.rs` | Receipt wire + FFI types | Parse `access`; add `ReceiptPostOutcome`; `ReceiptResult.entitlements` (D) |
| `packages/core-rs/src/receipts/client.rs` | Receipt HTTP client | `post*` return `ReceiptPostOutcome` carrying `access` (D) |
| `packages/core-rs/src/entitlements/reader.rs` | Entitlement cache + refresh | `hydrate`, staleness fields, `maybe_refresh_async` (C/D) |
| `packages/core-rs/src/credits/reader.rs` | Credit cache + refresh | `set_balance`, staleness fields, `maybe_refresh_async` (C/D) |
| `packages/core-rs/src/polling/scheduler.rs` | Foreground polling | `reset_cadence` (C1) |
| `packages/core-rs/src/api.rs` | Core orchestration / FFI surface | clock field; rewrite `post_*_receipt`; wire reads + foreground (B/C/D) |
| `packages/core-rs/src/librovenue.udl` | FFI interface | `ReceiptResult.entitlements` sequence (D) |

---

## Task 1: Deterministic receipt idempotency key (B)

**Files:**
- Modify: `packages/core-rs/src/transport/idempotency.rs`
- Test: same file (`#[cfg(test)]` module)

- [ ] **Step 1: Write the failing test**

Append to `packages/core-rs/src/transport/idempotency.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn for_receipt_is_deterministic_and_scoped() {
        let a = IdempotencyKey::for_receipt("apple", "jws-token-xyz");
        let b = IdempotencyKey::for_receipt("apple", "jws-token-xyz");
        assert_eq!(a.as_str(), b.as_str(), "same input must yield same key");

        let diff_receipt = IdempotencyKey::for_receipt("apple", "jws-token-zzz");
        assert_ne!(a.as_str(), diff_receipt.as_str());

        let diff_store = IdempotencyKey::for_receipt("google", "jws-token-xyz");
        assert_ne!(a.as_str(), diff_store.as_str());

        assert!(a.as_str().starts_with("idem_rcpt_"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue for_receipt_is_deterministic_and_scoped`
Expected: FAIL — `no function or associated item named for_receipt`.

- [ ] **Step 3: Add the FNV-1a helper and constructor**

In `packages/core-rs/src/transport/idempotency.rs`, add a free function above `impl IdempotencyKey` and a new associated constructor inside the `impl`:

```rust
/// FNV-1a 64-bit. Dependency-free, deterministic across runs of the same binary.
/// Cryptographic strength is unnecessary: a collision only affects the server's
/// 24h response cache, and DB-level dedup guarantees correctness regardless.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}
```

Inside `impl IdempotencyKey`, add:

```rust
    /// Deterministic key for a receipt POST, derived from the store + receipt
    /// token. All posts of the same transaction (first send, reconcile re-post,
    /// StoreKit re-delivery) share one key, so the server replays its cached
    /// response within the 24h window instead of re-verifying with the store.
    pub fn for_receipt(store: &str, receipt: &str) -> Self {
        let mut input = String::with_capacity(store.len() + 1 + receipt.len());
        input.push_str(store);
        input.push(':');
        input.push_str(receipt);
        Self(format!("idem_rcpt_{:016x}", fnv1a_64(input.as_bytes())))
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue for_receipt_is_deterministic_and_scoped`
Expected: PASS.

- [ ] **Step 5: Use the deterministic key in `api.rs`**

In `packages/core-rs/src/api.rs`, in `post_apple_receipt` replace:

```rust
        let key = IdempotencyKey::new();
```

with:

```rust
        let key = IdempotencyKey::for_receipt("apple", &receipt);
```

In `post_google_receipt` replace the same `let key = IdempotencyKey::new();` line with:

```rust
        let key = IdempotencyKey::for_receipt("google", &receipt);
```

- [ ] **Step 6: Build to verify it compiles**

Run: `cargo build -p librovenue`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/transport/idempotency.rs packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): deterministic idempotency key for receipt posts"
```

---

## Task 2: Parse `access` from the receipt response (D)

**Files:**
- Modify: `packages/core-rs/src/receipts/types.rs`
- Modify: `packages/core-rs/src/receipts/client.rs`
- Test: `packages/core-rs/src/receipts/client.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Add `access` to the wire model and a new outcome struct**

In `packages/core-rs/src/receipts/types.rs`, update the imports at the top of the file:

```rust
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::entitlements::types::EntitlementWire;
```

Replace the `ReceiptResponse` struct with one that captures `access` (defaulting to
`None` when an older server omits it, distinct from a present-but-empty `{}`):

```rust
/// Wire model for the receipt response body (inside the `data` envelope).
#[derive(Debug, Deserialize)]
pub struct ReceiptResponse {
    pub subscriber: ReceiptSubscriber,
    pub credits: ReceiptCredits,
    /// Entitlement access map. `None` when the server omits the field entirely
    /// (pre-0.7 API); `Some({})` means the subscriber genuinely has none.
    #[serde(default)]
    pub access: Option<HashMap<String, EntitlementWire>>,
}
```

Add an internal (non-FFI) outcome struct below `ReceiptCredits`:

```rust
/// Internal result of a receipt POST, carrying the raw access map so the core
/// can hydrate the cache without a follow-up GET. Not exposed across FFI.
#[derive(Debug)]
pub struct ReceiptPostOutcome {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
    pub access: Option<HashMap<String, EntitlementWire>>,
}
```

Leave `ReceiptResult` as-is for now (Task 3 extends it).

- [ ] **Step 2: Write the failing test for client parsing**

In `packages/core-rs/src/receipts/client.rs`, add (or extend) the test module. This test
starts a mock server, posts, and asserts the parsed `access` survives:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::http_client::HttpClient;
    use std::sync::Arc;

    #[test]
    fn post_apple_parses_access_map() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"u1"},
                    "credits":{"balance":42},
                    "access":{"pro":{"isActive":true,"expiresDate":null,
                              "store":"APP_STORE","productIdentifier":"pro_monthly"}}}}"#,
            )
            .create();

        let http = Arc::new(HttpClient::new(server.url(), "pk_test".to_string()));
        let client = ReceiptClient::new(http);

        let outcome = client
            .post_apple("rcpt", "u1", "pro_monthly", "idem_rcpt_x", None)
            .expect("post ok");

        assert_eq!(outcome.subscriber_id, "sub_1");
        assert_eq!(outcome.credit_balance, 42);
        let access = outcome.access.expect("access present");
        assert!(access.get("pro").unwrap().is_active);
    }
}
```

> Note: if `ReceiptClient::new` / `HttpClient::new` signatures differ in this codebase,
> match the existing constructor usage already present in the file's other tests; the
> assertions on `outcome` are the point of this test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p librovenue post_apple_parses_access_map`
Expected: FAIL — `post_apple` still returns `ReceiptResult` (no `access` field), so this
won't compile / the field access fails.

- [ ] **Step 4: Change the client to return `ReceiptPostOutcome`**

In `packages/core-rs/src/receipts/client.rs`, update the imports to include the new type
(replace the existing `ReceiptResult` import from `super::types` if present):

```rust
use super::types::{ReceiptBody, ReceiptPostOutcome, ReceiptResponse};
```

Change the return type of `post_apple`, `post_google`, and the private `post` from
`RovenueResult<ReceiptResult>` to `RovenueResult<ReceiptPostOutcome>` (signatures
otherwise unchanged). Replace the tail of the private `post` helper:

```rust
        let data = resp.body.ok_or(RovenueError::Internal)?.data;
        Ok(ReceiptPostOutcome {
            subscriber_id: data.subscriber.id,
            app_user_id: data.subscriber.app_user_id,
            credit_balance: data.credits.balance,
            access: data.access,
        })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p librovenue post_apple_parses_access_map`
Expected: PASS. (`cargo build -p librovenue` will still fail in `api.rs` — that's fixed in
Task 3. If the build error blocks the test, run Task 3 Step 1 first then return here; the
plan is ordered so Task 3 immediately follows.)

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/receipts/types.rs packages/core-rs/src/receipts/client.rs
git commit -m "feat(sdk-core): parse access map from receipt response into ReceiptPostOutcome"
```

---

## Task 3: Hydrate cache from the response & return entitlements (D)

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`
- Modify: `packages/core-rs/src/receipts/types.rs`
- Modify: `packages/core-rs/src/entitlements/reader.rs`
- Modify: `packages/core-rs/src/credits/reader.rs`
- Modify: `packages/core-rs/src/api.rs`
- Test: `packages/core-rs/src/api.rs` (`#[cfg(test)]`) or existing receipt integration test module

- [ ] **Step 1: Extend the FFI `ReceiptResult` (udl + Rust struct)**

In `packages/core-rs/src/librovenue.udl`, replace the `ReceiptResult` dictionary:

```
dictionary ReceiptResult {
    string subscriber_id;
    string app_user_id;
    i64 credit_balance;
    sequence<Entitlement> entitlements;
};
```

In `packages/core-rs/src/receipts/types.rs`, replace the `ReceiptResult` struct (and update
its doc comment, since the access field is no longer dropped). Add the import for
`Entitlement`:

```rust
use crate::entitlements::types::Entitlement;
```

```rust
/// FFI-visible result of a successful receipt post. Entitlements + balance are
/// taken from the POST response (the core hydrates the cache from it), so the
/// façade builds its public PurchaseResult without any follow-up GET.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
    pub entitlements: Vec<Entitlement>,
}
```

- [ ] **Step 2: Add `hydrate` + staleness field stub to `EntitlementReader`**

In `packages/core-rs/src/entitlements/reader.rs`, add imports:

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use super::types::{Entitlement, EntitlementWire, EntitlementsResponse};
```

Add two fields to the `EntitlementReader` struct:

```rust
    last_refresh_ms: AtomicU64,
    refreshing: AtomicBool,
```

Initialize them in `new()` (inside the returned `Self { ... }`):

```rust
            last_refresh_ms: AtomicU64::new(0),
            refreshing: AtomicBool::new(false),
```

Add a `hydrate` method inside `impl EntitlementReader`:

```rust
    /// Write entitlements straight from an in-memory access map (e.g. a receipt
    /// POST response) — no network. Stamps freshness and emits the observer.
    pub fn hydrate(
        &self,
        scope: &str,
        map: HashMap<String, EntitlementWire>,
        now: u64,
    ) -> RovenueResult<()> {
        let rows = map_to_rows(map, now);
        EntitlementsRepo::new(&self.store).upsert_many(scope, &rows)?;
        self.last_refresh_ms.store(now, Ordering::Relaxed);
        if let Some(bus) = &self.bus {
            bus.emit(ChangeEvent::EntitlementsChanged);
        }
        Ok(())
    }
```

- [ ] **Step 3: Add `set_balance` + staleness field stub to `CreditReader`**

In `packages/core-rs/src/credits/reader.rs`, add imports:

```rust
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
```

Add two fields to the `CreditReader` struct and initialize them in `new()` exactly as in
Step 2 (`last_refresh_ms: AtomicU64::new(0)`, `refreshing: AtomicBool::new(false)`).

Add a public method inside `impl CreditReader`:

```rust
    /// Set the balance straight from a known value (e.g. a receipt POST
    /// response) — no network. Stamps freshness and emits on change.
    pub fn set_balance(&self, scope: &str, balance: i64, now: u64) -> RovenueResult<()> {
        self.store_and_emit(scope, balance, now)?;
        self.last_refresh_ms.store(now, Ordering::Relaxed);
        Ok(())
    }
```

- [ ] **Step 4: Store a clock on `RovenueCore` and rewrite the receipt posts**

In `packages/core-rs/src/api.rs`, add a field to the `RovenueCore` struct:

```rust
    clock: Arc<dyn Clock>,
```

In the constructor, after `let clock: Arc<dyn Clock> = Arc::new(SystemClock);`, ensure the
struct literal that builds `RovenueCore` includes `clock: Arc::clone(&clock),` (add the
field). Confirm `use crate::time::Clock;` is present (add if missing).

Replace the body of `post_apple_receipt` (keeping the deterministic key from Task 1):

```rust
    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
        app_account_token: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::for_receipt("apple", &receipt);
        let outcome = self.receipts.post_apple(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            app_account_token.as_deref(),
        )?;
        Ok(self.finish_receipt(&scope, outcome))
    }
```

Replace the body of `post_google_receipt`:

```rust
    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
        obfuscated_account_id: Option<String>,
        obfuscated_profile_id: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::for_receipt("google", &receipt);
        let outcome = self.receipts.post_google(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            obfuscated_account_id.as_deref(),
            obfuscated_profile_id.as_deref(),
        )?;
        Ok(self.finish_receipt(&scope, outcome))
    }
```

Add the shared helper (it replaces the two old `refresh()` GETs with cache hydration, then
reads the cache once to build the FFI result):

```rust
    /// Hydrate entitlement + credit caches from a receipt POST response and
    /// build the FFI result — no follow-up GETs. Falls back to a GET refresh
    /// only when an older server omitted `access` entirely.
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
        let _ = self.credits.set_balance(scope, outcome.credit_balance, now);
        ReceiptResult {
            subscriber_id: outcome.subscriber_id,
            app_user_id: outcome.app_user_id,
            credit_balance: outcome.credit_balance,
            entitlements: self.entitlements.list_all().unwrap_or_default(),
        }
    }
```

Update the `api.rs` imports to bring in `ReceiptPostOutcome`:

```rust
use crate::receipts::types::ReceiptPostOutcome;
```

> Keep the existing `ReceiptResult` import. Remove now-unused imports only if the compiler
> flags them.

- [ ] **Step 5: Write the failing test — purchase does not GET, returns entitlements**

Add to the `#[cfg(test)]` module in `packages/core-rs/src/api.rs` (mirror the construction
used by other `api.rs` tests for building a configured `RovenueCore` against a mock server):

```rust
    #[test]
    #[serial_test::serial]
    fn post_apple_receipt_hydrates_without_followup_get() {
        let mut server = mockito::Server::new();
        let post = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"u1"},
                    "credits":{"balance":7},
                    "access":{"pro":{"isActive":true,"expiresDate":null,
                              "store":"APP_STORE","productIdentifier":"pro_monthly"}}}}"#,
            )
            .expect(1)
            .create();
        // Any GET to entitlements/credits would mean we failed to hydrate.
        let ents = server.mock("GET", "/v1/me/entitlements").expect(0).create();
        let creds = server.mock("GET", "/v1/me/credits").expect(0).create();

        let core = test_core(&server.url()); // existing helper in this test module

        let result = core
            .post_apple_receipt("rcpt".into(), "pro_monthly".into(), None)
            .expect("receipt ok");

        assert_eq!(result.credit_balance, 7);
        assert_eq!(result.entitlements.len(), 1);
        assert_eq!(result.entitlements[0].id, "pro");
        assert!(result.entitlements[0].is_active);

        post.assert();
        ents.assert();
        creds.assert();
    }
```

> If no `test_core(url)` helper exists, build the core inline the same way the other tests in
> this module do (construct `Config`, call the constructor). The assertions above are the
> contract.

- [ ] **Step 6: Run test to verify it fails, then passes**

Run: `cargo test -p librovenue post_apple_receipt_hydrates_without_followup_get`
Expected: FAILs before Step 4's helper exists / compiles; PASSes once Steps 1-4 are in.
If it was already green from prior steps, confirm the `expect(0)` GET mocks pass (proving the
two follow-up GETs are gone).

- [ ] **Step 7: Add the missing-`access` fallback test**

```rust
    #[test]
    #[serial_test::serial]
    fn post_apple_receipt_falls_back_to_get_when_access_absent() {
        let mut server = mockito::Server::new();
        let _post = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"u1"},
                    "credits":{"balance":0}}}"#,
            )
            .create();
        let ents = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect(1)
            .create();

        let core = test_core(&server.url());
        let _ = core.post_apple_receipt("rcpt".into(), "p".into(), None).expect("ok");
        ents.assert(); // fallback GET fired exactly once
    }
```

Run: `cargo test -p librovenue post_apple_receipt_falls_back_to_get_when_access_absent`
Expected: PASS.

- [ ] **Step 8: Build the whole crate**

Run: `cargo build -p librovenue && cargo test -p librovenue`
Expected: builds clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core-rs/src/librovenue.udl packages/core-rs/src/receipts/types.rs \
  packages/core-rs/src/entitlements/reader.rs packages/core-rs/src/credits/reader.rs \
  packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): hydrate caches from receipt response, return entitlements (drop 2 GETs)"
```

---

## Task 4: Read-side staleness guard (C2)

**Files:**
- Modify: `packages/core-rs/src/entitlements/reader.rs`
- Modify: `packages/core-rs/src/credits/reader.rs`
- Modify: `packages/core-rs/src/api.rs`
- Test: `packages/core-rs/src/entitlements/reader.rs` and `packages/core-rs/src/api.rs`

- [ ] **Step 1: Stamp freshness inside `refresh()` (both readers)**

In `packages/core-rs/src/entitlements/reader.rs`, in `refresh()`:
- In the `if resp.status == 304 { return Ok(()); }` branch, stamp freshness before
  returning. Replace that branch with:

```rust
        if resp.status == 304 {
            self.last_refresh_ms.store(clock.now_unix_ms(), Ordering::Relaxed);
            return Ok(());
        }
```

- After the existing `EntitlementsRepo::new(&self.store).upsert_many(&scope, &rows)?;` line,
  add:

```rust
        self.last_refresh_ms.store(now, Ordering::Relaxed);
```

In `packages/core-rs/src/credits/reader.rs`, `refresh()` ends by calling `store_and_emit`.
Change it to call the new freshness-stamping wrapper instead:

```rust
        self.set_balance(&scope, body.data.balance, clock.now_unix_ms())
```

- [ ] **Step 2: Write the failing test for the staleness decision**

Add a pure helper and test it deterministically. In
`packages/core-rs/src/entitlements/reader.rs`, add a free function near the top:

```rust
/// True when cached data is older than `staleness_ms`. `last == 0` (never
/// refreshed, e.g. cold start) is always stale.
pub(crate) fn is_stale(now: u64, last: u64, staleness_ms: u64) -> bool {
    now.saturating_sub(last) > staleness_ms
}
```

Add to the test module:

```rust
#[cfg(test)]
mod stale_tests {
    use super::is_stale;

    #[test]
    fn staleness_decision() {
        assert!(is_stale(100_000, 0, 60_000), "cold start is stale");
        assert!(is_stale(100_000, 30_000, 60_000), "70s old is stale");
        assert!(!is_stale(100_000, 50_000, 60_000), "50s old is fresh");
        assert!(!is_stale(100_000, 100_000, 60_000), "just refreshed is fresh");
    }
}
```

Run: `cargo test -p librovenue staleness_decision`
Expected: PASS (helper exists). If you wrote the test first, it FAILs until `is_stale` is
added — add it, then PASS.

- [ ] **Step 3: Add `maybe_refresh_async` to `EntitlementReader`**

Inside `impl EntitlementReader`:

```rust
    /// Non-blocking stale-while-revalidate trigger. Returns immediately; if the
    /// cache is stale and no refresh is in flight, spawns one background refresh
    /// (coalesced via `refreshing`) that emits the observer on completion.
    pub fn maybe_refresh_async(self: &std::sync::Arc<Self>, staleness_ms: u64) {
        let now = match &self.clock {
            Some(c) => c.now_unix_ms(),
            None => return,
        };
        if !is_stale(now, self.last_refresh_ms.load(Ordering::Relaxed), staleness_ms) {
            return;
        }
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // a refresh is already running — coalesce
        }
        let this = std::sync::Arc::clone(self);
        std::thread::spawn(move || {
            let _ = this.refresh();
            this.refreshing.store(false, Ordering::Release);
        });
    }
```

- [ ] **Step 4: Add the same `maybe_refresh_async` to `CreditReader`**

In `packages/core-rs/src/credits/reader.rs`, first add a private staleness helper (reuse the
same logic; credits has no `is_stale` in scope):

```rust
    fn is_stale(&self, now: u64, staleness_ms: u64) -> bool {
        now.saturating_sub(self.last_refresh_ms.load(Ordering::Relaxed)) > staleness_ms
    }
```

Then add:

```rust
    pub fn maybe_refresh_async(self: &std::sync::Arc<Self>, staleness_ms: u64) {
        let now = match &self.clock {
            Some(c) => c.now_unix_ms(),
            None => return,
        };
        if !self.is_stale(now, staleness_ms) {
            return;
        }
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let this = std::sync::Arc::clone(self);
        std::thread::spawn(move || {
            let _ = this.refresh();
            this.refreshing.store(false, Ordering::Release);
        });
    }
```

- [ ] **Step 5: Wire the guard into the read methods**

In `packages/core-rs/src/api.rs`, add the constant near the other interval constant:

```rust
const STALENESS_MS: u64 = 60_000;
```

Update the three read methods to kick the guard after reading cache (reads still return the
cached value synchronously):

```rust
    pub fn entitlement(&self, id: String) -> Option<Entitlement> {
        let out = self.entitlements.get(&id).ok().flatten();
        self.entitlements.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn entitlements_all(&self) -> Vec<Entitlement> {
        let out = self.entitlements.list_all().unwrap_or_default();
        self.entitlements.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn credit_balance(&self) -> i64 {
        let out = self.credits.balance().unwrap_or(0);
        self.credits.maybe_refresh_async(STALENESS_MS);
        out
    }
```

> `self.entitlements` and `self.credits` are `Arc<...>`, so `maybe_refresh_async` (which
> takes `self: &Arc<Self>`) resolves directly on the field.

- [ ] **Step 6: Write the failing integration test — stale read triggers exactly one refresh**

Add to the `api.rs` test module:

```rust
    #[test]
    #[serial_test::serial]
    fn stale_read_triggers_single_coalesced_refresh() {
        let mut server = mockito::Server::new();
        let ents = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect(1) // a burst of reads must coalesce into ONE network call
            .create();

        let core = test_core(&server.url()); // last_refresh_ms == 0 → stale

        for _ in 0..5 {
            let _ = core.entitlements_all();
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        ents.assert();
    }
```

Run: `cargo test -p librovenue stale_read_triggers_single_coalesced_refresh`
Expected: FAIL before Steps 3/5, PASS after.

- [ ] **Step 7: Run the full crate tests**

Run: `cargo test -p librovenue`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core-rs/src/entitlements/reader.rs packages/core-rs/src/credits/reader.rs \
  packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): stale-while-revalidate guard on entitlement/credit reads (60s)"
```

---

## Task 5: Immediate refresh on foreground (C1)

**Files:**
- Modify: `packages/core-rs/src/polling/scheduler.rs`
- Modify: `packages/core-rs/src/api.rs`
- Test: `packages/core-rs/src/polling/scheduler.rs`

- [ ] **Step 1: Write the failing test for `reset_cadence`**

In `packages/core-rs/src/polling/scheduler.rs` test module, add:

```rust
    #[test]
    fn reset_cadence_refires_immediately_after_reforeground() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let sched = PollingScheduler::new();
        let count = Arc::new(AtomicUsize::new(0));
        {
            let count = Arc::clone(&count);
            sched.register("t", std::time::Duration::from_secs(3600), move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
        }
        sched.set_foreground(true);
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(count.load(Ordering::SeqCst), 1, "first foreground fires once");

        // Without reset, the 1h interval would block the next fire.
        sched.reset_cadence();
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(count.load(Ordering::SeqCst), 2, "reset_cadence re-fires immediately");
    }
```

Run: `cargo test -p librovenue reset_cadence_refires_immediately_after_reforeground`
Expected: FAIL — `no method named reset_cadence`.

- [ ] **Step 2: Implement `reset_cadence`**

In `packages/core-rs/src/polling/scheduler.rs`, inside `impl PollingScheduler`, add:

```rust
    /// Clear every registration's last-fired time so the loop fires each task on
    /// its next tick. Used on foreground transitions to refresh immediately
    /// instead of waiting out the remaining interval.
    pub fn reset_cadence(&self) {
        let regs = self.inner.registrations.lock().expect("regs poisoned");
        for (_name, reg) in regs.iter() {
            *reg.last_fired.lock().expect("last_fired poisoned") = None;
        }
    }
```

> Match the exact field access pattern used by `run_loop` (it reads
> `inner.registrations` and `reg.last_fired`). If `registrations` is a `HashMap`, iterate
> `.iter()`; if it's a `Vec<(String, Reg)>`, iterate accordingly. Mirror `run_loop`'s usage.

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test -p librovenue reset_cadence_refires_immediately_after_reforeground`
Expected: PASS.

- [ ] **Step 4: Call `reset_cadence` on foreground transition**

In `packages/core-rs/src/api.rs`, replace `set_foreground`:

```rust
    pub fn set_foreground(&self, foreground: bool) {
        self.scheduler.set_foreground(foreground);
        if foreground {
            // Refresh now instead of waiting out the remaining poll interval.
            self.scheduler.reset_cadence();
        }
    }
```

- [ ] **Step 5: Build and run all core tests**

Run: `cargo build -p librovenue && cargo test -p librovenue`
Expected: builds clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/polling/scheduler.rs packages/core-rs/src/api.rs
git commit -m "feat(sdk-core): refresh immediately on foreground via scheduler cadence reset"
```

---

## Task 6: Regenerate FFI bindings & wire façades (D)

The public `PurchaseResult` shape in each façade is unchanged; only its source becomes the
`ReceiptResult.entitlements` now returned by the core, removing any redundant post-purchase
cache read.

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (purchase result construction)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` + `internal/PlayPurchaseFlow.kt`
- Modify: `packages/sdk-rn/src/purchases.ts` (and `ios/RovenueModule.swift` if it maps the result)

- [ ] **Step 1: Regenerate uniffi bindings**

Run the project's binding-generation command (check `packages/core-rs/README` or the build
scripts; typically a `uniffi-bindgen` invocation or a `pnpm`/`cargo` task). After
regeneration, the generated `ReceiptResult` for each language carries `entitlements`.

Run: `git status` to confirm regenerated binding files changed.
Expected: generated Swift/Kotlin/TS binding for `ReceiptResult` now lists `entitlements`.

- [ ] **Step 2: Swift façade — build `PurchaseResult` from the result**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, in the purchase path, construct
`PurchaseResult` using `result.entitlements` and `result.creditBalance` directly. Remove any
separate `entitlementsAll()` read that was used only to populate the purchase result:

```swift
let result = try core.postAppleReceipt(receipt: jws, productId: product.id, appAccountToken: token)
return PurchaseResult(
    entitlements: result.entitlements.map(Entitlement.init(from:)),
    creditBalance: result.creditBalance,
    productId: product.id,
    storeTransactionId: storeTxnId
)
```

> Use the existing `Entitlement` mapping helper already in the file; match its name/shape.

- [ ] **Step 3: Kotlin façade — same change**

In `packages/sdk-kotlin/.../internal/PlayPurchaseFlow.kt`, build `PurchaseResult` from the
validated `receipt` result's `entitlements` instead of a separate `snapshot()` entitlement
read:

```kotlin
val receipt = validate(outcome.purchaseToken, productId) // returns ReceiptResult
outcome.acknowledge()
return PurchaseResult(
    entitlements = receipt.entitlements.map { it.toEntitlement() },
    creditBalance = receipt.creditBalance,
    productId = productId,
    storeTransactionId = outcome.orderId,
)
```

> Keep `validate(...)` returning the core `ReceiptResult`. Use the existing entitlement
> mapping helper (`toEntitlement()` or equivalent already in the module).

- [ ] **Step 4: React Native façade — same change**

In `packages/sdk-rn/src/purchases.ts`, build the returned `PurchaseResult` from the result's
`entitlements` (mapped via the existing `dtoFromEntitlement`) and `creditBalance`, removing
any extra `entitlementsAll()` call used only to fill the purchase result.

- [ ] **Step 5: Build each façade**

Run the per-package build/test that exists (e.g. `swift build` in `packages/sdk-swift`,
`./gradlew assemble` in `packages/sdk-kotlin`, `pnpm --filter @rovenue/sdk-rn build`).
Expected: each compiles against the regenerated bindings.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift packages/sdk-kotlin packages/sdk-rn
git commit -m "feat(sdk): build PurchaseResult from receipt result entitlements (no extra read)"
```

---

## Final verification

- [ ] **Step 1: Full core test + lint**

Run: `cargo test -p librovenue && cargo clippy -p librovenue --all-targets`
Expected: tests pass; clippy clean (fix any warnings introduced).

- [ ] **Step 2: Confirm the purchase path is single-round-trip**

Re-read `post_apple_receipt` / `post_google_receipt` in `api.rs`: confirm there are no
`self.entitlements.refresh()` / `self.credits.refresh()` calls in the success path (only the
`access`-absent fallback may GET). The two follow-up GETs are gone.

- [ ] **Step 3: Confirm spec coverage**

Cross-check against `docs/superpowers/specs/2026-06-16-sdk-purchase-freshness-design.md`:
B (Task 1), C1 (Task 5), C2 (Task 4), D (Tasks 2, 3, 6) all implemented.
