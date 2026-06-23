# SDK Error Handling — Unified Model & Improvements

- **Date:** 2026-06-23
- **Status:** Approved design, ready for implementation plan
- **Scope:** `packages/core-rs` (librovenue), `packages/sdk-swift`, `packages/sdk-kotlin`, `packages/sdk-rn`. Backend (`apps/api`) is read-only here except as the error contract being consumed.
- **Breaking:** Yes — public error API changes on all four façades. Pre-1.0, so done now. Version bump 0.15.0 → 0.16.0.

## 1. Background & motivation

A four-layer analysis (Rust core, Swift+Kotlin façades, RN+backend contract) found the error model works on the happy path but is inconsistent and lossy:

- **No stable error code.** Core `RovenueError` (`core-rs/src/error.rs`) is a flat fieldless enum; the only identity is the variant name + a hardcoded English `Display` string. No numeric/string code, no structured fields cross the FFI.
- **Backend `code`/`message` discarded.** `core-rs/src/transport/api.rs` only models the success envelope (`ApiEnvelope<T>`); on any error status the body is dropped and the variant is chosen purely from HTTP status. The backend's `{ error: { code, message } }` never reaches the developer.
- **All non-401 4xx collapse to `ServerError`** (`http_client.rs:166,319`). A client-side 400/403/404 is indistinguishable from a backend outage. `ServerError` is a misnomer for 4xx. 402 is checked only on POST.
- **5 dead variants** exported across FFI but never produced: `NotConfigured`, `UserNotFound`, `EntitlementInactive`, `DuplicatePurchase`, `ReceiptInvalid` (the last actively contradicted — 409 → Success).
- **Façade divergence.** Swift remaps to a payload-less `Rovenue.Error` (drops the core message); Kotlin throws the generated `RovenueException` raw (keeps message) **plus** four standalone purchase `Exception`s — two disjoint hierarchies, no common base. Naming drift: `serverError` (Swift) / `ServerException` (Kotlin) / `Server` (RN). RN exposes 22 typed subclasses with an `InternalError` catch-all for unknown codes.
- **Store sub-codes conflated.** Both platforms swallow store-specific reasons into one generic case: Play `ITEM_ALREADY_OWNED` / `SERVICE_DISCONNECTED` / `NETWORK_ERROR` → `StoreProblemException`; StoreKit `.networkError` / `.notEntitled` / `.ineligibleForOffer` → `.storeProblem`. No typed signal for the host to react (restore, fix payment, retry).
- **`.pending` modeled as a thrown error** on both platforms (`.purchasePending` / `PurchasePendingException`). Ask-to-Buy / SCA / deferred is a normal state, not a failure.
- **Stability risks:** (1) `observer.rs:36` `ObserverBus::emit` calls foreign (Swift/Kotlin/RN) callbacks with no `catch_unwind` — a panicking/throwing callback can unwind across the FFI boundary; (2) `PlayBillingStore` holds a single `@Volatile pending` continuation — a concurrent second purchase clobbers the first.
- **No `isRetryable` classification** exposed; callers hardcode which kinds to retry.

What is already good and is preserved unchanged: the retry/backoff engine (`retry.rs` — 3 attempts, exponential + jitter, 429 `Retry-After`, fail-open at 30s), deterministic idempotency keys (`idempotency.rs` — FNV-1a over `store+receipt`), and the stale-OK offline model (reads serve cache and never error; only `refresh()` surfaces transport errors).

## 2. Goals / Non-goals

**Goals**
1. One consistent, structured error type per façade carrying a normalized `kind` + the raw backend `serverCode`/`message`/`httpStatus` + a derived `isRetryable`.
2. Correct HTTP→kind mapping (distinct 400/403/404/409/422; `ServerError` = 5xx only; 402 on GET too).
3. Preserve the backend error `code`/`message` end-to-end (pass-through, no codegen).
4. Collapse Kotlin's two exception hierarchies into one; align naming across façades.
5. Typed store failure reasons; `.pending`/deferred becomes a non-error outcome.
6. Close the two stability risks (observer panic, purchase concurrency).
7. An error-taxonomy parity test so the four façades cannot drift.

**Non-goals**
- A shared error-code SSoT + cross-language codegen (rejected in favour of pass-through fields).
- Consolidating the backend's ad-hoc inline error codes into `ERROR_CODE` (separate optional follow-up; the SDK pass-through works regardless).
- Changing the retry engine, idempotency scheme, or offline/cache model.
- Localization beyond passing through the backend/default English message.

