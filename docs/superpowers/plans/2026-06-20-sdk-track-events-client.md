# SDK `track()` Event Client Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a single generic `Rovenue.track(eventType, params?)` method through every SDK layer so apps can emit events to the already-implemented `POST /v1/events` backend.

**Architecture:** Reuse the M7 wire types (`EventEnvelope`/`IdentityContext` in Rust + TS) and the existing `serializeEnvelope()` TS serialiser. The envelope crosses the FFI boundary as a JSON string, so the Swift/Kotlin façades only pass a `String` through. Rust core deserializes, auto-fills `subscriberId` from the current scope when absent, and POSTs fire-and-forget via the existing 3-retry `HttpClient`. `occurredAt` is stamped in the TS layer (`isoNow()`), matching `record_session_event`.

**Tech Stack:** Rust (core-rs, uniffi 0.25.3, reqwest blocking, mockito tests), Swift façade (sdk-swift) + Expo module (sdk-rn/ios), Kotlin façade (sdk-kotlin) + Expo module (sdk-rn/android), TypeScript (sdk-rn/src, Vitest).

## Global Constraints

- Stay on the current git branch; never switch/create branches or worktrees. Commit on whatever HEAD is checked out.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Do NOT recreate `EventEnvelope` / `IdentityContext` (Rust: `packages/core-rs/src/events/`; TS: `packages/sdk-rn/src/events.ts`) — they exist and are re-exported. Reuse them.
- Backend payload schema is authoritative (camelCase): `{ eventType, occurredAt, subscriberId?, productId?, amount?, currency?, eventSourceUrl?, identityContext?{ email, externalId, phone, ip, userAgent, firstName, lastName, city, countryCode } }`. Unknown top-level keys are stripped by Zod; do not add fields outside this set.
- `platform` is NOT a payload field — it travels via the existing `X-Rovenue-Platform` header on POST. Do not add it to the envelope.
- uniffi-generated Swift/Kotlin bindings are gitignored build artifacts; regenerate with `npm run sdk:bindings`, never hand-edit generated files.
- Verify Kotlin via `testDebugUnitTest` (not just `compileReleaseKotlin`).

---

### Task 1: Transport fix — `post_json` treats 202 as bodyless

`POST /v1/events` returns `c.body(null, 202)` (empty body). `classify()` maps 202 → `Success`, but `post_json` only skips body parsing for `204`, so it calls `resp.json()` on the empty 202 body and returns `RovenueError::Internal` on every successful event POST. Fix the no-body condition.

**Files:**
- Modify: `packages/core-rs/src/transport/http_client.rs:281`
- Test: `packages/core-rs/src/transport/http_client.rs` (new `#[cfg(test)]` module at end of file)

