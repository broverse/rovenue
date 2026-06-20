# Funnel Claim Core (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the SDK claim-client primitives + install lifecycle: `Rovenue.claimFunnelToken` / `claimInstall` / `claimViaEmail` + a payload-carrying `onFunnelClaimResolved` callback, across Rust core + uniffi + Swift/Kotlin/RN.

**Architecture:** A new Rust `funnel` module (status-aware HTTP client + types + a single-listener bus) plus a persisted `install_id` and once-per-install claim state (cache migration V9). `RovenueCore` methods POST to the three backend claim endpoints, refresh entitlements after a successful claim (no backend change), record state, and emit `FunnelClaimResolved` to a dedicated callback bridged to JS through a new Expo event — mirroring the existing `Observer`→`onChange` bridge exactly. The envelope crosses FFI with `funnel_answers` as a JSON string (uniffi can't carry arbitrary JSON).

**Tech Stack:** Rust (core-rs, uniffi 0.25.3, reqwest blocking, rusqlite, mockito tests), Swift façade (sdk-swift) + Expo module (sdk-rn/ios), Kotlin façade (sdk-kotlin) + Expo module (sdk-rn/android), TypeScript (sdk-rn/src, Vitest).

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on whatever HEAD is checked out.
- Conventional commits (`feat:`/`fix:`/`test:`/`chore:`/`docs:`).
- This sub-project collects **no native device data** — `claimInstall` inputs are parameters supplied by the caller.
- Reuse existing machinery: `EntitlementReader::refresh` (via `RovenueCore::refresh_entitlements`), the `ApiEnvelope<T>` = `{ data: T }` wrapper, the cache migration pattern (`MIGRATIONS` array + `UPDATE schema_meta SET version = N`), the `Observer`→`ObserverBridge`→`onChange` bridge as the template for the new claim callback, and the `call()` + `mapNativeError` TS helpers.
- Backend claim bodies use **snake_case** keys: `token`, `anon_id`, `screen_dims`, `install_referrer`, `install_id`.
- `funnel_answers` crosses FFI as a JSON string (`funnel_answers_json`); façades parse it (mirrors `remote_config_json`).
- uniffi-generated Swift binding is gitignored; the Kotlin binding `librovenue.kt` is tracked-and-committed — regenerate with `npm run sdk:bindings` and commit the Kotlin diff, never the Swift one (see [[rovenue_sdk_uniffi_bindings]]).
- Verify Kotlin via `testDebugUnitTest` (not compile-only).

---

### Task 1: Status-aware POST primitive (`post_json_status`)

The existing `post_json` collapses every 4xx into `RovenueError::ServerError` (and treats 409 as success), so it can't distinguish the funnel endpoints' `404`/`410`/`409`. Add a transport method that returns the raw status + parsed body for any non-retryable response, so the funnel client can map statuses itself.

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs`
- Test: same file (new `#[cfg(test)] mod` at end)

**Interfaces:**
- Consumes: existing `HttpClient` retry loop, `HttpPostRequest`, `classify`, `backoff`.
- Produces: `HttpClient::post_json_status<B: Serialize>(&self, req: HttpPostRequest, body: &B) -> RovenueResult<(u16, Option<serde_json::Value>)>` — `Ok((status, body))` for any `2xx`/`4xx` (body `None` when empty/unparseable), `Err` only on network failure / timeout / `5xx` after retries. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `packages/core-rs/src/transport/http_client.rs`:

```rust
#[cfg(test)]
mod post_json_status_tests {
    use super::*;
    use super::super::types::HttpPostRequest;

    #[test]
    fn returns_status_and_body_for_2xx_and_4xx() {
        let mut server = mockito::Server::new();
        let m200 = server.mock("POST", "/ok").with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"x":1}}"#).create();
        let m404 = server.mock("POST", "/missing").with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":{"code":"x","message":"y"}}"#).create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({"a":1});

        let (s1, b1) = client
            .post_json_status(HttpPostRequest::new("/ok"), &body)
            .expect("2xx ok");
        assert_eq!(s1, 200);
        assert_eq!(b1.unwrap()["data"]["x"], 1);

        let (s2, b2) = client
            .post_json_status(HttpPostRequest::new("/missing"), &body)
            .expect("4xx returns Ok, not Err");
        assert_eq!(s2, 404);
        assert_eq!(b2.unwrap()["error"]["code"], "x");

        m200.assert();
        m404.assert();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue returns_status_and_body_for_2xx_and_4xx`
Expected: FAIL — `no method named post_json_status`.

- [ ] **Step 3: Implement `post_json_status`**

In `packages/core-rs/src/transport/http_client.rs`, add this method inside `impl HttpClient` (after `post_json`):

```rust
    /// POST that surfaces the raw HTTP status instead of collapsing 4xx into an
    /// error. Returns `Ok((status, body))` for any 2xx or 4xx response (body is
    /// `None` when empty or non-JSON); retries 5xx/network/timeout and returns
    /// `Err` only when those are exhausted. Used by callers that map specific
    /// 4xx codes themselves (e.g. funnel claim 404/410/409).
    pub fn post_json_status<B: Serialize>(
        &self,
        req: super::types::HttpPostRequest<'_>,
        body: &B,
    ) -> RovenueResult<(u16, Option<serde_json::Value>)> {
        use super::retry::{backoff, classify, RetryDecision, RETRY_AFTER_MAX};

        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable;
        let payload = serde_json::to_vec(body).map_err(|_| RovenueError::Internal)?;

        for attempt in 0..self.max_attempts {
            let mut builder = self
                .inner
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json");
            if let Some(scope) = req.user_scope {
                builder = builder.header("X-Rovenue-App-User-Id", scope);
            }
            if let Some(platform) = &self.platform {
                builder = builder.header("X-Rovenue-Platform", platform);
            }
            if let Some(environment) = &self.environment {
                builder = builder.header("X-Rovenue-Env", environment);
            }
            if let Some(key) = req.idempotency_key {
                builder = builder.header("Idempotency-Key", key);
            }

            match builder.body(payload.clone()).send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    // 4xx is a returnable outcome (caller maps it); 2xx too.
                    if (200..500).contains(&status) {
                        let parsed = resp.json::<serde_json::Value>().ok();
                        return Ok((status, parsed));
                    }
                    // 5xx (and anything else) → retry per policy.
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs);
                    match classify(Some(status), retry_after) {
                        RetryDecision::RetryAfter(d) => {
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited);
                            }
                            last_err = RovenueError::RateLimited;
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        _ => {
                            last_err = RovenueError::ServerError;
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue returns_status_and_body_for_2xx_and_4xx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs
git commit -m "feat(core-rs): add status-aware post_json_status transport method"
```

---

### Task 2: Cache migration V9 + `FunnelRepo` (install_id + claim state)

**Files:**
- Modify: `packages/core-rs/src/cache/schema.rs`
- Create: `packages/core-rs/src/cache/funnel.rs`
- Modify: `packages/core-rs/src/cache/mod.rs` (export the repo)
- Test: in `funnel.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `CacheStore` (`with_conn`), `Clock::now_unix_ms`, `cuid2::create_id`.
- Produces: `FunnelRepo::new(&store)`, `FunnelRepo::get_or_create_install_id(now_ms) -> RovenueResult<String>`, `FunnelRepo::set_claim_state(install_id, state: &str, subscriber_id: Option<&str>, now_ms) -> RovenueResult<()>`, `FunnelRepo::claim_state(install_id) -> RovenueResult<Option<String>>`. Consumed by Task 4.

- [ ] **Step 1: Add migration V9**

In `packages/core-rs/src/cache/schema.rs`, add the const (after `MIGRATION_V8`):

```rust
pub const MIGRATION_V9: &str = r#"
CREATE TABLE funnel_install (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    install_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE funnel_claim_state (
    install_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    subscriber_id TEXT,
    claimed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);

UPDATE schema_meta SET version = 9;
"#;
```

Add `MIGRATION_V9` to the `MIGRATIONS` array and bump `LATEST`:

```rust
pub const MIGRATIONS: &[&str] = &[
    MIGRATION_V1,
    MIGRATION_V2,
    MIGRATION_V3,
    MIGRATION_V4,
    MIGRATION_V5,
    MIGRATION_V6,
    MIGRATION_V7,
    MIGRATION_V8,
    MIGRATION_V9,
];
pub const LATEST: u32 = 9;
```

- [ ] **Step 2: Write the failing test (create the repo file with test)**

Create `packages/core-rs/src/cache/funnel.rs`:

```rust
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};

/// Persists the per-install id and the once-per-install claim state.
pub struct FunnelRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> FunnelRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    /// Returns the persisted `install_id`, generating + storing it on first call.
    pub fn get_or_create_install_id(&self, now_ms: u64) -> RovenueResult<String> {
        self.store.with_conn(|c| {
            let existing: Option<String> = c
                .query_row("SELECT install_id FROM funnel_install WHERE id = 1", [], |r| r.get(0))
                .ok();
            if let Some(id) = existing {
                return Ok(id);
            }
            let id = format!("inst_{}", cuid2::create_id());
            c.execute(
                "INSERT INTO funnel_install (id, install_id, created_at_ms) VALUES (1, ?1, ?2)",
                rusqlite::params![id, now_ms as i64],
            )?;
            Ok(id)
        })
    }

    /// Upserts the claim state for an install (`pending`/`claimed`/`failed`).
    pub fn set_claim_state(
        &self,
        install_id: &str,
        state: &str,
        subscriber_id: Option<&str>,
        now_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO funnel_claim_state \
                   (install_id, state, subscriber_id, claimed_at_ms, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(install_id) DO UPDATE SET \
                   state = excluded.state, \
                   subscriber_id = excluded.subscriber_id, \
                   claimed_at_ms = excluded.claimed_at_ms",
                rusqlite::params![
                    install_id,
                    state,
                    subscriber_id,
                    if state == "claimed" { Some(now_ms as i64) } else { None },
                    now_ms as i64
                ],
            )?;
            Ok(())
        })
    }

    /// Current claim state for an install, or `None` if never attempted.
    pub fn claim_state(&self, install_id: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let s: Option<String> = c
                .query_row(
                    "SELECT state FROM funnel_claim_state WHERE install_id = ?1",
                    [install_id],
                    |r| r.get(0),
                )
                .ok();
            Ok(s)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> CacheStore {
        CacheStore::open_in_memory().expect("open in-memory store")
    }

    #[test]
    fn install_id_is_stable_across_calls() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        let a = repo.get_or_create_install_id(1000).unwrap();
        let b = repo.get_or_create_install_id(2000).unwrap();
        assert!(a.starts_with("inst_"));
        assert_eq!(a, b, "install_id must persist, not regenerate");
    }

    #[test]
    fn claim_state_roundtrips() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        assert_eq!(repo.claim_state("inst_x").unwrap(), None);
        repo.set_claim_state("inst_x", "claimed", Some("sub_1"), 5000).unwrap();
        assert_eq!(repo.claim_state("inst_x").unwrap(), Some("claimed".into()));
    }
}
```

- [ ] **Step 3: Export the repo**

In `packages/core-rs/src/cache/mod.rs`, add alongside the other `pub mod` / `pub use` lines:

```rust
pub mod funnel;
pub use funnel::FunnelRepo;
```

(If `mod.rs` re-exports types like `CacheStore`/`ExposureRepo`, follow that exact style. If `with_conn` is not already `pub` on `CacheStore`, confirm it is — the identity repo at `cache/identity.rs` uses `self.store.with_conn(...)`, so it is public.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p librovenue cache::funnel`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/cache/schema.rs packages/core-rs/src/cache/funnel.rs packages/core-rs/src/cache/mod.rs
git commit -m "feat(core-rs): cache V9 funnel_install + funnel_claim_state + FunnelRepo"
```

---

### Task 3: Funnel types, error variants, and `FunnelClient`

**Files:**
- Modify: `packages/core-rs/src/error.rs` (3 new variants)
- Create: `packages/core-rs/src/funnel/mod.rs`
- Create: `packages/core-rs/src/funnel/client.rs`
- Modify: `packages/core-rs/src/lib.rs` (`pub mod funnel;` + re-exports)
- Test: in `client.rs`

**Interfaces:**
- Consumes: `HttpClient::post_json_status` (Task 1), `ApiEnvelope`, `HttpPostRequest`.
- Produces:
  - `RovenueError::{FunnelTokenNotFound, FunnelTokenExpired, FunnelTokenAlreadyClaimed}`
  - `pub struct FunnelClaimResult { pub subscriber_id: String, pub funnel_answers_json: String }` (Clone)
  - `pub struct ClaimInstallParams { pub platform: String, pub locale: String, pub timezone: String, pub screen_dims: String, pub device_model: Option<String>, pub install_referrer: Option<String> }`
  - `pub trait FunnelClaimListener: Send + Sync { fn on_funnel_claim_resolved(&self, result: FunnelClaimResult); }`
  - `pub struct FunnelClaimBus` with `register(Arc<dyn FunnelClaimListener>)` + `emit(FunnelClaimResult)`
  - `FunnelClient::new(Arc<HttpClient>)`, `claim_funnel_token(&self, token, anon_id) -> RovenueResult<FunnelClaimResult>`, `claim_install(&self, &ClaimInstallParams, install_id) -> RovenueResult<Option<String>>`, `claim_via_email(&self, email, install_id) -> RovenueResult<()>`
  All consumed by Task 4.

- [ ] **Step 1: Add error variants**

In `packages/core-rs/src/error.rs`, add to the `RovenueError` enum (after the existing variants, before `Internal` if present, matching the existing `#[error("...")]` style):

