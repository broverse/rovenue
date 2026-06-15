# Subscriber Attributes — SDK Implementation Plan (2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose subscriber attributes through the SDK — a `setAttributes` batch method, typed reserved setters, and `flushAttributes()` — backed by a local SQLite dirty-mutation queue with batch flush, mirroring the existing session-event pipeline but with **durable** (not fire-and-forget) delivery.

**Architecture:** The Rust core (`packages/core-rs`) gains an `AttributeBuffer` (SQLite-backed queue) + `AttributeDispatcher` (batch flush to `POST /v1/me/attributes`). Unlike the session pipeline, the dispatcher **lists without deleting, posts, and deletes only on success** — attributes are user data and must survive transient network failures. Two new public methods (`set_attributes`, `flush_attributes`) are added to the UniFFI interface; the Swift/Kotlin/RN façades wrap them and add typed reserved sugar (`setEmail`, `setPushToken`, etc.).

**Tech Stack:** Rust (rusqlite, reqwest, UniFFI), Swift (SPM/XCTest), Kotlin (Gradle/JUnit), React Native (Expo modules + Jest).

**Spec:** `docs/superpowers/specs/2026-06-15-subscriber-attributes-design.md` (§6, §7)
**Depends on:** Plan 1 (backend) — `POST /v1/me/attributes` accepting `{attributes: {key: string|null}}` is already shipped.

---

## Key design decisions (read before starting)

1. **Durable, not fire-and-forget.** The session dispatcher drains (deletes) THEN posts and drops on failure. Attributes must NOT drop on transient failure. The attribute dispatcher: `list(limit)` → POST → `delete(ids)` only on `Ok`. On any `Err`, rows stay queued for the next flush.
2. **Core stays minimal.** The core exposes only `set_attributes(map)` and `flush_attributes()`. Reserved-key sugar (`setEmail`, `setPushToken` → `$apnsTokens`/`$fcmTokens` per platform) lives in the native façades where the platform is known.
3. **No client-side catalog validation in v1.** The server validates (Plan 1) and returns `VALIDATION_ERROR`. Client-side validation is deferred (YAGNI); the FIFO 1000-row cap is the backstop against unbounded queue growth. Documented as a known limitation.
4. **Endpoint reuse.** Flush targets the existing `POST /v1/me/attributes` with the public key + `X-Rovenue-App-User-Id` user-scope header (same auth the session flush uses). No new endpoint.
6. **Flush triggers in v1 = 30s timer (foreground-gated) + manual `flushAttributes()`.** The spec §7 also lists background-transition, post-identify, and pre-purchase auto-flush. Those are NOT wired in v1: the dispatcher's `flush_once()` is a blocking network call, so calling it inline from `identify()`/`set_foreground()`/the purchase path would block those calls on I/O. The session pipeline has the same constraint and relies on the scheduler thread. Auto-flush on those events (via a scheduler one-shot trigger) is deferred; until then the app calls `flushAttributes()` (async on the façades, runs off the calling thread) before a purchase or after login if it needs immediacy.
5. **Coalescing.** When building the flush body, drained rows are applied in `id ASC` order so a later set of the same key overwrites an earlier one (last-write-wins within a batch). `value = NULL` means delete.

---

## File Structure

**Create:**
- `packages/core-rs/src/attributes/mod.rs` — module root.
- `packages/core-rs/src/attributes/buffer.rs` — `AttributeBuffer` (set/list/delete/clear).
- `packages/core-rs/src/attributes/dispatcher.rs` — `AttributeDispatcher` (flush_once/start).
- `packages/sdk-rn/src/api/attributes.ts` — RN TS wrapper.

**Modify:**
- `packages/core-rs/src/cache/schema.rs` — add `MIGRATION_V6` (attribute_mutations table), bump `LATEST`, extend `MIGRATIONS`.
- `packages/core-rs/src/cache/store.rs` — attribute-mutation CRUD + `AttributeMutationRow`.
- `packages/core-rs/src/transport/http_client.rs` — `post_attributes`.
- `packages/core-rs/src/api.rs` — struct fields, wiring, `set_attributes`, `flush_attributes`, logout clear.
- `packages/core-rs/src/lib.rs` — `mod attributes;`.
- `packages/core-rs/src/librovenue.udl` — `set_attributes` + `flush_attributes`.
- `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` — `setAttributes` + reserved setters + `flushAttributes`.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — same.
- `packages/sdk-rn/src/specs/RovenueModule.types.ts` — method signatures.
- `packages/sdk-rn/src/index.ts` — export new methods.
- Version bumps: `packages/core-rs/Cargo.toml`, `packages/sdk-kotlin/build.gradle.kts`, `packages/sdk-rn/package.json`.

