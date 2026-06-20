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
  occurredAt?: string;      // ISO-8601 override; defaults to now()
  subscriberId?: string;    // override; defaults to current scope
  identityContext?: EventIdentityContext;
}

interface EventIdentityContext {
  email?: string;
  externalId?: string;
  phone?: string;
  ip?: string;
  userAgent?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  countryCode?: string;
}
```

`track` resolves `Promise<void>` once the POST attempt completes. Rejections
surface as mapped `RovenueError` codes (see §6).

## 4. Auto-fill behavior

| Field | Default | Override |
|-------|---------|----------|
| `occurredAt` | UTC ISO-8601 stamped in Rust core at call time | `params.occurredAt` |
| `subscriberId` | `current_user_scope()` = `app_user_id ?? rovenue_id` | `params.subscriberId` |
| `platform` | **Not in payload.** Travels via the existing `X-Rovenue-Platform` header injected on POST from `Config.platform` | n/a (header) |

**Platform note:** the backend `eventEnvelopeSchema` has no `platform` field;
Zod would strip it from the payload. Platform is already conveyed on every POST
via the `X-Rovenue-Platform` header (`http_client.rs`, POST path). So
"platform = from Config" is satisfied by the header with zero new work. Putting
platform into the payload would require a backend schema change — out of scope.

## 5. Implementation

### 5.1 Rust core (`packages/core-rs/src/`)

New module `events/client.rs`:

- `TrackParams` struct mirroring §3 (all `Option<String>` + `identity_context:
  Option<EventIdentityContext>`).
- `EventIdentityContext` struct with the 9 backend fields (full record — backend
  already supports all; adding fields later means re-touching udl + 3 façades, so
  do it once now).
- `fn track(&self, event_type: String, params: TrackParams) -> RovenueResult<()>`:
  1. Resolve `occurred_at` = `params.occurred_at_iso` or now() as ISO-8601 UTC.
  2. Resolve `subscriber_id` = `params.subscriber_id` or `current_user_scope()`.
  3. Build the JSON envelope (omit `None` fields so Zod sees only set keys).
  4. `http.post_json("/v1/events", &envelope, user_scope)` reusing the existing
     `HttpClient` POST path (Bearer + `X-Rovenue-Platform` + scope headers,
     3-retry).
  5. Ignore the 202 body; return `Ok(())`.

`api.rs`: add `impl RovenueCore::track(&self, event_type, params)` delegating to
the events client, passing `current_user_scope()`.

### 5.2 uniffi `.udl` (`librovenue.udl`)

```
dictionary EventIdentityContext {
  string? email;
  string? external_id;
  string? phone;
  string? ip;
  string? user_agent;
  string? first_name;
  string? last_name;
  string? city;
  string? country_code;
};

dictionary TrackParams {
  string? product_id;
  string? amount;
  string? currency;
  string? event_source_url;
  string? occurred_at_iso;
  string? subscriber_id;
  EventIdentityContext? identity_context;
};

interface RovenueCore {
  // ...
  [Throws=RovenueError]
  void track(string event_type, TrackParams params);
};
```

Bindings regenerated via `npm run sdk:bindings` (generated Swift/Kotlin are
gitignored build artifacts — see [[rovenue_sdk_uniffi_bindings]]).

### 5.3 Façades

- Swift `ios/RovenueModule.swift`: `AsyncFunction("track")` → `Rovenue.shared.track(...)`.
- Kotlin `android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`:
  `AsyncFunction("track") Coroutine { ... }`.
- RN TS: new `src/api/events.ts` with `track(eventType, params?)` wrapping
  `getNative().track(...)` through the existing `call()` error-mapping helper;
  export from `Rovenue` object in `src/index.ts`. Snake_case ↔ camelCase mapping
  for params happens at the TS boundary (consistent with existing wrappers).

## 6. Error handling & delivery

- Fire-and-forget: relies on the existing HTTP client's 3 retries. No durable
  queue in Phase 1; on persistent failure (e.g. offline) the event is dropped.
- Network/server errors map to existing `RovenueError` variants
  (`NetworkUnavailable`, `Timeout`, `ServerError`, `RateLimited`, `InvalidApiKey`)
  via the established `mapNativeError` path.
- `track` does not block app flow; callers may ignore the returned promise.

## 7. Testing

- **Rust unit** (`events/client.rs`): mock HTTP asserts (a) path `/v1/events`,
  (b) `occurredAt` auto-stamped when absent and preserved when provided,
  (c) `subscriberId` auto-filled from scope and overridable, (d) `None` fields
  omitted from the JSON body.
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