```rust
    #[error("funnel token not found")]
    FunnelTokenNotFound,
    #[error("funnel token expired")]
    FunnelTokenExpired,
    #[error("funnel token already claimed")]
    FunnelTokenAlreadyClaimed,
```

(Match the file's actual derive/attribute style — if variants are bare without `#[error]`, add them bare. Read the enum first.)

- [ ] **Step 2: Write the failing test (create client.rs with test)**

Create `packages/core-rs/src/funnel/client.rs`:

```rust
use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::{ClaimInstallParams, FunnelClaimResult};

pub struct FunnelClient {
    http: Arc<HttpClient>,
}

impl FunnelClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// POST /v1/subscribers/claim-funnel-token. 200 → result; 404 → NotFound,
    /// 410 → Expired, 409 → AlreadyClaimed.
    pub fn claim_funnel_token(
        &self,
        token: &str,
        anon_id: &str,
    ) -> RovenueResult<FunnelClaimResult> {
        let body = serde_json::json!({ "token": token, "anon_id": anon_id });
        let (status, parsed) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/subscribers/claim-funnel-token"), &body)?;
        match status {
            200 => {
                let data = parsed
                    .and_then(|v| v.get("data").cloned())
                    .ok_or(RovenueError::Internal)?;
                let subscriber_id = data
                    .get("subscriber_id")
                    .and_then(|v| v.as_str())
                    .ok_or(RovenueError::Internal)?
                    .to_string();
                let funnel_answers_json = data
                    .get("funnel_answers")
                    .cloned()
                    .unwrap_or(serde_json::json!({}))
                    .to_string();
                Ok(FunnelClaimResult { subscriber_id, funnel_answers_json })
            }
            404 => Err(RovenueError::FunnelTokenNotFound),
            410 => Err(RovenueError::FunnelTokenExpired),
            409 => Err(RovenueError::FunnelTokenAlreadyClaimed),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }

    /// POST /v1/sdk/claim-install. 200 → recovered token; 404 → None (no match).
    pub fn claim_install(
        &self,
        params: &ClaimInstallParams,
        install_id: &str,
    ) -> RovenueResult<Option<String>> {
        let mut body = serde_json::json!({
            "platform": params.platform,
            "locale": params.locale,
            "timezone": params.timezone,
            "screen_dims": params.screen_dims,
            "install_id": install_id,
        });
        if let Some(dm) = &params.device_model {
            body["device_model"] = serde_json::json!(dm);
        }
        if let Some(ir) = &params.install_referrer {
            body["install_referrer"] = serde_json::json!(ir);
        }
        let (status, parsed) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/sdk/claim-install"), &body)?;
        match status {
            200 => {
                let token = parsed
                    .and_then(|v| v.get("data").and_then(|d| d.get("token")).and_then(|t| t.as_str()).map(str::to_string));
                Ok(token)
            }
            404 => Ok(None),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }

    /// POST /v1/sdk/claim-via-email. Always 202; resolution happens later.
    pub fn claim_via_email(&self, email: &str, install_id: &str) -> RovenueResult<()> {
        let body = serde_json::json!({ "email": email, "install_id": install_id });
        let (status, _) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/sdk/claim-via-email"), &body)?;
        match status {
            202 | 200 => Ok(()),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> FunnelClient {
        FunnelClient::new(Arc::new(HttpClient::new(url.to_string(), "pk_test".into()).with_max_attempts(1)))
    }

    #[test]
    fn claim_funnel_token_parses_200() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_1","entitlements":[],"funnel_answers":{"q1":"yes"}}}"#)
            .create();
        let r = client(&server.url()).claim_funnel_token("tok", "rov_x").expect("ok");
        assert_eq!(r.subscriber_id, "sub_1");
        assert_eq!(r.funnel_answers_json, r#"{"q1":"yes"}"#);
        m.assert();
    }

    #[test]
    fn claim_funnel_token_maps_status_errors() {
        for (code, want) in [(404u16, RovenueError::FunnelTokenNotFound), (410, RovenueError::FunnelTokenExpired), (409, RovenueError::FunnelTokenAlreadyClaimed)] {
            let mut server = mockito::Server::new();
            let _m = server.mock("POST", "/v1/subscribers/claim-funnel-token").with_status(code.into()).create();
            let err = client(&server.url()).claim_funnel_token("tok", "rov_x").unwrap_err();
            assert_eq!(err, want, "status {code}");
        }
    }

    #[test]
    fn claim_install_returns_token_or_none() {
        let mut server = mockito::Server::new();
        let m_ok = server.mock("POST", "/v1/sdk/claim-install").with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"token":"recovered_tok"}}"#).create();
        let params = ClaimInstallParams {
            platform: "android".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None, install_referrer: Some("rovenue_funnel_token=recovered_tok".into()),
        };
        assert_eq!(client(&server.url()).claim_install(&params, "inst_1").unwrap(), Some("recovered_tok".into()));
        m_ok.assert();

        let mut server2 = mockito::Server::new();
        let _m404 = server2.mock("POST", "/v1/sdk/claim-install").with_status(404).create();
        assert_eq!(client(&server2.url()).claim_install(&params, "inst_1").unwrap(), None);
    }

    #[test]
    fn claim_via_email_accepts_202() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/sdk/claim-via-email").with_status(202).create();
        client(&server.url()).claim_via_email("a@b.com", "inst_1").expect("202 ok");
        m.assert();
    }
}
```

Note: `RovenueError` must derive `PartialEq` for the `assert_eq!` on errors. If it does not, change those assertions to `assert!(matches!(err, want))` with explicit patterns instead.

- [ ] **Step 3: Create `funnel/mod.rs` with types + bus**

Create `packages/core-rs/src/funnel/mod.rs`:

```rust
pub mod client;

pub use client::FunnelClient;

use std::sync::{Arc, Mutex};

/// FFI-facing result of a resolved funnel claim. `funnel_answers_json` is the
/// raw `funnel_answers` object serialized to a JSON string (uniffi can't carry
/// arbitrary JSON — façades parse it).
#[derive(Debug, Clone)]
pub struct FunnelClaimResult {
    pub subscriber_id: String,
    pub funnel_answers_json: String,
}

/// Inputs for `claim_install`. Device fields are caller-supplied; the core
/// fills `install_id` itself.
#[derive(Debug, Clone)]
pub struct ClaimInstallParams {
    pub platform: String,
    pub locale: String,
    pub timezone: String,
    pub screen_dims: String,
    pub device_model: Option<String>,
    pub install_referrer: Option<String>,
}

/// Implemented by façades to receive the resolved claim. Mirrors `Observer`.
pub trait FunnelClaimListener: Send + Sync {
    fn on_funnel_claim_resolved(&self, result: FunnelClaimResult);
}

/// Holds the registered listener(s) and fans out claim resolutions. Mirrors
/// `ObserverBus` (the FFI passes a `Box<dyn FunnelClaimListener>` once).
#[derive(Default)]
pub struct FunnelClaimBus {
    subs: Mutex<Vec<Arc<dyn FunnelClaimListener>>>,
}

impl FunnelClaimBus {
    pub fn register(&self, l: Arc<dyn FunnelClaimListener>) {
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).push(l);
    }

    pub fn emit(&self, result: FunnelClaimResult) {
        let guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        for s in guard.iter() {
            s.on_funnel_claim_resolved(result.clone());
        }
    }
}
```

- [ ] **Step 4: Register the module**

In `packages/core-rs/src/lib.rs`, add with the other `pub mod` lines (alphabetical near `events`):

```rust
pub mod funnel;
```

and with the `pub use` re-exports (near `pub use events::...`):

```rust
pub use funnel::{ClaimInstallParams, FunnelClaimBus, FunnelClaimListener, FunnelClaimResult, FunnelClient};
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p librovenue funnel::client && cargo build -p librovenue`
Expected: PASS (4 tests) + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/error.rs packages/core-rs/src/funnel/ packages/core-rs/src/lib.rs
git commit -m "feat(core-rs): funnel types, claim error variants, FunnelClient"
```

---

### Task 4: `RovenueCore` claim methods + install lifecycle + callback wiring

**Files:**
- Modify: `packages/core-rs/src/api.rs`
- Test: in `api.rs` tests module

**Interfaces:**
- Consumes: `FunnelClient`, `FunnelClaimBus`, `FunnelClaimResult`, `ClaimInstallParams`, `FunnelClaimListener` (Task 3); `FunnelRepo` (Task 2); `self.identity.rovenue_id()`; `self.refresh_entitlements()`; `self.clock.now_unix_ms()`; `self.store`.
- Produces (consumed by Task 5 via udl): `RovenueCore::claim_funnel_token(String) -> RovenueResult<FunnelClaimResult>`, `claim_install(ClaimInstallParams) -> RovenueResult<Option<FunnelClaimResult>>`, `claim_via_email(String) -> RovenueResult<()>`, `register_funnel_claim_listener(Box<dyn FunnelClaimListener>)`, `install_id() -> String`.

- [ ] **Step 1: Write the failing tests**

In `packages/core-rs/src/api.rs`, inside `#[cfg(test)] mod tests`, add:

```rust
    use std::sync::{Arc, Mutex};
    use crate::funnel::{ClaimInstallParams, FunnelClaimListener, FunnelClaimResult};

    struct CapturingListener(Arc<Mutex<Vec<FunnelClaimResult>>>);
    impl FunnelClaimListener for CapturingListener {
        fn on_funnel_claim_resolved(&self, result: FunnelClaimResult) {
            self.0.lock().unwrap().push(result);
        }
    }

    #[test]
    #[serial_test::serial]
    fn claim_funnel_token_refreshes_records_and_fires_callback() {
        let mut server = mockito::Server::new();
        let _m_claim = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_9","entitlements":[],"funnel_answers":{"q1":1}}}"#)
            .create();
        // claim_funnel_token triggers refresh_entitlements (a GET).
        let _m_ent = server.mock("GET", "/v1/me/entitlements")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#).expect_at_least(1).create();

        let core = make_core(&server.url());
        let seen = Arc::new(Mutex::new(Vec::new()));
        core.register_funnel_claim_listener(Box::new(CapturingListener(Arc::clone(&seen))));

        let r = core.claim_funnel_token("a_token_value".into()).expect("claim ok");
        assert_eq!(r.subscriber_id, "sub_9");
        assert_eq!(r.funnel_answers_json, r#"{"q1":1}"#);
        assert_eq!(seen.lock().unwrap().len(), 1, "callback fired once");
        assert_eq!(seen.lock().unwrap()[0].subscriber_id, "sub_9");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_chains_to_token_claim() {
        let mut server = mockito::Server::new();
        let _m_install = server.mock("POST", "/v1/sdk/claim-install")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"token":"recovered"}}"#).create();
        let _m_claim = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_i","entitlements":[],"funnel_answers":{}}}"#).create();
        let _m_ent = server.mock("GET", "/v1/me/entitlements")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#).expect_at_least(1).create();

        let core = make_core(&server.url());
        let params = ClaimInstallParams {
            platform: "android".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None,
            install_referrer: Some("rovenue_funnel_token=recovered".into()),
        };
        let out = core.claim_install(params).expect("claim_install ok");
        assert_eq!(out.unwrap().subscriber_id, "sub_i");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_returns_none_on_404() {
        let mut server = mockito::Server::new();
        let _m = server.mock("POST", "/v1/sdk/claim-install").with_status(404).create();
        let core = make_core(&server.url());
        let params = ClaimInstallParams {
            platform: "ios".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None, install_referrer: None,
        };
        assert!(core.claim_install(params).expect("ok").is_none());
    }

    #[test]
    #[serial_test::serial]
    fn install_id_is_stable() {
        let core = make_core("http://127.0.0.1:1");
        let a = core.install_id();
        let b = core.install_id();
        assert!(a.starts_with("inst_"));
        assert_eq!(a, b);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p librovenue claim_funnel_token_refreshes claim_install_chains install_id_is_stable claim_install_returns_none`
Expected: FAIL — methods not found.

- [ ] **Step 3: Add imports + struct fields**

In `packages/core-rs/src/api.rs`, add imports near the other `use crate::...`:

```rust
use crate::cache::FunnelRepo;
use crate::funnel::{ClaimInstallParams, FunnelClaimBus, FunnelClaimListener, FunnelClaimResult, FunnelClient};
```

Add two fields to `pub struct RovenueCore` (after `events: Arc<EventsClient>,`):

```rust
    funnel: Arc<FunnelClient>,
    funnel_bus: Arc<FunnelClaimBus>,
```

- [ ] **Step 4: Construct them**

In `from_store_with_http_max_attempts`, after `let events = Arc::new(EventsClient::new(Arc::clone(&http)));`, add:

```rust
        let funnel = Arc::new(FunnelClient::new(Arc::clone(&http)));
        let funnel_bus = Arc::new(FunnelClaimBus::default());
```

Add `funnel,` and `funnel_bus,` to the `Self { ... }` literal (next to `events,`).

- [ ] **Step 5: Implement the methods**

In `impl RovenueCore`, add (after `track` or `post_google_receipt`):

```rust
    /// Persisted per-install id (`inst_<cuid2>`), generated on first access.
    pub fn install_id(&self) -> String {
        let now = self.clock.now_unix_ms();
        FunnelRepo::new(&self.store)
            .get_or_create_install_id(now)
            .unwrap_or_default()
    }

    /// Register a listener fired whenever a funnel claim resolves (direct call
    /// now; automatic orchestration later). Mirrors `register_observer`.
    pub fn register_funnel_claim_listener(&self, listener: Box<dyn FunnelClaimListener>) {
        self.funnel_bus.register(Arc::from(listener));
    }

    /// Claim a known funnel token. On success refreshes entitlements (the claim
    /// response carries none), records `claimed` state, fires the callback.
    pub fn claim_funnel_token(&self, token: String) -> RovenueResult<FunnelClaimResult> {
        let anon_id = self.identity.rovenue_id();
        let result = self.funnel.claim_funnel_token(&token, &anon_id);
        self.finish_claim(result)
    }

    /// Recover a token via `claim-install` then claim it. `None` when no match.
    pub fn claim_install(
        &self,
        params: ClaimInstallParams,
    ) -> RovenueResult<Option<FunnelClaimResult>> {
        let install_id = self.install_id();
        match self.funnel.claim_install(&params, &install_id)? {
            Some(token) => Ok(Some(self.claim_funnel_token(token)?)),
            None => Ok(None),
        }
    }

    /// Kick off the email magic-link path. Resolution completes later when the
    /// link returns to the app (deep link → claim_funnel_token).
    pub fn claim_via_email(&self, email: String) -> RovenueResult<()> {
        let install_id = self.install_id();
        self.funnel.claim_via_email(&email, &install_id)
    }

    /// Shared tail for a token claim: on Ok, refresh entitlements, record state,
    /// fire the callback; on Err, record `failed`.
    fn finish_claim(
        &self,
        result: RovenueResult<FunnelClaimResult>,
    ) -> RovenueResult<FunnelClaimResult> {
        let now = self.clock.now_unix_ms();
        let install_id = self.install_id();
        let repo = FunnelRepo::new(&self.store);
        match result {
            Ok(r) => {
                let _ = self.refresh_entitlements();
                let _ = repo.set_claim_state(&install_id, "claimed", Some(&r.subscriber_id), now);
                self.funnel_bus.emit(r.clone());
                Ok(r)
            }
            Err(e) => {
                let _ = repo.set_claim_state(&install_id, "failed", None, now);
                Err(e)
            }
        }
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p librovenue claim_funnel_token_refreshes claim_install_chains install_id_is_stable claim_install_returns_none`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/api.rs
git commit -m "feat(core-rs): RovenueCore claim methods + install_id + claim callback"
```

---

### Task 5: Export claim API over uniffi `.udl` + regenerate bindings

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`

**Interfaces:**
- Consumes: the `RovenueCore` methods + types from Tasks 3–4.
- Produces: uniffi-generated Swift/Kotlin `claimFunnelToken` / `claimInstall` / `claimViaEmail` / `installId` / `registerFunnelClaimListener` + `FunnelClaimResult` / `ClaimInstallParams` records + `FunnelClaimListener` callback — consumed by Tasks 6 & 7.

- [ ] **Step 1: Add the error variants**

In `packages/core-rs/src/librovenue.udl`, inside `[Error] enum RovenueError { ... }`, add:

```
    "FunnelTokenNotFound",
    "FunnelTokenExpired",
    "FunnelTokenAlreadyClaimed",
```

- [ ] **Step 2: Add dictionaries + callback interface**

In `librovenue.udl`, near the other dictionaries / the `Observer` callback interface, add:

```
dictionary FunnelClaimResult {
    string subscriber_id;
    string funnel_answers_json;
};

dictionary ClaimInstallParams {
    string platform;
    string locale;
    string timezone;
    string screen_dims;
    string? device_model;
    string? install_referrer;
};

callback interface FunnelClaimListener {
    void on_funnel_claim_resolved(FunnelClaimResult result);
};
```

- [ ] **Step 3: Add the methods to `interface RovenueCore`**

```
    [Throws=RovenueError]
    FunnelClaimResult claim_funnel_token(string token);

    [Throws=RovenueError]
    FunnelClaimResult? claim_install(ClaimInstallParams params);

    [Throws=RovenueError]
    void claim_via_email(string email);

    void register_funnel_claim_listener(FunnelClaimListener listener);

    string install_id();
```

- [ ] **Step 4: Build + regenerate bindings**

Run: `cargo build -p librovenue`
Expected: PASS (scaffolding binds the new surface).

Run: `npm run sdk:bindings`
Expected: PASS — generated Swift + the tracked Kotlin `librovenue.kt` now expose the funnel API.

- [ ] **Step 5: Commit (udl + regenerated Kotlin binding only; NOT the Swift binding)**

```bash
git add packages/core-rs/src/librovenue.udl packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt
git status --porcelain   # confirm no sdk-swift Generated/ files staged
git commit -m "feat(core-rs): export funnel claim API over uniffi"
```

---

### Task 6: Swift façade + Expo iOS module

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/FunnelClaimBridge.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`

**Interfaces:**
- Consumes: generated `core.claimFunnelToken/claimInstall/claimViaEmail/installId/registerFunnelClaimListener`, `FunnelClaimResult`, `ClaimInstallParams`, `FunnelClaimListener` (Task 5).
- Produces: `Rovenue.shared.claimFunnelToken/claimInstall/claimViaEmail/installId` + a `funnelClaims` `AsyncStream<FunnelClaimResult>`; the JS-callable methods + an `onFunnelClaimResolved` event — consumed by Task 8.

- [ ] **Step 1: Create the bridge (mirror ObserverBridge)**

Create `packages/sdk-swift/Sources/Rovenue/Internal/FunnelClaimBridge.swift`:

```swift
import Foundation

/// Single registered `FunnelClaimListener` that fans resolved claims out to
/// AsyncStream subscribers — mirrors ObserverBridge.
internal final class FunnelClaimBridge: FunnelClaimListener, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<FunnelClaimResult>.Continuation] = [:]

    func onFunnelClaimResolved(result: FunnelClaimResult) {
        lock.lock()
        let snapshot = continuations.values
        lock.unlock()
        for c in snapshot { c.yield(result) }
    }

    func subscribe() -> AsyncStream<FunnelClaimResult> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock(); continuations[id] = continuation; lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.continuations.removeValue(forKey: id); self.lock.unlock()
            }
        }
    }
}
```

- [ ] **Step 2: Wire the bridge + methods into the façade**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`:

