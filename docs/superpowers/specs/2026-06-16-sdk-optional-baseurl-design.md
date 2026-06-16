# SDK Optional `baseUrl` — Design

**Date:** 2026-06-16
**Status:** Approved, pending implementation plan

## Problem

`baseUrl` is currently a **required** argument in every SDK surface:

- Rust core — `Config::new(api_key, base_url)` (`packages/core-rs/src/config.rs:16`)
- RN/TS façade — `RovenueConfig.baseUrl: string` (`packages/sdk-rn/src/api/configure.ts:8`)
- Swift façade — `configure(apiKey:baseUrl:...)` (`packages/sdk-swift/Sources/Rovenue/Rovenue.swift:61`)
- Kotlin façade — `configure(... baseUrl: String ...)` (`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt:111`)

There is **no** default anywhere today — every developer must pass the host explicitly, even when using the hosted Rovenue service. The hosted service is the common case; self-hosting is the exception.

## Goal

Make `baseUrl` **optional**. When omitted it falls back to the hosted endpoint `https://api.rovenue.io`. Self-hosters override it with their own address.

## Key Constraint: versioning lives in the path, not the base URL

Request paths already carry the `/v1/` prefix — e.g. `/v1/identify`, `/v1/offerings`, `/v1/me/entitlements`, `/v1/receipts/apple`. The core builds URLs as `format!("{}{}", base_url, req.path)` (`packages/core-rs/src/transport/http_client.rs:62` and `:197`).

Therefore the default **must be origin-only** (`https://api.rovenue.io`, no path). Appending `/v1` to the default would produce `/v1/v1/...`. API versioning is already expressed in the request paths, so the base URL stays at the origin.

## Approach

Default defined **once, in the Rust core** (UDL dictionary default). All three façades inherit that single canonical value via the UniFFI-generated `Config` type — no duplicated host constants per language.

## Components

### 1. Rust core — single source of truth

- `packages/core-rs/src/librovenue.udl` — give `base_url` a UDL default in the `Config` dictionary:
  ```
  dictionary Config {
      string api_key;
      string base_url = "https://api.rovenue.io";
      boolean debug;
      string? app_version;
  };
  ```
  This makes `base_url` an optional (defaulted) field in the generated Swift/Kotlin `Config` types.
  - Implementation note: UniFFI dictionary fields with defaults may need to be ordered after non-defaulted fields. Verify against generated bindings; reorder fields if the binding generator requires it.
- `packages/core-rs/src/config.rs`:
  - Add `pub const DEFAULT_BASE_URL: &str = "https://api.rovenue.io";`.
  - In `Config::new`, when `base_url` is empty/blank, fall back to `DEFAULT_BASE_URL` before validation (belt-and-suspenders for callers that pass `""`).

### 2. Validation change (`config.rs:20`)

Replace the current "starts with `http://` or `https://`" check with:

- Require `https://` **by default**.
- Allow `http://` **only** when the host is `localhost`, `127.0.0.1`, or `[::1]` (local self-host / LAN dev).
- On failure, return a clear `RovenueError::InvalidArgument` (the current `RovenueError::Internal` is misleading for a user-supplied bad URL).

### 3. Façades — make `baseUrl` optional

All three stop requiring the argument and rely on the core default when it is absent.

- **RN/TS** (`packages/sdk-rn/src/api/configure.ts`):
  - `RovenueConfig.baseUrl?: string`.
  - Validate only when provided. When provided, pass through to native; when omitted, do not pass it (native bridge falls back to core default).
  - Native bridge signatures become optional:
    - `packages/sdk-rn/src/specs/RovenueModule.types.ts` — `baseUrl?: string` (or `string | undefined`).
    - iOS `packages/sdk-rn/ios/RovenueModule.swift:55` — `baseUrl: String?`; when `nil`, construct core `Config` without specifying `base_url` (UDL default applies).
    - Android `packages/sdk-rn/android/.../RovenueModule.kt:55` — `baseUrl: String?`; same nil-handling.
- **Swift façade** (`packages/sdk-swift/Sources/Rovenue/Rovenue.swift:61`):
  - `baseUrl: String? = nil`. When `nil`, build `Config` using the generated default.
- **Kotlin façade** (`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt:111`):
  - `baseUrl: String? = null`. When `null`, build `Config` using the generated default.

### 4. Tests

- Core `packages/core-rs/tests/config_test.rs`:
  - Empty/blank `base_url` resolves to `https://api.rovenue.io`.
  - `https://` accepted; arbitrary `http://` rejected with `InvalidArgument`.
  - `http://localhost:3000` and `http://127.0.0.1:...` accepted.
- Façade tests:
  - Swift `ConfigurationTests.swift` — omitting `baseUrl` configures against the default.
  - Kotlin `ConfigurationTest.kt` — omitting `baseUrl` configures against the default.
  - RN `packages/sdk-rn/src/__tests__/api.test.ts` — `configure({ apiKey })` (no `baseUrl`) succeeds and does not pass a host to the native module.

### 5. Documentation & examples

- `examples/sample-rn-expo/App.tsx` — drop the explicit `baseUrl` to demonstrate the hosted default (note: this file is already modified in the working tree; fold the change in).
- `apps/docs` — update the `configure` snippets across RN/Swift/Kotlin to show `baseUrl` as optional, with a short "Self-hosting" note explaining the override.

## Out of Scope (YAGNI)

- Defaulting `debug`.
- Regional / multi-endpoint selection.
- Changing the base URL at runtime after `configure`.

## Verification

- `cargo test` in `packages/core-rs` (config + transport).
- Kotlin: `testDebugUnitTest` (not compile-only) per the project's Kotlin verification convention.
- Swift: `swift test` for the façade.
- RN: package vitest/jest suite.
- Regenerate UniFFI bindings (`npm run sdk:bindings`) after the UDL change before building Swift/Kotlin façades; generated `.swift`/`.kt` are build artifacts, not committed.