**Interfaces:**
- Consumes: existing `HttpClient::post_json` / `HttpPostRequest`.
- Produces: `post_json` returns `Ok(HttpResponse{ body: None })` for a 202 response (relied on by Task 2's `EventsClient::post`).

- [ ] **Step 1: Write the failing test**

Append to `packages/core-rs/src/transport/http_client.rs`:

```rust
#[cfg(test)]
mod post_json_tests {
    use super::*;
    use super::super::types::HttpPostRequest;

    #[test]
    fn post_json_accepts_empty_202_body() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .with_status(202)
            .create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({ "eventType": "x", "occurredAt": "2026-06-20T00:00:00Z" });
        let resp = client
            .post_json::<serde_json::Value, serde_json::Value>(
                HttpPostRequest::new("/v1/events"),
                &body,
            )
            .expect("202 must be Ok");

        assert_eq!(resp.status, 202);
        assert!(resp.body.is_none());
        m.assert();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue post_json_accepts_empty_202_body -- --nocapture`
Expected: FAIL — `post_json` returns `Err(Internal)` (panics on `.expect("202 must be Ok")`).

- [ ] **Step 3: Apply the fix**

In `post_json` (the `RetryDecision::Success` branch, currently line 281), change:

```rust
                        RetryDecision::Success => {
                            let body = if status == 204 {
                                None
```

to:

```rust
                        RetryDecision::Success => {
                            // 202 Accepted (and 204) carry no body — the events
                            // endpoint returns an empty 202. Parsing would fail.
                            let body = if status == 204 || status == 202 {
                                None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue post_json_accepts_empty_202_body`
Expected: PASS

- [ ] **Step 5: Run the transport + api suites to confirm no regression**

Run: `cargo test -p librovenue transport:: && cargo test -p librovenue api::`
Expected: PASS (existing `post_apple_receipt` / sessions / attributes tests still green — they use 200/discard bodies).

- [ ] **Step 6: Commit**

```bash
git add packages/core-rs/src/transport/http_client.rs
git commit -m "fix(core-rs): treat HTTP 202 as bodyless in post_json

The /v1/events endpoint returns an empty 202; post_json only skipped body
parsing for 204, so it errored on success. 202 Accepted is conventionally
empty."
```

---

### Task 2: `EventsClient` — thin POST client for `/v1/events`

**Files:**
- Create: `packages/core-rs/src/events/client.rs`
- Modify: `packages/core-rs/src/events/mod.rs`
- Test: in `client.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Consumes: `HttpClient::post_json` (Task 1), `EventEnvelope` (`crate::events::EventEnvelope`), `HttpPostRequest`.
- Produces: `EventsClient::new(http: Arc<HttpClient>) -> EventsClient` and `EventsClient::post(&self, envelope: &EventEnvelope, scope: Option<&str>) -> RovenueResult<()>` — consumed by Task 3's `RovenueCore::track`.

- [ ] **Step 1: Write the failing test (create the file with test first)**

Create `packages/core-rs/src/events/client.rs`:

```rust
use std::sync::Arc;

use crate::error::RovenueResult;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::EventEnvelope;

/// Thin client for `POST /v1/events`. Fire-and-forget: any 2xx (the route
/// returns an empty 202) is success and the response body is ignored.
pub struct EventsClient {
    http: Arc<HttpClient>,
}

impl EventsClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// POST the serialized envelope to `/v1/events`. The optional `scope`
    /// travels in the `X-Rovenue-App-User-Id` header (forwarded server-side);
    /// the subscriber identity is also embedded in the envelope body.
    pub fn post(&self, envelope: &EventEnvelope, scope: Option<&str>) -> RovenueResult<()> {
        let mut req = HttpPostRequest::new("/v1/events");
        if let Some(s) = scope {
            req = req.user_scope(s);
        }
        let _ = self
            .http
            .post_json::<EventEnvelope, serde_json::Value>(req, envelope)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::IdentityContext;

    fn envelope() -> EventEnvelope {
        EventEnvelope {
            event_type: "purchase".into(),
            occurred_at: "2026-06-20T10:00:00Z".into(),
            subscriber_id: Some("user_42".into()),
            product_id: None,
            amount: Some("9.99".into()),
            currency: Some("USD".into()),
            event_source_url: None,
            identity_context: Some(IdentityContext {
                email: Some("a@b.com".into()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn post_sends_camelcase_envelope_and_omits_none() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::JsonString(
                r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"user_42","amount":"9.99","currency":"USD","identityContext":{"email":"a@b.com"}}"#.into(),
            ))
            .with_status(202)
            .create();

        let http = Arc::new(HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1));
        EventsClient::new(http)
            .post(&envelope(), Some("user_42"))
            .expect("post ok");

        m.assert();
    }
}
```

- [ ] **Step 2: Wire the module**

In `packages/core-rs/src/events/mod.rs`, add below the existing `pub mod` lines:

```rust
pub mod client;

pub use client::EventsClient;
```

(Keep the existing `pub mod envelope;`, `pub mod identity_context;`, and their re-exports.)

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test -p librovenue events::client`
Expected: PASS (asserts the camelCase body, `None` fields absent, 202 accepted).

- [ ] **Step 4: Commit**

```bash
git add packages/core-rs/src/events/client.rs packages/core-rs/src/events/mod.rs
git commit -m "feat(core-rs): add EventsClient POSTing envelopes to /v1/events"
```

---

### Task 3: `RovenueCore::track` — deserialize, auto-fill subscriber, POST

**Files:**
- Modify: `packages/core-rs/src/api.rs` (imports; `RovenueCore` struct field; constructor; new `track` method; tests)

**Interfaces:**
- Consumes: `EventsClient` (Task 2), `EventEnvelope`, `self.identity.current_user_scope()` (returns `String`, empty when unset).
- Produces: `RovenueCore::track(&self, envelope_json: String) -> RovenueResult<()>` — exported via udl in Task 4 and called by the façades.

- [ ] **Step 1: Write the failing tests**

In `packages/core-rs/src/api.rs`, inside the existing `#[cfg(test)] mod tests` block (which already defines `make_core`), add:

```rust
    #[test]
    #[serial_test::serial]
    fn track_auto_fills_subscriber_from_scope() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::JsonString(
                r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"user_42"}"#.into(),
            ))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        // identify() writes app_user_id locally even if its own POST fails.
        core.identify("user_42".into()).unwrap();

        core.track(
            r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z"}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_preserves_explicit_subscriber_id() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::JsonString(
                r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"explicit_sub"}"#.into(),
            ))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        core.identify("user_42".into()).unwrap();

        core.track(
            r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"explicit_sub"}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_rejects_malformed_json() {
        let core = make_core("http://127.0.0.1:1");
        let err = core.track("not json".into()).unwrap_err();
        assert!(matches!(err, RovenueError::InvalidArgument));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p librovenue track_`
Expected: FAIL — `no method named track found for struct RovenueCore`.

- [ ] **Step 3: Add the import**

In `packages/core-rs/src/api.rs`, with the other `use crate::...` imports (near `use crate::entitlements::{...}`), add:

```rust
use crate::events::EventsClient;
```

- [ ] **Step 4: Add the struct field**

In the `pub struct RovenueCore { ... }` definition, add after `receipts: Arc<ReceiptClient>,`:

```rust
    events: Arc<EventsClient>,
```

- [ ] **Step 5: Construct it**

In `from_store_with_http_max_attempts`, after `let receipts = Arc::new(ReceiptClient::new(Arc::clone(&http)));`, add:

```rust
        let events = Arc::new(EventsClient::new(Arc::clone(&http)));
```

Then add `events,` to the `Self { ... }` literal (place it next to `receipts,`).

- [ ] **Step 6: Implement `track`**

In `impl RovenueCore`, add after `post_google_receipt` (before `finish_receipt`):

```rust
    /// Emit a generic event to `POST /v1/events` (fire-and-forget, 3-retry).
    /// `envelope_json` is the camelCase wire envelope built by the façade.
    /// When the envelope omits `subscriberId`, it is filled from the current
    /// scope (`app_user_id` if identified, else the anonymous `rovenue_id`).
    pub fn track(&self, envelope_json: String) -> RovenueResult<()> {
        let mut envelope: crate::events::EventEnvelope =
            serde_json::from_str(&envelope_json).map_err(|_| RovenueError::InvalidArgument)?;

        let scope = self.identity.current_user_scope();
        let scope_opt = if scope.is_empty() { None } else { Some(scope) };

        if envelope.subscriber_id.is_none() {
            envelope.subscriber_id = scope_opt.clone();
        }

        self.events.post(&envelope, scope_opt.as_deref())
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p librovenue track_`
Expected: PASS (3 tests: auto-fill, explicit-preserve, malformed-rejects).

- [ ] **Step 8: Commit**

```bash
git add packages/core-rs/src/api.rs
git commit -m "feat(core-rs): add RovenueCore::track with subscriber auto-fill"
```

---

### Task 4: Export `track` via uniffi `.udl` + regenerate bindings

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`

**Interfaces:**
- Consumes: `RovenueCore::track` (Task 3).
- Produces: uniffi-generated `RovenueCore.track(envelopeJson:)` (Swift) / `track(envelopeJson)` (Kotlin) — consumed by Tasks 5 & 6.

- [ ] **Step 1: Add the method to the udl interface**

In `packages/core-rs/src/librovenue.udl`, inside `interface RovenueCore { ... }`, add after the `flush_session_events` block (around line 164):

```
    [Throws=RovenueError]
    void track(string envelope_json);
```

- [ ] **Step 2: Verify the core compiles with scaffolding**

Run: `cargo build -p librovenue`
Expected: PASS — scaffolding regenerates and binds `track` (the Rust method signature matches `void track(string envelope_json)`).

- [ ] **Step 3: Regenerate the Swift/Kotlin bindings**

Run: `npm run sdk:bindings`
Expected: PASS — generated (gitignored) Swift/Kotlin now expose `track`. Do not stage generated files.

- [ ] **Step 4: Commit**

```bash
git add packages/core-rs/src/librovenue.udl
git commit -m "feat(core-rs): export track(envelope_json) over uniffi"
```

---

### Task 5: Swift façade + Expo module `track`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (façade wrapper)
- Modify: `packages/sdk-rn/ios/RovenueModule.swift` (Expo `AsyncFunction`)

**Interfaces:**
- Consumes: generated `core.track(envelopeJson:)` (Task 4); existing `dispatcher.run`, `mapError`.
- Produces: `Rovenue.shared.track(envelopeJson:)` (Swift) and the JS-callable `track` native function — consumed by Task 7.

- [ ] **Step 1: Add the façade wrapper**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, add next to `recordSessionEvent` (around line 421), mirroring its shape:

```swift
    public func track(envelopeJson: String) async throws {
        try await dispatcher.run { [core] in
            do {
                try core.track(envelopeJson: envelopeJson)
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
    }
```

- [ ] **Step 2: Add the Expo module function**

In `packages/sdk-rn/ios/RovenueModule.swift`, add next to `recordSessionEvent` (around line 182):

```swift
        AsyncFunction("track") { (envelopeJson: String) in
            try await Rovenue.shared.track(envelopeJson: envelopeJson)
        }
```

- [ ] **Step 3: Build the Swift package to verify**

Run: `cd packages/sdk-swift && swift build`
Expected: PASS — `track` resolves against the regenerated `RovenueCore`.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-swift,sdk-rn): expose track() through Swift facade + Expo module"
```

---

### Task 6: Kotlin façade + Expo module `track`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (façade wrapper)
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` (Expo `AsyncFunction`)

**Interfaces:**
- Consumes: generated `core.track(envelopeJson)` (Task 4); existing `dispatcher.run`.
- Produces: `Rovenue.shared.track(envelopeJson)` (Kotlin) and the JS-callable `track` native function — consumed by Task 7.

- [ ] **Step 1: Add the façade wrapper**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, add next to `recordSessionEvent` (around line 451):

```kotlin
    @Throws(RovenueException::class)
    suspend fun track(envelopeJson: String) {
        dispatcher.run { core.track(envelopeJson) }
    }
```

- [ ] **Step 2: Add the Expo module function**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, add next to `recordSessionEvent` (around line 172):

```kotlin
        AsyncFunction("track") Coroutine { envelopeJson: String ->
            Rovenue.shared.track(envelopeJson)
        }
```

- [ ] **Step 3: Add a façade unit test**

In the sdk-kotlin test sources (mirror the existing `recordSessionEvent`/`setAttributes` test file — search with `rg -l "recordSessionEvent" packages/sdk-kotlin/src/test`), add a test that `track` forwards to the core. Example, adapting to the existing fake-core/test harness in that file:

```kotlin
    @Test
    fun track_forwards_envelope_to_core() = runBlocking {
        val fakeCore = FakeRovenueCore()              // existing test double in this file
        val rovenue = Rovenue.testInstance(fakeCore)  // existing test constructor pattern
        rovenue.track("""{"eventType":"x","occurredAt":"2026-06-20T00:00:00Z"}""")
        assertEquals(
            """{"eventType":"x","occurredAt":"2026-06-20T00:00:00Z"}""",
            fakeCore.lastTrackedEnvelopeJson,
        )
    }
```

If the existing test harness exposes the core differently (e.g. a mock verifying `core.track(...)` was called), match that style instead — the assertion is simply "the façade forwards the exact JSON string to `core.track`".

- [ ] **Step 4: Run the Kotlin unit tests**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "*Rovenue*track*"`
Expected: PASS. (Use `testDebugUnitTest`, not compile-only — see project conventions.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt \
        packages/sdk-kotlin/src/test
git commit -m "feat(sdk-kotlin,sdk-rn): expose track() through Kotlin facade + Expo module"
```

---

### Task 7: RN TypeScript `track` public API

**Files:**
- Create: `packages/sdk-rn/src/api/events.ts`
- Modify: `packages/sdk-rn/src/core/native.ts` (add `track` to `RovenueModuleSpec`)
- Modify: `packages/sdk-rn/src/index.ts` (export `track` on the `Rovenue` object)
- Test: `packages/sdk-rn/src/api/events.test.ts`

**Interfaces:**
- Consumes: `getNative().track(envelopeJson)` (Tasks 5 & 6); existing `mapNativeError`; existing `EventEnvelope`/`IdentityContext` + `serializeEnvelope` from `../events`.
- Produces: `Rovenue.track(eventType: string, params?: TrackParams): Promise<void>` — the public SDK surface.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/api/events.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const track = vi.fn(async () => {});
vi.mock("../core/native", () => ({ getNative: () => ({ track }) }));

import { track as trackApi } from "./events";

describe("track", () => {
  beforeEach(() => track.mockClear());

  it("stamps occurredAt and forwards a compact camelCase envelope", async () => {
    await trackApi("purchase", { amount: "9.99", currency: "USD" });
    expect(track).toHaveBeenCalledTimes(1);
    const json = track.mock.calls[0][0] as string;
    const env = JSON.parse(json);
    expect(env.eventType).toBe("purchase");
    expect(env.amount).toBe("9.99");
    expect(env.currency).toBe("USD");
    expect(typeof env.occurredAt).toBe("string");
    expect(env.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // undefined fields are stripped, not serialised as null
    expect("subscriberId" in env).toBe(false);
    expect("productId" in env).toBe(false);
  });

  it("honours an explicit occurredAt and identityContext", async () => {
    await trackApi("lead", {
      occurredAt: "2026-06-20T10:00:00Z",
      identityContext: { email: "a@b.com" },
    });
    const env = JSON.parse(track.mock.calls[0][0] as string);
    expect(env.occurredAt).toBe("2026-06-20T10:00:00Z");
    expect(env.identityContext).toEqual({ email: "a@b.com" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/sdk-rn test -- events.test`
Expected: FAIL — `Cannot find module './events'` (the API file).

- [ ] **Step 3: Create the API wrapper**

Create `packages/sdk-rn/src/api/events.ts`:

```typescript
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import {
  type EventEnvelope,
  type IdentityContext,
  serializeEnvelope,
} from "../events";

/** Optional fields for {@link track}. `eventType` is the first positional arg. */
export interface TrackParams {
  /** ISO-8601 override; defaults to the call-time timestamp. */
  occurredAt?: string;
  /** Defaults to the current scope (app user id, else anonymous id). */
  subscriberId?: string;
  productId?: string;
  /** Decimal string, e.g. "9.99". */
  amount?: string;
  /** ISO-4217 three-letter code, e.g. "USD". */
  currency?: string;
  eventSourceUrl?: string;
  identityContext?: IdentityContext;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Emit a generic event to the backend (`POST /v1/events`). Fire-and-forget:
 * resolves once the POST attempt completes; the SDK's HTTP layer retries
 * transient failures. `occurredAt` defaults to now; `subscriberId` is filled
 * server-of-SDK from the current scope when omitted.
 */
export async function track(eventType: string, params: TrackParams = {}): Promise<void> {
  const envelope: EventEnvelope = {
    eventType,
    occurredAt: params.occurredAt ?? isoNow(),
    subscriberId: params.subscriberId,
    productId: params.productId,
    amount: params.amount,
    currency: params.currency,
    eventSourceUrl: params.eventSourceUrl,
    identityContext: params.identityContext,
  };
  return call(() => getNative().track(serializeEnvelope(envelope)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/sdk-rn test -- events.test`
Expected: PASS (`serializeEnvelope` strips the `undefined` fields; occurredAt stamped).

- [ ] **Step 5: Add `track` to the native module spec**

In `packages/sdk-rn/src/core/native.ts`, add to the `RovenueModuleSpec` interface (next to `recordSessionEvent`):

```typescript
  track(envelopeJson: string): Promise<void>;
```

- [ ] **Step 6: Export `track` on the public `Rovenue` object**

In `packages/sdk-rn/src/index.ts`:

Add the import next to the other `./api/*` imports:

```typescript
import { track } from "./api/events";
```

Add `track` to the `export const Rovenue = { ... }` object (place it after `restorePurchases,`):

```typescript
  track,
```

Also export the param type next to the existing events type re-export (the line `export type { EventEnvelope, IdentityContext } from "./events";`):

```typescript
export type { TrackParams } from "./api/events";
```

- [ ] **Step 7: Typecheck + full sdk-rn tests**

Run: `pnpm --filter @rovenue/sdk-rn build && pnpm --filter @rovenue/sdk-rn test`
Expected: PASS — types resolve (`getNative().track` exists on the spec) and all tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-rn/src/api/events.ts packages/sdk-rn/src/api/events.test.ts \
        packages/sdk-rn/src/core/native.ts packages/sdk-rn/src/index.ts
git commit -m "feat(sdk-rn): add Rovenue.track() public API for /v1/events"
```

---

### Task 8: Version bumps + docs note

Additive, non-breaking change across the core crate and the RN package.

**Files:**
- Modify: `packages/core-rs/Cargo.toml` (version)
- Modify: `packages/sdk-rn/package.json` (version)
- Modify: `apps/docs/` SDK reference page that lists SDK methods (find with `rg -l "recordSessionEvent|setAttributes" apps/docs`)

- [ ] **Step 1: Bump the core crate version**

In `packages/core-rs/Cargo.toml`, bump the `version` field by one minor (e.g. `0.8.0` → `0.9.0`). Match whatever the current value is.

- [ ] **Step 2: Bump the RN package version**

In `packages/sdk-rn/package.json`, bump `version` by one minor.

- [ ] **Step 3: Document `track` in the SDK reference**

In the docs page listing SDK methods, add an entry mirroring the `recordSessionEvent` / `setAttributes` style:

```md
### `Rovenue.track(eventType, params?)`

Emit a generic event to the backend (forwarded to configured integrations such
as Meta CAPI / TikTok Events). Fire-and-forget.

- `eventType: string` — e.g. `"purchase"`, `"lead"`.
- `params?: TrackParams` — optional `occurredAt` (defaults to now), `subscriberId`
  (defaults to the current user/anonymous scope), `productId`, `amount` (decimal
  string), `currency` (ISO-4217), `eventSourceUrl`, and `identityContext`
  (`email`, `externalId`, `phone`, `ip`, `userAgent`, `firstName`, `lastName`,
  `city`, `countryCode`).

```ts
await Rovenue.track("purchase", { amount: "9.99", currency: "USD" });
```
```

- [ ] **Step 4: Build docs to verify**

Run: `pnpm --filter @rovenue/docs build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/Cargo.toml packages/sdk-rn/package.json apps/docs
git commit -m "chore(sdk): bump versions + document Rovenue.track()"
```

---

## Self-Review

**Spec coverage:**
- §3 public surface `track(eventType, params?)` → Task 7.
- §4 auto-fill: occurredAt (TS isoNow) → Task 7 Step 3; subscriberId (core) → Task 3; platform (header) → no code (existing `X-Rovenue-Platform`).
- §5.1 post_json 202 fix → Task 1.
- §5.2 EventsClient + api.track → Tasks 2 & 3.
- §5.3 udl single string method → Task 4.
- §5.4 Swift/Kotlin façades → Tasks 5 & 6.
- §5.5 TS api/events.ts + native spec + index → Task 7.
- §6 error mapping → `call()`/`mapError`/`mapNativeError` reused in Tasks 3/5/6/7.
- §7 tests → Task 1 (202), Task 2/3 (client + auto-fill + malformed), Task 6 (Kotlin façade), Task 7 (TS).
- §8 versioning → Task 8.

**Type consistency:** `track(envelope_json: String)` (Rust) ↔ `void track(string envelope_json)` (udl) ↔ `track(envelopeJson:)` (Swift) / `track(envelopeJson)` (Kotlin) ↔ `track(envelopeJson: string)` (native spec) ↔ `track(eventType, params?)` (public TS, builds the JSON via `serializeEnvelope`). `EventsClient::post(&EventEnvelope, Option<&str>)` consistent across Tasks 2–3. `EventEnvelope` field names match the existing serde struct.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one adapt-to-harness note (Task 6 Step 3 Kotlin test) is explicit about what to mirror and what the assertion must be, because the exact test-double API is local to that file.