Add a stored bridge next to the existing `bridge` (ObserverBridge) field and register it where the observer bridge is registered in the initializer (search for `register_observer` / `registerObserver(`):

```swift
    internal let funnelBridge = FunnelClaimBridge()
    // …in the same init block that calls core.registerObserver(observer: bridge):
    //     core.registerFunnelClaimListener(listener: funnelBridge)
```

Add a public stream + the three methods (mirror `recordSessionEvent` for the dispatcher/error pattern):

```swift
    public var funnelClaims: AsyncStream<FunnelClaimResult> { funnelBridge.subscribe() }

    public func installId() -> String { core.installId() }

    public func claimFunnelToken(_ token: String) async throws -> FunnelClaimResult {
        try await dispatcher.run { [core] in
            do { return try core.claimFunnelToken(token: token) }
            catch let err as RovenueError { throw mapError(err) }
        }
    }

    public func claimInstall(_ params: ClaimInstallParams) async throws -> FunnelClaimResult? {
        try await dispatcher.run { [core] in
            do { return try core.claimInstall(params: params) }
            catch let err as RovenueError { throw mapError(err) }
        }
    }

    public func claimViaEmail(_ email: String) async throws {
        try await dispatcher.run { [core] in
            do { try core.claimViaEmail(email: email) }
            catch let err as RovenueError { throw mapError(err) }
        }
    }
```