## 3. Design decisions (resolved)

| Decision | Choice |
|---|---|
| Breaking vs additive | **Breaking, comprehensive** — pre-1.0, fix the public error API now. 0.15.0 → 0.16.0. |
| Backend↔SDK codes | **Pass-through field** — SDK keeps a normalized `kind` but also carries raw `serverCode` + `message` + `httpStatus`. Add `ApiError` envelope parsing in `api.rs`. No codegen. |
| Store sub-codes | **Typed** — new outcome kinds (AlreadyOwned, PaymentDeclined, ServiceUnavailable, Ineligible); `.pending` becomes a `Deferred` outcome, not a thrown error. |

## 4. Unified error model

### 4.1 `ErrorKind` taxonomy (the normalized discriminant)

A plain (fieldless) enum, exported across FFI. Developers `switch`/`when` on it.

| Group | Kind | Produced by |
|---|---|---|
| Network | `NetworkUnavailable` | transport send error |
| | `Timeout` | reqwest `is_timeout()` |
| | `RateLimited` | 429 (incl. `Retry-After` > 30s fail-open) |
| | `ServerError` | **5xx only** (after retries) |
| Auth/request | `InvalidApiKey` | 401; config validation |
| | `Forbidden` | **403 (new)** |
| | `NotFound` | **404 (new)** |
| | `InvalidRequest` | **400 / 422 (new)** — replaces 422→Internal |
| | `Conflict` | 409 when surfaced as an error |
| | `InvalidArgument` | client-side input validation |
| Domain | `InsufficientCredits` | 402 (GET **and** POST) |
| | `FunnelTokenNotFound` / `FunnelTokenExpired` / `FunnelTokenAlreadyClaimed` | funnel client 404/410/409 |
| Store | `PurchaseCanceled` | user cancelled |
| | `ProductNotAvailable` | product not found / unavailable |
| | `AlreadyOwned` | **(new)** Play `ITEM_ALREADY_OWNED` |
| | `PaymentDeclined` | **(new)** PBL9 insufficient-funds |
| | `StoreServiceUnavailable` | **(new)** Play disconnect/unavailable, StoreKit network |
| | `Ineligible` | **(new)** offer/entitlement ineligibility |
| | `ReceiptInvalid` | unverified StoreKit transaction |
| | `StoreProblem` | store catch-all |
| Other | `Storage` | SQLite cache failure |
| | `Internal` | (de)serialize failure, missing dep, unexpected |

Removed entirely (the dead variants): `NotConfigured`, `UserNotFound`, `EntitlementInactive`, `DuplicatePurchase`. (`ReceiptInvalid` is **retained** because the new StoreKit `.unverified` path produces it.)

### 4.2 Carried fields

The thrown/returned error carries, in addition to `kind`:

| Field | Type | Meaning |
|---|---|---|
| `message` | `String` | backend `error.message` when present, else a default English string |
| `serverCode` | `String?` | raw backend `error.code` (e.g. `INVALID_API_KEY`, `byok_not_allowed`) when the error originated from an HTTP response |
| `httpStatus` | `u16?` | originating HTTP status, when applicable |
| `isRetryable` | `Bool` | derived: `true` for `NetworkUnavailable`, `Timeout`, `RateLimited`, `ServerError`, `StoreServiceUnavailable`; else `false` |

FFI: `RovenueError` becomes a UniFFI error that carries these fields (error-with-fields, not the current flat enum). Each façade re-exposes it as one idiomatic type (§5).

## 5. Façade exposure

A single error type per façade; `kind` is the discriminant; the carried fields are public.

- **Swift** — `public struct RovenueError: Error, LocalizedError { public let kind: ErrorKind; public let message: String; public let serverCode: String?; public let httpStatus: Int?; public var isRetryable: Bool { … } }`. `errorDescription` returns `message`. One `catch let e as RovenueError { switch e.kind { … } }`. Drops the current 20-case `Rovenue.Error` enum and the message-dropping `mapError`.
- **Kotlin** — `class RovenueException(val kind: ErrorKind, override val message: String, val serverCode: String?, val httpStatus: Int?, val isRetryable: Boolean) : Exception(message)`. **One type.** The four standalone purchase exceptions (`Types.kt`) are removed; purchase failures become `kind` values. `@Throws(RovenueException::class)` everywhere.
- **RN** — `class RovenueError extends Error { readonly kind: ErrorKind; readonly serverCode?: string; readonly httpStatus?: number; readonly isRetryable: boolean; readonly data?: { available?: number; retryAfter?: number } }`. Replaces the 22 typed subclasses; callers branch on `e.kind`. `mapNativeError` maps the native `kind` + fields onto this single class (unknown kind → `kind: 'Internal'`, but `serverCode`/`message` are still preserved so nothing is silently lost).

