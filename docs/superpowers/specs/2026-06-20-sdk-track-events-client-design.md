# SDK `track()` — Generic Event Client Path (Phase 1)

**Date:** 2026-06-20
**Status:** Approved design, pre-implementation
**Scope:** SDK client path for `POST /v1/events` only. Funnel attribution
(`claim-install`, `claim-via-email`, `claim-funnel-token`) is explicitly
deferred to a separate spec.

## 1. Background

The backend endpoint `POST /v1/events`
(`apps/api/src/routes/v1/events.ts:94`) is fully implemented: it accepts a
generic event envelope under a PUBLIC API key, writes to `outbox_events`,
returns `202 Accepted`, and the integrations-dispatch pipeline fans out to
Meta CAPI / TikTok Events.

There is currently **no SDK client path** to call it. App developers cannot
emit attribution/conversion events through the SDK. This spec adds a single
generic `track()` method across all SDK layers.

The SDK is a Rust core crate (`packages/core-rs`, `librovenue`) with
Swift/Kotlin/RN façades generated via uniffi from
`packages/core-rs/src/librovenue.udl`. See [[rovenue_sdk_architecture]].

### Backend contract (authoritative)

`eventEnvelopeSchema` accepted by the route:

```
{
  eventType: string,            // required
  occurredAt: datetime (ISO),   // required
  subscriberId?: string,
  productId?: string,
  amount?: decimal-string,
  currency?: 3-char,
  eventSourceUrl?: url,
  identityContext?: {
    email?, externalId?, phone?, ip?, userAgent?,
    firstName?, lastName?, city?, countryCode?
  }
}
```