(If the initializer that constructs `bridge`/`core` is a single place, register `funnelBridge` there. Confirm the generated method name is `registerFunnelClaimListener(listener:)`.)

- [ ] **Step 3: Wire the Expo module**

In `packages/sdk-rn/ios/RovenueModule.swift`:

Extend the `Events(...)` line to include the new event:

```swift
        Events("onChange", "onLog", "onFunnelClaimResolved")
```

In `OnStartObserving`, add a task consuming the stream (alongside the `changes` task); store it in a `funnelClaimsTask` property and cancel it in `OnStopObserving` like `changesTask`:

```swift
            self.funnelClaimsTask = Task { [weak self] in
                for await r in Rovenue.shared.funnelClaims {
                    self?.sendEvent("onFunnelClaimResolved", [
                        "subscriberId": r.subscriberId,
                        "funnelAnswersJson": r.funnelAnswersJson,
                    ])
                }
            }
```

Add the AsyncFunctions (near `recordSessionEvent`):

```swift
        AsyncFunction("installId") { () -> String in Rovenue.shared.installId() }

        AsyncFunction("claimFunnelToken") { (token: String) -> [String: Any?] in
            let r = try await Rovenue.shared.claimFunnelToken(token)
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }

        AsyncFunction("claimInstall") { (params: [String: Any?]) -> [String: Any?]? in
            let p = ClaimInstallParams(
                platform: params["platform"] as? String ?? "",
                locale: params["locale"] as? String ?? "",
                timezone: params["timezone"] as? String ?? "",
                screenDims: params["screenDims"] as? String ?? "",
                deviceModel: params["deviceModel"] as? String,
                installReferrer: params["installReferrer"] as? String
            )
            guard let r = try await Rovenue.shared.claimInstall(p) else { return nil }
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }

        AsyncFunction("claimViaEmail") { (email: String) in
            try await Rovenue.shared.claimViaEmail(email)
        }
```