Naming aligned: the single `ServerError` kind everywhere (no `ServerException`/`Server`).

## 6. Transport layer changes (`core-rs`)

- **`api.rs`** — add `ApiError { code: String, message: String }` and parse the `{ error: {...} }` body on error statuses; thread `code`/`message` into the constructed error. On parse failure, fall back to status-derived kind with `serverCode = None`.
- **`http_client.rs`** — replace the "non-401 → ServerError" collapse with the §4.1 mapping (400/422→`InvalidRequest`, 403→`Forbidden`, 404→`NotFound`, 409→`Conflict`, 401→`InvalidApiKey`, 5xx→`ServerError`). Check 402→`InsufficientCredits` on **both** verbs (lift it out of the POST-only path). Funnel client keeps its specific 404/410/409 mapping.
- **`retry.rs`** — unchanged behaviourally; `classify()` still drives retry/terminal. `isRetryable` on the surfaced error is derived from the final `kind`, consistent with what `classify` retried.
- **`error.rs` + `librovenue.udl`** — restructure `RovenueError` to carry the §4.2 fields; redefine `ErrorKind`; delete dead variants.

## 7. Store error mapping

`StorePurchaseOutcome` gains `AlreadyOwned`, `PaymentDeclined`, `ServiceUnavailable`, `Ineligible`, and a `Deferred` state. `purchase()` returns `Deferred` instead of throwing on pending.

**Play (`PlayBillingStore.kt`)** — replace the `else → StoreProblemException` catch-all with:

| BillingResponseCode / sub-response | Outcome |
|---|---|
| `OK` + `PURCHASED` | `Success` |
| `OK` + `PENDING` | `Deferred` |
| `USER_CANCELED` | `UserCancelled` |
| `ITEM_UNAVAILABLE` | `ProductNotFound` |
| `ITEM_ALREADY_OWNED` | `AlreadyOwned` |
| `SERVICE_DISCONNECTED` / `SERVICE_UNAVAILABLE` / `BILLING_UNAVAILABLE` / `NETWORK_ERROR` | `ServiceUnavailable` |
| PBL9 sub-response `PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS` | `PaymentDeclined` |
| PBL9 sub-response `USER_INELIGIBLE` | `Ineligible` |
| `DEVELOPER_ERROR` / other | `StoreProblem` (message keeps raw code + debugMessage) |

**StoreKit (`AppleStore.swift` / `ApplePurchaseFlow.swift`)** — replace bare `catch { throw .storeProblem }` with mapping of `StoreKitError` / `Product.PurchaseError`:

| StoreKit signal | Outcome |
|---|---|
| `.userCancelled` | `UserCancelled` |
| `.pending` | `Deferred` |
| `.networkError` / `.systemError` | `ServiceUnavailable` |
| `.notAvailableInStorefront` / product unavailable | `ProductNotAvailable` |
| `.ineligibleForOffer` / `.notEntitled` | `Ineligible` |
| `.success(.unverified)` | throw `ReceiptInvalid` |
| other / `@unknown default` | `StoreProblem` |

Validation-before-finish/acknowledge fail-safe is preserved on both platforms.

## 8. Safety / correctness fixes

- **Observer panic guard** — wrap each foreign callback dispatch in `ObserverBus::emit` (`observer.rs`) and the funnel claim listener in `std::panic::catch_unwind`; a panicking subscriber is logged and skipped, never unwinds across FFI. (Relates to the known "don't `refresh()` in the change listener" loop — a guarded dispatch contains the blast radius.)
- **Purchase concurrency** — `PlayBillingStore` serialises purchases: a second `purchase()` while one is in flight either awaits a mutex or returns a clear `StoreProblem`/`Busy` outcome rather than clobbering the single `pending` continuation. (Decide await-vs-reject during implementation; reject-with-clear-error is the safer default.)

## 9. Testing