**Test:**
- Rust `#[cfg(test)]` modules in `buffer.rs` and `dispatcher.rs`.
- `packages/sdk-swift/Tests/RovenueTests/AttributesTests.swift`
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/AttributesTest.kt`
- `packages/sdk-rn/src/api/attributes.test.ts` (or the repo's RN test location)

---

## Task 1: SQLite migration + store CRUD for attribute mutations

**Files:**
- Modify: `packages/core-rs/src/cache/schema.rs`
- Modify: `packages/core-rs/src/cache/store.rs`

- [ ] **Step 1: Add the failing store test**

Append to the `#[cfg(test)]` module in `packages/core-rs/src/cache/store.rs` (mirror the existing session-event store tests):

```rust
#[test]
fn attribute_mutations_crud() {
    let store = CacheStore::open_in_memory().unwrap();
    store.append_attribute_mutation("$email", Some("a@b.com")).unwrap();
    store.append_attribute_mutation("favoriteTeam", Some("GS")).unwrap();
    store.append_attribute_mutation("country", None).unwrap(); // delete marker

    let rows = store.list_attribute_mutations(100).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].key, "$email");
    assert_eq!(rows[0].value.as_deref(), Some("a@b.com"));
    assert_eq!(rows[2].key, "country");
    assert_eq!(rows[2].value, None);

    let ids: Vec<i64> = rows.iter().take(2).map(|r| r.id).collect();
    store.delete_attribute_mutations(&ids).unwrap();
    assert_eq!(store.list_attribute_mutations(100).unwrap().len(), 1);

    store.clear_attribute_mutations().unwrap();
    assert_eq!(store.list_attribute_mutations(100).unwrap().len(), 0);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p rovenue-core attribute_mutations_crud`
(Confirm the crate name from `packages/core-rs/Cargo.toml` — use that with `-p`.)
Expected: FAIL — methods/table don't exist.

- [ ] **Step 3: Add the migration**

In `packages/core-rs/src/cache/schema.rs`, following the EXACT format of the existing `MIGRATION_Vx` constants, add:

```rust
pub const MIGRATION_V6: &str = "\
CREATE TABLE attribute_mutations (\
    id INTEGER PRIMARY KEY AUTOINCREMENT,\
    key TEXT NOT NULL,\
    value TEXT\
);\
CREATE INDEX idx_attribute_mutations_id ON attribute_mutations(id);\
UPDATE schema_meta SET version = 6;\
";
```

**Important:** each `MIGRATION_Vx` in this crate ends with `UPDATE schema_meta SET version = x;` — the runner relies on the migration SQL bumping the version. Omitting it makes a reopened DB re-run V6 and crash on `CREATE TABLE … already exists` (the `reopens_existing_db_idempotently` test covers this). Match the V2–V5 format exactly.

Bump the latest-version constant from `5` to `6` and append `MIGRATION_V6` to the `MIGRATIONS` array (match the existing names — the grounding shows `LATEST = 5` and `MIGRATIONS = [MIGRATION_V1, …, MIGRATION_V5]`).

- [ ] **Step 4: Add the row struct + CRUD to store.rs**

Add near `SessionEventRow`:

```rust
#[derive(Debug, Clone)]
pub struct AttributeMutationRow {
    pub id: i64,
    pub key: String,
    /// None means "delete this key".
    pub value: Option<String>,
}
```

Add these methods to the `impl CacheStore` block, mirroring `append_session_event`/`list_session_events`/`delete_session_events`/`clear_session_events`:

```rust
pub fn append_attribute_mutation(
    &self,
    key: &str,
    value: Option<&str>,
) -> RovenueResult<()> {
    let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
    guard
        .execute(
            "INSERT INTO attribute_mutations (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .map_err(|_| RovenueError::Storage)?;
    // FIFO trim — keep newest 1000 (backstop for an endlessly-failing flush).
    guard
        .execute(
            "DELETE FROM attribute_mutations WHERE id NOT IN \
             (SELECT id FROM attribute_mutations ORDER BY id DESC LIMIT 1000)",
            [],
        )
        .map_err(|_| RovenueError::Storage)?;
    Ok(())
}

pub fn list_attribute_mutations(
    &self,
    limit: usize,
) -> RovenueResult<Vec<AttributeMutationRow>> {
    let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
    let mut stmt = guard
        .prepare(
            "SELECT id, key, value FROM attribute_mutations \
             ORDER BY id ASC LIMIT ?1",
        )
        .map_err(|_| RovenueError::Storage)?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok(AttributeMutationRow {
                id: r.get(0)?,
                key: r.get(1)?,
                value: r.get(2)?,
            })
        })
        .map_err(|_| RovenueError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RovenueError::Storage)?;
    Ok(rows)
}

pub fn delete_attribute_mutations(&self, ids: &[i64]) -> RovenueResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM attribute_mutations WHERE id IN ({})",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
    guard
        .execute(&sql, params.as_slice())
        .map_err(|_| RovenueError::Storage)?;
    Ok(())
}

pub fn clear_attribute_mutations(&self) -> RovenueResult<()> {
    let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
    guard
        .execute("DELETE FROM attribute_mutations", [])
        .map_err(|_| RovenueError::Storage)?;
    Ok(())
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cargo test -p rovenue-core attribute_mutations_crud`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/cache/schema.rs packages/core-rs/src/cache/store.rs
git commit -m "feat(core): attribute_mutations table + store CRUD"
```

---

## Task 2: AttributeBuffer

**Files:**
- Create: `packages/core-rs/src/attributes/mod.rs`
- Create: `packages/core-rs/src/attributes/buffer.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 1: Register the module**

In `packages/core-rs/src/lib.rs`, add alongside the other `mod` declarations:

```rust
mod attributes;
```

Create `packages/core-rs/src/attributes/mod.rs`:

```rust
pub mod buffer;
pub mod dispatcher;
```

- [ ] **Step 2: Write the failing test**

Create `packages/core-rs/src/attributes/buffer.rs` with the test first (mirror `sessions/buffer.rs` tests):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::store::CacheStore;
    use std::sync::Arc;

    #[test]
    fn set_appends_and_list_delete_roundtrip() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = AttributeBuffer::new(Arc::clone(&store));
        buf.set("$email", Some("a@b.com")).unwrap();
        buf.set("country", None).unwrap();

        let rows = buf.list(100).unwrap();
        assert_eq!(rows.len(), 2);

        buf.delete(&rows.iter().map(|r| r.id).collect::<Vec<_>>()).unwrap();
        assert_eq!(buf.list(100).unwrap().len(), 0);
    }

    #[test]
    fn clear_empties_the_queue() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = AttributeBuffer::new(Arc::clone(&store));
        buf.set("k", Some("v")).unwrap();
        buf.clear().unwrap();
        assert_eq!(buf.list(100).unwrap().len(), 0);
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cargo test -p rovenue-core attributes::buffer`
Expected: FAIL — `AttributeBuffer` undefined.

- [ ] **Step 4: Implement the buffer (above the test module)**

```rust
use std::sync::Arc;
use crate::cache::store::{AttributeMutationRow, CacheStore};
use crate::error::RovenueResult;

/// Local dirty-mutation queue for subscriber attributes. Unlike the
/// session buffer, callers `list` then `delete` separately so the
/// dispatcher can keep rows queued when a flush fails (attributes are
/// durable user data, not fire-and-forget telemetry).
pub struct AttributeBuffer {
    store: Arc<CacheStore>,
}

impl AttributeBuffer {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    /// Queue a single attribute mutation. `None` value means delete.
    pub fn set(&self, key: &str, value: Option<&str>) -> RovenueResult<()> {
        self.store.append_attribute_mutation(key, value)
    }

    pub fn list(&self, limit: usize) -> RovenueResult<Vec<AttributeMutationRow>> {
        self.store.list_attribute_mutations(limit)
    }

    pub fn delete(&self, ids: &[i64]) -> RovenueResult<()> {
        self.store.delete_attribute_mutations(ids)
    }

    pub fn clear(&self) -> RovenueResult<()> {
        self.store.clear_attribute_mutations()
    }
}
```

(Confirm the error module path — the grounding shows `RovenueResult`/`RovenueError`; match how `sessions/buffer.rs` imports them.)

- [ ] **Step 5: Run it to verify it passes**

Run: `cargo test -p rovenue-core attributes::buffer`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/attributes/mod.rs packages/core-rs/src/attributes/buffer.rs packages/core-rs/src/lib.rs
git commit -m "feat(core): AttributeBuffer (durable list/delete queue)"
```

---