Add the property near `changesTask`:

```swift
    private var funnelClaimsTask: Task<Void, Never>?
```

- [ ] **Step 4: Build to verify**

Run: `cd packages/sdk-swift && swift build`
Expected: PASS. (The Expo module file isn't standalone-compilable; verify by structural parity + the façade building. If the generated binding isn't present locally, run `npm run sdk:bindings` first.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/FunnelClaimBridge.swift \
        packages/sdk-swift/Sources/Rovenue/Rovenue.swift \
        packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-swift,sdk-rn): funnel claim API + onFunnelClaimResolved (iOS)"
```

---

### Task 7: Kotlin façade + Expo Android module

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/FunnelClaimBridge.kt`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
- Test: the sdk-kotlin façade test file that already covers `recordSessionEvent`/`setAttributes`

**Interfaces:**
- Consumes: generated `core.claimFunnelToken/claimInstall/claimViaEmail/installId/registerFunnelClaimListener`, `FunnelClaimResult`, `ClaimInstallParams`, `FunnelClaimListener` (Task 5).
- Produces: `Rovenue.shared.claimFunnelToken/claimInstall/claimViaEmail/installId` + a `funnelClaims` `SharedFlow<FunnelClaimResult>`; JS-callable methods + `onFunnelClaimResolved` event — consumed by Task 8.