- Auth: **PUBLIC API key only** (the SDK's existing Bearer token).
- Zod strips unknown top-level keys → fields not in the schema are silently
  dropped (relevant to the `platform` decision below).

## 2. Goals / Non-goals

**Goals**
- One generic public method `Rovenue.track(eventType, params?)` on the RN TS
  surface, wired through Swift + Kotlin façades to the Rust core.
- Fire-and-forget delivery leveraging the existing HTTP client retry (3
  attempts).
- Sensible auto-fill so the common call is `Rovenue.track("purchase")`.

**Non-goals (Phase 1)**
- Durable/offline event queue (SQLite-backed). The `track` signature is
  designed to allow adding this later without a breaking change.
- Funnel attribution endpoints and any native data collection
  (Install Referrer, iOS fingerprint, deep-link token capture).
- Typed convenience helpers (`trackPurchase`, etc.). Generic `track` only.

## 3. Public API surface

```ts
// React Native / Expo TS
Rovenue.track(eventType: string, params?: TrackParams): Promise<void>

interface TrackParams {
  productId?: string;
  amount?: string;          // decimal string, e.g. "9.99"
  currency?: string;        // 3-char ISO, e.g. "USD"
  eventSourceUrl?: string;
  occurredAt?: string;      // ISO-8601 override; defaults to isoNow()
  subscriberId?: string;    // override; defaults to current scope
  identityContext?: IdentityContext;  // existing type from src/events.ts
}

// IdentityContext (9 fields) already exists in src/events.ts and is
// re-exported from index.ts — reused as-is, not redefined:
//   email?, externalId?, phone?, ip?, userAgent?,
//   firstName?, lastName?, city?, countryCode?
```

`track` resolves `Promise<void>` once the POST attempt completes. Rejections
surface as mapped `RovenueError` codes (see §6).

## 4. Auto-fill behavior

| Field | Default | Stamped where | Override |
|-------|---------|---------------|----------|
| `occurredAt` | `new Date().toISOString()` (`isoNow()`) | **TS façade** — consistent with `record_session_event`, which already stamps in TS and passes the ISO string down. Rust core has no date library (no `chrono`/`time` dep), so stamping in core would mean adding one. | `params.occurredAt` |
| `subscriberId` | `current_user_scope()` = `app_user_id ?? rovenue_id` | **Rust core** — `track` fills `subscriber_id` from scope only when the deserialized envelope leaves it `None`. | `params.subscriberId` |
| `platform` | **Not in payload.** Travels via the existing `X-Rovenue-Platform` header injected on POST from `Config.platform` | n/a (header) | n/a |

**Platform note:** the backend `eventEnvelopeSchema` has no `platform` field;
Zod would strip it from the payload. Platform is already conveyed on every POST
via the `X-Rovenue-Platform` header (`http_client.rs`, POST path). So
"platform = from Config" is satisfied by the header with zero new work. Putting
platform into the payload would require a backend schema change — out of scope.

## 5. Implementation

**Reuse, don't recreate.** M7 already shipped the wire types and a TS serialiser
but never wired the actual call:

- `packages/core-rs/src/events/envelope.rs` — `EventEnvelope` (serde
  `camelCase`, `skip_serializing_if = "Option::is_none"`), re-exported at crate
  root (`lib.rs`).
- `packages/core-rs/src/events/identity_context.rs` — `IdentityContext` (9
  fields, same serde rules).
- `packages/sdk-rn/src/events.ts` — `EventEnvelope`/`IdentityContext` TS types +
  `serializeEnvelope()`/`stripUndefined()`, already re-exported from `index.ts`.

The full `identityContext` record is therefore already present on both sides — no
new type work. The FFI boundary carries the envelope as a **JSON string**
(`serializeEnvelope()` exists for exactly this), which keeps the Swift/Kotlin
façade changes to a single `String` pass-through instead of mirrored record
structs.

### 5.1 Transport fix — `post_json` treats 202 as bodyless

`POST /v1/events` returns `c.body(null, 202)` (empty body). `classify()` maps
202 → `Success`, but `post_json`'s success branch only skips body parsing for
`204`, so it would call `resp.json()` on the empty 202 body and return
`RovenueError::Internal` on every successful call. Fix: in
`packages/core-rs/src/transport/http_client.rs`, change the `post_json` no-body
condition from `status == 204` to `status == 204 || status == 202`. Safe for all
current callers (`post_sessions`/`post_attributes` discard the body;
receipts/identify return `200`). 202 Accepted is conventionally empty.

### 5.2 Rust core (`packages/core-rs/src/events/`)

New `events/client.rs`:

```rust
pub struct EventsClient { http: Arc<HttpClient> }
impl EventsClient {
    pub fn new(http: Arc<HttpClient>) -> Self { ... }
    /// POST the envelope to /v1/events. Any 2xx (route returns 202) is success;
    /// body ignored.
    pub fn post(&self, envelope: &EventEnvelope, scope: Option<&str>)
        -> RovenueResult<()>;
}
```

`events/mod.rs`: add `pub mod client; pub use client::EventsClient;`.

`api.rs`:
- Hold `events: Arc<EventsClient>` (constructed in `from_store_with_http_max_attempts`
  from the shared `http`).
- `pub fn track(&self, envelope_json: String) -> RovenueResult<()>`:
  1. `let mut env: EventEnvelope = serde_json::from_str(&envelope_json)
     .map_err(|_| RovenueError::InvalidArgument)?;`
  2. If `env.subscriber_id.is_none()`, fill from `current_user_scope()` when
     non-empty.
  3. `self.events.post(&env, scope.as_deref())`.

### 5.3 uniffi `.udl` (`librovenue.udl`)

Single method on `interface RovenueCore` — no new dictionaries (envelope crosses
as a JSON string):

```
[Throws=RovenueError]
void track(string envelope_json);
```

Bindings regenerated via `npm run sdk:bindings` (generated Swift/Kotlin are
gitignored build artifacts — see [[rovenue_sdk_uniffi_bindings]]).

### 5.4 Façades (String pass-through)

- Swift façade `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`:
  `func track(envelopeJson: String) async throws` → `dispatcher.run { core.track(envelopeJson:) }`,
  mapping `RovenueError` → public error (mirrors `recordSessionEvent`).
- Swift Expo module `packages/sdk-rn/ios/RovenueModule.swift`:
  `AsyncFunction("track") { (envelopeJson: String) in try await Rovenue.shared.track(envelopeJson: envelopeJson) }`.
- Kotlin façade `packages/sdk-kotlin/.../Rovenue.kt`:
  `suspend fun track(envelopeJson: String) { dispatcher.run { core.track(envelopeJson) } }`.
- Kotlin Expo module `packages/sdk-rn/android/.../RovenueModule.kt`:
  `AsyncFunction("track") Coroutine { envelopeJson: String -> Rovenue.shared.track(envelopeJson) }`.

### 5.5 RN TS (`packages/sdk-rn/src/`)

- New `src/api/events.ts`: `track(eventType, params?)` builds an `EventEnvelope`
  (`occurredAt: params.occurredAt ?? isoNow()`), calls
  `getNative().track(serializeEnvelope(envelope))` through the established
  `call()` error-mapping helper.
- `src/core/native.ts`: add `track(envelopeJson: string): Promise<void>` to
  `RovenueModuleSpec`.
- `src/index.ts`: add `track` to the exported `Rovenue` object.

## 6. Error handling & delivery

- Fire-and-forget: relies on the existing HTTP client's 3 retries. No durable
  queue in Phase 1; on persistent failure (e.g. offline) the event is dropped.
- Network/server errors map to existing `RovenueError` variants
  (`NetworkUnavailable`, `Timeout`, `ServerError`, `RateLimited`, `InvalidApiKey`)
  via the established `mapNativeError` path.
- `track` does not block app flow; callers may ignore the returned promise.

## 7. Testing

- **Rust unit** (`http_client.rs`): `post_json` returns `Ok` (no body) on a 202
  empty response — guards the transport fix in §5.1.
- **Rust unit** (`events/client.rs` + `api.rs::track`): mock HTTP asserts (a) path
  `/v1/events` receives the POST, (b) `subscriberId` auto-filled from scope when
  absent and preserved when provided, (c) `occurredAt` passed through verbatim,
  (d) `None` fields omitted from the JSON body, (e) malformed `envelope_json` →
  `InvalidArgument`.
- **RN TS**: `track` wrapper calls the native module with correctly mapped
  (camel→snake) arguments; default-params path.
- **Façade build verification**: Kotlin `testDebugUnitTest` (not just compile —
  see [[rovenue_sdk_kotlin_test_verify]]); Swift build.

## 8. Versioning

Minor bump across core crate + RN npm package (additive, non-breaking).

## 9. Future (out of scope, noted for continuity)

- Durable SQLite-backed event queue with background flush + 202-delete; the
  `track` signature is forward-compatible.
- Funnel attribution SDK client path (separate spec): see funnel core design
  `2026-05-26-onboarding-funnel-core-design.md` §6.4 / §9.