## Task 3: HTTP client `post_attributes`

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs`

- [ ] **Step 1: Write the failing test**

Add to the http_client test module (mirror however `post_sessions` is tested — if it uses a mock server like `httpmock`/`wiremock`, follow that; otherwise add a unit test asserting body construction via a helper). Minimal behavioral test against the existing mock harness:

```rust
#[test]
fn post_attributes_sends_attributes_map_to_me_endpoint() {
    // Arrange a mock server that asserts:
    //   POST /v1/me/attributes
    //   header Authorization: Bearer <key>
    //   header X-Rovenue-App-User-Id: <sub_id>
    //   body { "attributes": { "$email": "a@b.com", "country": null } }
    // (Mirror the existing post_sessions mock test in this file.)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p rovenue-core post_attributes`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `post_attributes`**

Add next to `post_sessions`:

```rust
/// POST a batch of attribute mutations to /v1/me/attributes. The
/// subscriber is resolved server-side from the user-scope header.
/// `attributes` maps key -> Some(value) to set, or None to delete.
pub fn post_attributes(
    &self,
    subscriber_id: &str,
    attributes: &serde_json::Map<String, serde_json::Value>,
) -> RovenueResult<()> {
    let body = serde_json::json!({ "attributes": attributes });
    let _resp = self.post_json::<serde_json::Value, serde_json::Value>(
        super::types::HttpPostRequest::new("/v1/me/attributes").user_scope(subscriber_id),
        &body,
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p rovenue-core post_attributes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs
git commit -m "feat(core): http_client.post_attributes -> POST /v1/me/attributes"
```

---

## Task 4: AttributeDispatcher (durable flush)

**Files:**
- Modify: `packages/core-rs/src/attributes/dispatcher.rs` (created empty in Task 2's mod.rs — create the file now)

- [ ] **Step 1: Write the failing test**

Create `packages/core-rs/src/attributes/dispatcher.rs` with tests mirroring `sessions/dispatcher.rs`, but asserting the DURABLE semantics:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::attributes::buffer::AttributeBuffer;
    use crate::cache::store::CacheStore;
    use std::sync::Arc;

    #[test]
    fn flush_noops_without_subscriber_id() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        // http that would panic if called; provider returns None
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            /* http */ test_http_unreachable(),
            Box::new(|| None),
        );
        assert_eq!(dispatcher.flush_once().unwrap(), 0);
        // queue is preserved
        assert_eq!(buf.list(100).unwrap().len(), 1);
    }

    #[test]
    fn flush_deletes_only_on_success() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        buf.set("country", None).unwrap();
        // mock http returning Ok; provider returns Some("rov_x")
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            test_http_ok(), // asserts body { attributes: { $email: "a@b.com", country: null } }
            Box::new(|| Some("rov_x".to_string())),
        );
        assert_eq!(dispatcher.flush_once().unwrap(), 2);
        assert_eq!(buf.list(100).unwrap().len(), 0);
    }

    #[test]
    fn flush_keeps_queue_on_network_error() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            test_http_network_error(),
            Box::new(|| Some("rov_x".to_string())),
        );
        assert!(dispatcher.flush_once().is_err());
        // NOT deleted — durable retry
        assert_eq!(buf.list(100).unwrap().len(), 1);
    }
}
```

> The `test_http_*` helpers depend on how `sessions/dispatcher.rs` injects/mocks its `HttpClient`. Inspect that file and mirror its exact test seam (it may take an `Arc<HttpClient>` pointed at a mock server, or a trait object). Use the SAME mechanism here. If sessions uses a real `HttpClient` against a mock server, build the dispatcher with that and assert queue state after.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p rovenue-core attributes::dispatcher`
Expected: FAIL — `AttributeDispatcher` undefined.

- [ ] **Step 3: Implement the dispatcher**

```rust
use std::sync::Arc;
use std::time::Duration;
use crate::attributes::buffer::AttributeBuffer;
use crate::error::RovenueResult;
use crate::polling::scheduler::PollingScheduler;
use crate::transport::http_client::HttpClient;

/// Returns the current subscriber id, or None when no subscriber is
/// established yet (flush is a no-op in that case).
pub type SubscriberIdProvider = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct AttributeDispatcher {
    buffer: Arc<AttributeBuffer>,
    http: Arc<HttpClient>,
    subscriber_id_provider: SubscriberIdProvider,
}

impl AttributeDispatcher {
    pub fn new(
        buffer: Arc<AttributeBuffer>,
        http: Arc<HttpClient>,
        subscriber_id_provider: SubscriberIdProvider,
    ) -> Self {
        Self { buffer, http, subscriber_id_provider }
    }

    /// List → POST → delete-on-success. Returns the number of mutations
    /// flushed. On any error the queue is left intact for retry.
    pub fn flush_once(&self) -> RovenueResult<usize> {
        let Some(sub_id) = (self.subscriber_id_provider)() else {
            return Ok(0);
        };
        let rows = self.buffer.list(200)?;
        if rows.is_empty() {
            return Ok(0);
        }
        // Coalesce in id ASC order: later set of the same key wins.
        let mut map = serde_json::Map::new();
        for r in &rows {
            let v = match &r.value {
                Some(s) => serde_json::Value::String(s.clone()),
                None => serde_json::Value::Null,
            };
            map.insert(r.key.clone(), v);
        }
        // Post first; only delete if it succeeded (durable).
        self.http.post_attributes(&sub_id, &map)?;
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        self.buffer.delete(&ids)?;
        Ok(rows.len())
    }

    /// Register the periodic flush on the scheduler (30s, same cadence
    /// as sessions; only fires while foregrounded).
    pub fn start(self: Arc<Self>, scheduler: &PollingScheduler) {
        let me = Arc::clone(&self);
        scheduler.register("attributes", Duration::from_secs(30), move || {
            let _ = me.flush_once();
        });
    }
}
```