- [ ] **Step 1: Create the bridge (mirror ObserverBridge.kt)**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/FunnelClaimBridge.kt`:

```kotlin
package dev.rovenue.sdk.internal

import dev.rovenue.sdk.generated.FunnelClaimListener
import dev.rovenue.sdk.generated.FunnelClaimResult
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** Single registered FunnelClaimListener fanning resolved claims into a
 *  SharedFlow — mirrors ObserverBridge. */
internal class FunnelClaimBridge : FunnelClaimListener {
    private val _flow = MutableSharedFlow<FunnelClaimResult>(
        replay = 0,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    override fun onFunnelClaimResolved(result: FunnelClaimResult) {
        _flow.tryEmit(result)
    }

    val flow: SharedFlow<FunnelClaimResult> = _flow.asSharedFlow()
}
```

- [ ] **Step 2: Wire the bridge + methods into the façade**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, add a bridge field + register it where the ObserverBridge is registered (`core.registerObserver(...)`):

```kotlin
    internal val funnelBridge = FunnelClaimBridge()
    // in the same init/configure block:  core.registerFunnelClaimListener(funnelBridge)

    val funnelClaims: SharedFlow<FunnelClaimResult> get() = funnelBridge.flow

    fun installId(): String = core.installId()

    @Throws(RovenueException::class)
    suspend fun claimFunnelToken(token: String): FunnelClaimResult =
        dispatcher.run { core.claimFunnelToken(token) }

    @Throws(RovenueException::class)
    suspend fun claimInstall(params: ClaimInstallParams): FunnelClaimResult? =
        dispatcher.run { core.claimInstall(params) }