- **Rust unit tests** — one per HTTP status → `kind` (401/402-GET/402-POST/403/404/409/422/429/5xx/network/timeout); `ApiError` envelope parse preserves `serverCode`+`message`; parse-failure fallback; `isRetryable` derivation; `catch_unwind` (a panicking observer does not unwind and other subscribers still fire); purchase concurrency guard.
- **Façade tests** — error construction/mapping carries `kind`+fields; store-outcome mapping tables (§7); `Deferred` is returned, not thrown; `isRetryable` exposed.
- **Error-taxonomy parity test** — a check (sibling to the version-parity test in `sdk-rn/src/__tests__/version.test.ts`) asserting the `ErrorKind` set is identical across the UDL, Swift, Kotlin, and RN surfaces, so they cannot drift.

## 10. Versioning & migration

- All four artefacts 0.15.0 → **0.16.0**; the version-parity test enforces alignment.
- CHANGELOG entry per package documenting the breaking error API (new single error type, `kind` discriminant, removed subclasses/cases, `.pending`→`Deferred`).
- Migration notes in `apps/docs` error-handling section: how to migrate `catch InsufficientCreditsError` → `catch (e) if (e.kind === 'InsufficientCredits')`, and handling the new `Deferred` purchase state.

## 11. File-by-file change inventory

- `core-rs/src/error.rs` — restructure `RovenueError` (carry fields), redefine `ErrorKind`, drop dead variants, derive `isRetryable`.
- `core-rs/src/librovenue.udl` — error-with-fields shape + `ErrorKind`.
- `core-rs/src/transport/api.rs` — `ApiError` envelope parse.
- `core-rs/src/transport/http_client.rs` — status→kind mapping; 402 on GET.
- `core-rs/src/observer.rs` (+ funnel listener) — `catch_unwind` guard.
- `sdk-swift/Sources/Rovenue/Errors.swift`, `Rovenue.swift`, `Internal/AppleStore.swift`, `Internal/ApplePurchaseFlow.swift` — single `RovenueError` struct; StoreKit mapping; `Deferred`.
- `sdk-kotlin/.../Types.kt`, `Rovenue.kt`, `internal/PlayBillingStore.kt`, `internal/PlayPurchaseFlow.kt`, `internal/PlayStore.kt` — single `RovenueException`; remove standalone purchase exceptions; Play mapping; `Deferred`; concurrency guard.
- `sdk-rn/src/errors.ts`, `core/native.ts`, `api/funnel.ts`, `api/events.ts` — single `RovenueError` class + `kind`; `mapNativeError` rewrite; bridge passes `kind`+fields.
- `sdk-rn/ios/RovenueModule.swift`, `sdk-rn/android/.../RovenueModule.kt` — emit `kind` + `serverCode`/`message`/`httpStatus` over the Expo bridge for all errors, not just purchase/funnel.
- Tests across all four + the new parity test.
- Version bumps + CHANGELOGs + docs.

## 12. Out of scope (optional follow-ups)

- Backend ad-hoc error-code consolidation toward `ERROR_CODE` (`apps/api`).
- Error telemetry (reporting SDK errors to Sentry/analytics) — flagged by the analysis as un-audited; worth a separate investigation.

## 13. Risks & open questions

- **UniFFI error-with-fields ergonomics** — the generated Swift/Kotlin shape for a field-carrying error is less clean than a plain enum; the façade re-wrap layer (already present) absorbs this. Confirm the generated binding compiles before committing to the exact UDL shape.
- **RN breaking surface** — dropping 22 subclasses is the largest consumer-facing change; the `kind` discriminant + preserved `serverCode`/`message` is the mitigation. `errors.test.ts` is rewritten accordingly.
- **Purchase concurrency policy** — await vs reject; defaulting to reject-with-clear-error, revisit if a real serial-purchase use case appears.
- **`Conflict` (409)** — currently 409 short-circuits to Success in `classify()` (purchase dedup). Keep that behaviour; `Conflict` kind is reserved for any future path that surfaces 409 as an error, not wired from the current 409→Success path.

## 14. Implementation phasing (for the plan)

1. Core: `ErrorKind` + field-carrying `RovenueError` + `api.rs` envelope + `http_client` mapping + `catch_unwind` + Rust tests.
2. Façades: single error type on Swift/Kotlin/RN + bridge field pass-through.
3. Store: typed outcomes + `Deferred` + Play/StoreKit mapping + concurrency guard.
4. Parity test, version bump 0.16.0, CHANGELOGs, docs.