(Match the exact import paths to how `sessions/dispatcher.rs` imports `HttpClient`, `PollingScheduler`, and the error type.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p rovenue-core attributes::dispatcher`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/attributes/dispatcher.rs
git commit -m "feat(core): AttributeDispatcher with durable delete-on-success flush"
```

---

## Task 5: Wire into RovenueCore + public methods

**Files:**
- Modify: `packages/core-rs/src/api.rs`

- [ ] **Step 1: Write the failing test**

Add an api-level test (mirror existing api.rs tests that construct a core with `open_in_memory`). Assert that `set_attributes` queues and `flush_attributes` is a no-op without a subscriber, and that `log_out` clears the queue:

```rust
#[test]
fn set_attributes_queues_and_logout_clears() {
    let core = test_core_in_memory(); // mirror existing api.rs test constructor
    let mut m = std::collections::HashMap::new();
    m.insert("$email".to_string(), Some("a@b.com".to_string()));
    m.insert("country".to_string(), None);
    core.set_attributes(m).unwrap();
    // queued (2 rows)
    assert_eq!(core.debug_attribute_queue_len(), 2); // add a test-only accessor if needed, or assert via store
    core.log_out().unwrap();
    assert_eq!(core.debug_attribute_queue_len(), 0);
}
```

> If adding a `debug_*` accessor is undesirable, assert against the `CacheStore` directly the way other api.rs tests inspect internal state. Match the existing test style.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p rovenue-core set_attributes_queues`
Expected: FAIL — `set_attributes` undefined.

- [ ] **Step 3: Add struct fields + wiring**

In the `RovenueCore` struct, add:

```rust
    attributes: Arc<AttributeBuffer>,
    attribute_dispatcher: Arc<AttributeDispatcher>,
```

In the constructor (`from_store`/`new` — wherever `SessionBuffer`/`SessionDispatcher` are built and the dispatcher's `.start(&scheduler)` is called), build and start the attribute pipeline the same way:

```rust
    let attributes = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
    let attribute_dispatcher = Arc::new(AttributeDispatcher::new(
        Arc::clone(&attributes),
        Arc::clone(&http), // same Arc<HttpClient> the session dispatcher uses
        {
            let identity = Arc::clone(&identity);
            Box::new(move || identity.subscriber_id_for_flush()) // mirror however sessions' provider reads the id
        },
    ));
    Arc::clone(&attribute_dispatcher).start(&scheduler);
```

> Use the SAME subscriber-id source the session dispatcher uses for its provider. Find it in the constructor and reuse it verbatim so both pipelines agree on when there's a flushable subscriber.

Add the two fields to the struct initializer.

- [ ] **Step 4: Add the public methods + logout clear**

```rust
/// Queue a batch of attribute mutations. `None` value deletes the key.
/// Written locally immediately; flushed to the server in the background
/// (30s tick / foreground / manual flush_attributes).
pub fn set_attributes(
    &self,
    attributes: std::collections::HashMap<String, Option<String>>,
) -> RovenueResult<()> {
    for (key, value) in attributes.iter() {
        self.attributes.set(key, value.as_deref())?;
    }
    Ok(())
}

/// Force an immediate flush. Returns the number of mutations sent.
pub fn flush_attributes(&self) -> RovenueResult<usize> {
    self.attribute_dispatcher.flush_once()
}
```

In `log_out` (after `self.sessions.clear()`), add:

```rust
    let _ = self.attributes.clear();
```

Add the imports: `use crate::attributes::buffer::AttributeBuffer;` and `use crate::attributes::dispatcher::AttributeDispatcher;`.

- [ ] **Step 5: Run it to verify it passes**

Run: `cargo test -p rovenue-core set_attributes_queues` then `cargo test -p rovenue-core` (full crate).
Expected: PASS; whole crate green.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/api.rs
git commit -m "feat(core): wire attribute pipeline + set_attributes/flush_attributes"
```

---

## Task 6: Expose via UniFFI

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`

- [ ] **Step 1: Add the interface methods**

In the `interface RovenueCore { … }` block in `librovenue.udl`, add (matching the existing `[Throws=RovenueError]` style):

```
    [Throws=RovenueError]
    void set_attributes(record<DOMString, string?> attributes);

    [Throws=RovenueError]
    u32 flush_attributes();
```

> Confirm the UDL's map syntax against an existing map/record usage in the file. If the project's UniFFI version prefers `record<string, string?>`, match the existing convention in the file. The Rust signature must line up: `HashMap<String, Option<String>>` ↔ `record<DOMString, string?>`, and `flush_attributes -> RovenueResult<usize>` exposed as `u32` (cast `usize as u32` if the generated binding requires it — adjust the Rust return type to `u32` if needed).

- [ ] **Step 2: Regenerate + build the core**

Run: `cargo build -p librovenue`
Expected: builds clean; UniFFI scaffolding regenerates. Regenerate the native bindings with `packages/core-rs/scripts/build-bindings.sh` (builds the release dylib + `rovenue-uniffi-bindgen`, then generates Swift + Kotlin). **Note:** the generated binding files (`Generated/RovenueFFI.swift`, `generated/librovenue.kt`) are **gitignored** in this repo (only `.gitkeep` is tracked) — they are regenerated at build time, so this commit contains only the `.udl` source. Still RUN the generation to confirm `setAttributes`/`flushAttributes` appear in both generated files before moving on. (swiftformat/ktlint "NotFound" warnings are cosmetic.)

- [ ] **Step 3: Commit**

```bash
git add packages/core-rs/src/librovenue.udl
git commit -m "feat(core): expose set_attributes/flush_attributes via UniFFI"
```

---

## Task 7: Swift façade

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/AttributesTests.swift`
- Modify: `packages/sdk-swift/Package.swift` or version file if versioned

- [ ] **Step 1: Write the failing test**

Create `AttributesTests.swift` (mirror `IdentityTests.swift`):

```swift
import XCTest
@testable import Rovenue

final class AttributesTests: XCTestCase {
    func test_setAttributes_doesNotThrow_whenConfigured() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")
        try await Rovenue.shared.setAttributes(["$email": "a@b.com", "country": nil])
    }

    func test_setEmail_routesToEmailReservedKey() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")
        try await Rovenue.shared.setEmail("a@b.com")
        // (Behavioural: no throw. Deeper assertion requires a mock transport;
        //  match how IdentityTests verifies offline-safe calls.)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter AttributesTests`
Expected: FAIL — `setAttributes`/`setEmail` undefined.

- [ ] **Step 3: Implement the façade methods**

Add to `Rovenue.swift` (mirror the `identify` wrapper exactly — `dispatcher.run`, `mapError`, log emits):

```swift
public func setAttributes(_ attributes: [String: String?]) async throws {
    Self.emit(LogEntry(level: "info", message: "setAttributes"))
    do {
        try await dispatcher.run { [core] in
            do {
                try core.setAttributes(attributes: attributes)
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
        Self.emit(LogEntry(level: "info", message: "setAttributes ok"))
    } catch {
        Self.emit(LogEntry(level: "error", message: "setAttributes failed: \(error.localizedDescription)"))
        throw error
    }
}

public func setEmail(_ email: String?) async throws { try await setAttributes(["$email": email]) }
public func setDisplayName(_ name: String?) async throws { try await setAttributes(["$displayName": name]) }
public func setPhoneNumber(_ phone: String?) async throws { try await setAttributes(["$phoneNumber": phone]) }
/// iOS push token → the $apnsTokens reserved attribute.
public func setPushToken(_ token: String?) async throws { try await setAttributes(["$apnsTokens": token]) }

@discardableResult
public func flushAttributes() async throws -> UInt32 {
    try await dispatcher.run { [core] in
        do { return try core.flushAttributes() }
        catch let err as RovenueError { throw mapError(err) }
    }
}
```

> Match the exact `dispatcher.run` return-value handling used by an existing value-returning method (e.g. `currentUser` or `creditBalance`) for `flushAttributes`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/sdk-swift && swift test --filter AttributesTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/AttributesTests.swift
git commit -m "feat(sdk-swift): setAttributes + reserved setters + flushAttributes"
```

---

## Task 8: Kotlin façade

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/AttributesTest.kt`
- Modify: `packages/sdk-kotlin/build.gradle.kts` (version bump in Task 10)

- [ ] **Step 1: Write the failing test**

Create `AttributesTest.kt` (mirror `IdentityTest.kt`):

```kotlin
package dev.rovenue.sdk

import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class AttributesTest {
    @Test
    fun `setAttributes does not throw when configured`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        Rovenue.shared.setAttributes(mapOf("\$email" to "a@b.com", "country" to null))
    }

    @Test
    fun `setEmail routes to email reserved key`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        Rovenue.shared.setEmail("a@b.com")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew test --tests "dev.rovenue.sdk.AttributesTest"`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the façade methods**

Add to `Rovenue.kt` (mirror the `identify` suspend wrapper — `dispatcher.run`, emit logs):

```kotlin
@Throws(RovenueException::class)
suspend fun setAttributes(attributes: Map<String, String?>) {
    emit(LogEntry(level = "info", message = "setAttributes"))
    try {
        dispatcher.run { core.setAttributes(attributes) }
        emit(LogEntry(level = "info", message = "setAttributes ok"))
    } catch (e: Throwable) {
        emit(LogEntry(level = "error", message = "setAttributes failed: ${e.message ?: e.javaClass.simpleName}"))
        throw e
    }
}

@Throws(RovenueException::class)
suspend fun setEmail(email: String?) = setAttributes(mapOf("\$email" to email))
@Throws(RovenueException::class)
suspend fun setDisplayName(name: String?) = setAttributes(mapOf("\$displayName" to name))
@Throws(RovenueException::class)
suspend fun setPhoneNumber(phone: String?) = setAttributes(mapOf("\$phoneNumber" to phone))
/** Android push token → the $fcmTokens reserved attribute. */
@Throws(RovenueException::class)
suspend fun setPushToken(token: String?) = setAttributes(mapOf("\$fcmTokens" to token))

@Throws(RovenueException::class)
suspend fun flushAttributes(): UInt = dispatcher.run { core.flushAttributes() }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew test --tests "dev.rovenue.sdk.AttributesTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/AttributesTest.kt
git commit -m "feat(sdk-kotlin): setAttributes + reserved setters + flushAttributes"
```

---

## Task 9: React Native façade

**Files:**
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Create: `packages/sdk-rn/src/api/attributes.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Create: `packages/sdk-rn/src/api/attributes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/api/attributes.test.ts` (mirror the existing identity api test that uses `_setNativeForTesting`):

```typescript
import { _setNativeForTesting } from "../core/native";
import { setAttributes, setEmail, flushAttributes } from "./attributes";

describe("attributes api", () => {
  it("forwards setAttributes to the native module", async () => {
    const calls: any[] = [];
    _setNativeForTesting({
      setAttributes: async (a: Record<string, string | null>) => { calls.push(["setAttributes", a]); },
      setEmail: async (e: string | null) => { calls.push(["setEmail", e]); },
      flushAttributes: async () => { calls.push(["flushAttributes"]); return 3; },
    } as any);

    await setAttributes({ $email: "a@b.com", country: null });
    await setEmail("a@b.com");
    expect(await flushAttributes()).toBe(3);
    expect(calls).toEqual([
      ["setAttributes", { $email: "a@b.com", country: null }],
      ["setEmail", "a@b.com"],
      ["flushAttributes"],
    ]);
  });
});
```

> Confirm `_setNativeForTesting` exists on `core/native.ts` (the grounding mentions it). If the test seam differs, mirror an existing `src/api/*.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/sdk-rn test -- attributes`
Expected: FAIL — module `./attributes` doesn't exist.

- [ ] **Step 3: Add the spec signatures**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`, add to `RovenueModuleSpec`:

```typescript
  setAttributes(attributes: Record<string, string | null>): Promise<void>;
  setEmail(email: string | null): Promise<void>;
  setDisplayName(name: string | null): Promise<void>;
  setPhoneNumber(phone: string | null): Promise<void>;
  setPushToken(token: string | null): Promise<void>;
  flushAttributes(): Promise<number>;
```

- [ ] **Step 4: Create the wrapper module**

`packages/sdk-rn/src/api/attributes.ts`:

```typescript
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function setAttributes(attributes: Record<string, string | null>): Promise<void> {
  return call(() => getNative().setAttributes(attributes));
}
export async function setEmail(email: string | null): Promise<void> {
  return call(() => getNative().setEmail(email));
}
export async function setDisplayName(name: string | null): Promise<void> {
  return call(() => getNative().setDisplayName(name));
}
export async function setPhoneNumber(phone: string | null): Promise<void> {
  return call(() => getNative().setPhoneNumber(phone));
}
export async function setPushToken(token: string | null): Promise<void> {
  return call(() => getNative().setPushToken(token));
}
export async function flushAttributes(): Promise<number> {
  return call(() => getNative().flushAttributes());
}
```

- [ ] **Step 5: Export from index.ts**

In `packages/sdk-rn/src/index.ts`, import and add to the `Rovenue` object (mirror existing entries):

```typescript
import {
  setAttributes,
  setEmail,
  setDisplayName,
  setPhoneNumber,
  setPushToken,
  flushAttributes,
} from "./api/attributes";

export const Rovenue = {
  // ...existing methods...
  setAttributes,
  setEmail,
  setDisplayName,
  setPhoneNumber,
  setPushToken,
  flushAttributes,
};
```

(Preserve the existing object members exactly; just add these six.)

> Note: the RN package is a thin TS wrapper over the native module. The actual native module implementations (iOS Expo module Swift + Android Expo module Kotlin) must forward `setAttributes`/etc. to the Swift/Kotlin façades from Tasks 7-8. Check `packages/sdk-rn/ios` and `packages/sdk-rn/android` for the Expo module; add the bridging methods there following how `identify` is bridged. If that bridging is generated/uniform, this may be automatic — verify by grepping the native module for `identify`.

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @rovenue/sdk-rn test -- attributes`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src
git commit -m "feat(sdk-rn): setAttributes + reserved setters + flushAttributes"
```

---

## Task 10: Native RN bridge + version bumps + full SDK sweep

**Files:**
- Modify: `packages/sdk-rn/ios/*` and `packages/sdk-rn/android/*` (Expo module bridge, if not automatic)
- Modify: `packages/core-rs/Cargo.toml`, `packages/sdk-kotlin/build.gradle.kts`, `packages/sdk-rn/package.json`

- [ ] **Step 1: Bridge the native RN module methods**

Grep the RN native module for `identify` to see how a method is bridged to the Swift/Kotlin façade:

Run: `grep -rn "identify" packages/sdk-rn/ios packages/sdk-rn/android`
Add the equivalent bridge functions for `setAttributes`, `setEmail`, `setDisplayName`, `setPhoneNumber`, `setPushToken`, `flushAttributes`, forwarding to the façade methods added in Tasks 7-8. Follow the exact pattern (Expo `Function`/`AsyncFunction` definitions).

- [ ] **Step 2: Bump versions to 0.7.0 (core/kotlin) / 0.3.0 (rn)**

> Per the memory note, the RN package (0.2.0) trails core/Swift/Kotlin (0.6.0). Bump core-rs + Kotlin from 0.6.0 → 0.7.0, and RN from 0.2.0 → 0.3.0. Confirm Swift's version source (SPM tag — may be release-tagged, not in a file; skip if so).

- `packages/core-rs/Cargo.toml`: `version = "0.7.0"`
- `packages/sdk-kotlin/build.gradle.kts`: version → `0.7.0`
- `packages/sdk-rn/package.json`: `"version": "0.3.0"`

- [ ] **Step 3: Full SDK build + test sweep**

```bash
cargo test -p rovenue-core
cd packages/sdk-swift && swift test
cd packages/sdk-kotlin && ./gradlew test
pnpm --filter @rovenue/sdk-rn test
```

Expected: all green. Fix any binding-signature mismatches (the most likely failure is a UniFFI type mismatch between `record<DOMString, string?>` and `HashMap<String, Option<String>>`, or `u32` vs `usize` on `flushAttributes`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(sdk): bridge RN attribute methods + version bumps"
```

---

## Notes / handoffs

- **Plan 3 (Dashboard):** independent of this plan.
- **Deferred (post-v1):** client-side catalog validation in the SDK (currently server-only); `collectDeviceIdentifiers()` / `$idfa`/`$idfv`/`$attConsentStatus` auto-collection (needs native ATT/AdSupport permission APIs — a separate native effort); `setAttributionData` typed helper (callers can use `setAttributes` with the `$mediaSource`/`$campaign`/… keys directly until then).
- **Durability limitation:** a persistently server-rejected mutation (e.g. an unknown `$`-reserved key → 400) is retried every flush and only evicted by the 1000-row FIFO cap. Acceptable for v1; client-side validation (deferred) would close it.
```