    @Throws(RovenueException::class)
    suspend fun claimViaEmail(email: String) {
        dispatcher.run { core.claimViaEmail(email) }
    }
```

Add the needed imports (`dev.rovenue.sdk.generated.{FunnelClaimResult, ClaimInstallParams}`, `dev.rovenue.sdk.internal.FunnelClaimBridge`, `kotlinx.coroutines.flow.SharedFlow`).

- [ ] **Step 3: Add a façade forwarding test**

In the existing sdk-kotlin façade test that covers `recordSessionEvent` (find it: `rg -l "recordSessionEvent" packages/sdk-kotlin/src/test`), add a test mirroring that file's harness style. Using the real-core-against-unreachable-host pattern (as the `track` test in this repo does):

```kotlin
    @Test
    fun claimFunnelToken_forwards_to_core() = runBlocking {
        // configure against an unreachable host; claimFunnelToken must dispatch a
        // network call (a no-op would not), surfacing NetworkUnavailable.
        assertFailsWith<RovenueException.NetworkUnavailable> {
            Rovenue.shared.claimFunnelToken("some_token_value")
        }
    }
```

If that file uses a different harness (a fake/mock core), match it and assert `core.claimFunnelToken("...")` was invoked with the token instead.

- [ ] **Step 4: Wire the Expo module**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`:

Extend `Events(...)`:

```kotlin
        Events("onChange", "onLog", "onFunnelClaimResolved")
```

In `OnStartObserving`, add a collector (store the job, cancel it in `OnStopObserving` like `changesJob`):

```kotlin
            funnelClaimsJob = scope.launch {
                Rovenue.shared.funnelClaims.collect { r ->
                    sendEvent("onFunnelClaimResolved", mapOf(
                        "subscriberId" to r.subscriberId,
                        "funnelAnswersJson" to r.funnelAnswersJson,
                    ))
                }
            }
```

Add the AsyncFunctions (near `recordSessionEvent`):

```kotlin
        AsyncFunction("installId") Coroutine { -> Rovenue.shared.installId() }

        AsyncFunction("claimFunnelToken") Coroutine { token: String ->
            val r = Rovenue.shared.claimFunnelToken(token)
            mapOf("subscriberId" to r.subscriberId, "funnelAnswersJson" to r.funnelAnswersJson)
        }

        AsyncFunction("claimInstall") Coroutine { params: Map<String, Any?> ->
            val p = ClaimInstallParams(
                platform = params["platform"] as? String ?: "",
                locale = params["locale"] as? String ?: "",
                timezone = params["timezone"] as? String ?: "",
                screenDims = params["screenDims"] as? String ?: "",
                deviceModel = params["deviceModel"] as? String,
                installReferrer = params["installReferrer"] as? String,
            )
            val r = Rovenue.shared.claimInstall(p) ?: return@Coroutine null
            mapOf("subscriberId" to r.subscriberId, "funnelAnswersJson" to r.funnelAnswersJson)
        }

        AsyncFunction("claimViaEmail") Coroutine { email: String ->
            Rovenue.shared.claimViaEmail(email)
        }
```

Add the property near `changesJob`:

```kotlin
    private var funnelClaimsJob: Job? = null
```

and the imports (`dev.rovenue.sdk.generated.ClaimInstallParams`).

- [ ] **Step 5: Run the Kotlin tests**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: PASS (all green, including the new test).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/FunnelClaimBridge.kt \
        packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt \
        packages/sdk-kotlin/src/test \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-kotlin,sdk-rn): funnel claim API + onFunnelClaimResolved (Android)"
```

---

### Task 8: RN TypeScript public API

**Files:**
- Create: `packages/sdk-rn/src/api/funnel.ts`
- Modify: `packages/sdk-rn/src/errors.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Test: `packages/sdk-rn/src/api/funnel.test.ts`

**Interfaces:**
- Consumes: native `claimFunnelToken/claimInstall/claimViaEmail/installId` + the `onFunnelClaimResolved` event (Tasks 6 & 7); `getNative()`, `getEmitter()`, `call()`/`mapNativeError`.
- Produces: `Rovenue.claimFunnelToken/claimInstall/claimViaEmail/installId/addFunnelClaimListener` + `FunnelClaimResult`/`ClaimInstallParams` types.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/api/funnel.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const claimFunnelToken = vi.fn();
const claimInstall = vi.fn();
const claimViaEmail = vi.fn(async () => {});
vi.mock("../core/native", () => ({
  getNative: () => ({ claimFunnelToken, claimInstall, claimViaEmail }),
}));

import { claimFunnelToken as cft, claimInstall as ci } from "./funnel";

describe("funnel claim", () => {
  beforeEach(() => { claimFunnelToken.mockReset(); claimInstall.mockReset(); });

  it("parses funnel_answers_json into funnelAnswers", async () => {
    claimFunnelToken.mockResolvedValue({ subscriberId: "sub_1", funnelAnswersJson: '{"q1":"yes"}' });
    const r = await cft("tok");
    expect(r).toEqual({ subscriberId: "sub_1", funnelAnswers: { q1: "yes" } });
    expect(claimFunnelToken).toHaveBeenCalledWith("tok");
  });

  it("maps claimInstall null → null", async () => {
    claimInstall.mockResolvedValue(null);
    expect(await ci({ platform: "ios", locale: "en-US", timezone: "UTC", screenDims: "390x844" })).toBeNull();
  });

  it("maps claimInstall result → parsed", async () => {
    claimInstall.mockResolvedValue({ subscriberId: "sub_2", funnelAnswersJson: "{}" });
    const r = await ci({ platform: "android", locale: "en-US", timezone: "UTC", screenDims: "390x844", installReferrer: "x" });
    expect(r).toEqual({ subscriberId: "sub_2", funnelAnswers: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: FAIL — `Cannot find module './funnel'`.

- [ ] **Step 3: Create the API wrapper**

Create `packages/sdk-rn/src/api/funnel.ts`:

```typescript
import { getNative, getEmitter } from "../core/native";
import { mapNativeError } from "../errors";

export interface FunnelClaimResult {
  subscriberId: string;
  funnelAnswers: Record<string, unknown>;
}

export interface ClaimInstallParams {
  platform: "ios" | "android";
  locale: string;
  timezone: string;
  screenDims: string;       // "WIDTHxHEIGHT"
  deviceModel?: string;
  installReferrer?: string;
}

interface NativeClaim { subscriberId: string; funnelAnswersJson: string }

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

function parse(n: NativeClaim): FunnelClaimResult {
  let funnelAnswers: Record<string, unknown> = {};
  try { funnelAnswers = JSON.parse(n.funnelAnswersJson) as Record<string, unknown>; } catch { /* keep {} */ }
  return { subscriberId: n.subscriberId, funnelAnswers };
}

/** Claim a known funnel token (e.g. from a deep link). */
export async function claimFunnelToken(token: string): Promise<FunnelClaimResult> {
  return call(async () => parse(await getNative().claimFunnelToken(token)));
}

/** Recover + claim via install attribution. Resolves `null` when no match. */
export async function claimInstall(params: ClaimInstallParams): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimInstall(params)) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}

/** Kick off the email magic-link claim (resolves later via deep link). */
export async function claimViaEmail(email: string): Promise<void> {
  return call(() => getNative().claimViaEmail(email));
}

/** Persisted per-install id. */
export async function installId(): Promise<string> {
  return call(() => getNative().installId());
}

/** Subscribe to resolved funnel claims (direct calls + future auto-resolution). */
export function addFunnelClaimListener(cb: (result: FunnelClaimResult) => void): () => void {
  const sub = getEmitter().addListener("onFunnelClaimResolved", (p: NativeClaim) => cb(parse(p)));
  return () => sub.remove();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: PASS.

- [ ] **Step 5: Add error subclasses + mapping**

In `packages/sdk-rn/src/errors.ts`, add three subclasses (after `ReceiptInvalidError`):

```typescript
export class FunnelTokenNotFoundError extends RovenueError {
  constructor(message: string) { super("FunnelTokenNotFound", message); this.name = "FunnelTokenNotFoundError"; }
}
export class FunnelTokenExpiredError extends RovenueError {
  constructor(message: string) { super("FunnelTokenExpired", message); this.name = "FunnelTokenExpiredError"; }
}
export class FunnelTokenAlreadyClaimedError extends RovenueError {
  constructor(message: string) { super("FunnelTokenAlreadyClaimed", message); this.name = "FunnelTokenAlreadyClaimedError"; }
}
```

And add to the `mapNativeError` switch (before `default`):

```typescript
    case "FunnelTokenNotFound":       return new FunnelTokenNotFoundError(message);
    case "FunnelTokenExpired":        return new FunnelTokenExpiredError(message);
    case "FunnelTokenAlreadyClaimed": return new FunnelTokenAlreadyClaimedError(message);
```

- [ ] **Step 6: Extend the native module spec**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`, add to `RovenueModuleSpec` (near `track`):

```typescript
  // Funnel attribution claim
  claimFunnelToken(token: string): Promise<{ subscriberId: string; funnelAnswersJson: string }>;
  claimInstall(params: { platform: string; locale: string; timezone: string; screenDims: string; deviceModel?: string; installReferrer?: string }): Promise<{ subscriberId: string; funnelAnswersJson: string } | null>;
  claimViaEmail(email: string): Promise<void>;
  installId(): Promise<string>;
```

- [ ] **Step 7: Wire the public surface**

In `packages/sdk-rn/src/index.ts`:

Add the import (near other `./api/*`):

```typescript
import { claimFunnelToken, claimInstall, claimViaEmail, installId, addFunnelClaimListener } from "./api/funnel";
```

Add to the `Rovenue` object (after `track,`):

```typescript
  claimFunnelToken,
  claimInstall,
  claimViaEmail,
  installId,
  addFunnelClaimListener,
```

Export the types (near the existing `export type` lines):

```typescript
export type { FunnelClaimResult, ClaimInstallParams } from "./api/funnel";
```

- [ ] **Step 8: Typecheck + full suite**

Run: `cd packages/sdk-rn && pnpm build && pnpm test`
Expected: tsc=0 and all tests green (the new spec methods are present on the mock-native path; if `_mockNative` enumerates the spec, add no-op stubs for the four new methods to keep types satisfied — note it in the commit).

- [ ] **Step 9: Commit**

```bash
git add packages/sdk-rn/src/api/funnel.ts packages/sdk-rn/src/api/funnel.test.ts \
        packages/sdk-rn/src/errors.ts packages/sdk-rn/src/specs/RovenueModule.types.ts \
        packages/sdk-rn/src/index.ts packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): Rovenue funnel claim public API + onFunnelClaimResolved"
```

---

### Task 9: Version bumps + docs

**Files:**
- Modify: `Cargo.toml` (workspace version)
- Modify: `packages/sdk-rn/src/version.ts`
- Modify: `packages/sdk-rn/package.json`
- Modify: `apps/docs/content/docs/reference/methods.mdx`

- [ ] **Step 1: Bump crate version**

In the workspace `Cargo.toml` (`[workspace.package]` `version`), bump one minor (e.g. `0.9.0` → `0.10.0`). Match the current value.

- [ ] **Step 2: Keep TS SDK_VERSION in parity with the crate**

In `packages/sdk-rn/src/version.ts`, set `SDK_VERSION` to the new crate version (e.g. `"0.10.0"`).

- [ ] **Step 3: Bump the RN npm package**

In `packages/sdk-rn/package.json`, bump `version` one minor (e.g. `0.5.0` → `0.6.0`).

- [ ] **Step 4: Document the funnel claim methods**

In `apps/docs/content/docs/reference/methods.mdx`, add a `## Funnel Attribution` section (mirroring the existing per-method format — heading levels, `<Tabs>`/`<Tab>` groups, Params tables, Returns/Throws) documenting:
- `claimFunnelToken(token)` → `FunnelClaimResult` ({ subscriberId, funnelAnswers }); throws `FunnelTokenNotFoundError`/`FunnelTokenExpiredError`/`FunnelTokenAlreadyClaimedError`.
- `claimInstall(params)` → `FunnelClaimResult | null` (null = no match); params `{ platform, locale, timezone, screenDims, deviceModel?, installReferrer? }`.
- `claimViaEmail(email)` → `void` (kicks off magic-link; resolves later via deep link).
- `installId()` → `string`.
- `addFunnelClaimListener(cb)` → unsubscribe fn; fires on every resolved claim.
Add `[Funnel Attribution](#funnel-attribution)` to the quick-nav bar.

- [ ] **Step 5: Verify**

Run: `cargo build -p librovenue && cd packages/sdk-rn && pnpm test`
Expected: crate builds at the new version; sdk-rn tests pass (incl. version-parity test).

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json apps/docs/content/docs/reference/methods.mdx
git commit -m "chore(sdk): bump versions + document funnel claim methods"
```

---

## Self-Review

**Spec coverage:**
- §4 public surface (claimFunnelToken/claimInstall/claimViaEmail/addFunnelClaimListener) → Tasks 6–8.
- §5.1 funnel module + types + bus → Task 3; §5.2 install_id + state (V9) → Task 2; §5.3 api methods (refresh-after-claim, chain, callback) → Task 4; §5.4 entitlements via refresh → Task 4 `finish_claim`.
- §6 udl + 3 error variants → Tasks 3 (Rust enum) + 5 (udl); 404≠error for claim_install vs FunnelTokenNotFound for claim_funnel_token → Task 3 client mapping.
- §7 façades (Swift/Kotlin bridges + RN) → Tasks 6/7/8.
- §8 tests → every task; §9 versioning → Task 9.
- Status-aware transport (needed because `post_json` collapses 4xx) → Task 1 (not in the spec explicitly; added because the spec's 404/410/409 mapping is impossible on the existing primitive).

**Placeholder scan:** No TBD/TODO. Each code step shows complete code. Two adapt-to-harness notes are explicit (Task 7 Kotlin test harness; Task 8 `_mockNative` stubs) with what to mirror and the assertion required.

**Type consistency:** `FunnelClaimResult { subscriber_id, funnel_answers_json }` (Rust) ↔ udl dict ↔ Swift/Kotlin record ↔ native `{ subscriberId, funnelAnswersJson }` ↔ TS parses to `{ subscriberId, funnelAnswers }`. `ClaimInstallParams` fields consistent (snake_case Rust/udl `screen_dims`/`install_referrer` ↔ camelCase TS `screenDims`/`installReferrer`, mapped at the native boundary). `claim_install` returns `Option`/`| null` consistently. `register_funnel_claim_listener` / `FunnelClaimListener` / `on_funnel_claim_resolved` consistent across layers. Error codes `FunnelTokenNotFound`/`Expired`/`AlreadyClaimed` identical in Rust enum, udl, and TS `mapNativeError`.
