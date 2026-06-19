# Remote Config — SDK end-to-end wiring

Goal: expose the existing server-side Remote Config (feature flags + experiment
assignments served by `GET/POST /v1/config`) through the client SDK, with an
`environment` (prod/staging/development) init option. Public naming is
**remoteConfig** (e.g. RN `useRemoteConfig()` hook).

Backend is already complete: `/v1/config` returns
`{ data: { flags: Record<key, value>, experiments: Record<key, ExperimentResult> } }`,
reads subscriber via `x-rovenue-user-id` header and environment via
`x-rovenue-env` header (or `?env=`), defaulting to PROD.

## Status

- ✅ **Layer 1 (Rust core)** — complete, `cargo test` green (32 tests incl. 3 new
  remote_config + schema/migration test bumps). clippy-clean.
- ✅ **Layer 2 (bindings)** — regenerated, UDL valid.
- ✅ **Layer 3a (RN/TypeScript)** — complete; `useRemoteConfig`/`useFlag`/
  `useExperiment` hooks + `remoteConfig` API + `configure({ environment })`.
  All 91 RN vitest tests + tsc green.
- ✅ **Layer 3b (native Swift/Kotlin façades + RN bridges)** — complete.
  `configure(environment:)` + remoteConfig getters on both standalone façades;
  RN iOS/Android bridges expose all methods + forward environment; Swift event
  case added (Kotlin auto-maps via enum `.name`).
- ✅ **Layer 4 (verify)** — Swift `swift test` All tests passed; Kotlin
  `testDebugUnitTest` BUILD SUCCESSFUL (0 failures); Rust `cargo test` green; RN
  vitest + tsc green. Fixed direct `Config(...)` literals in Rust/Swift/Kotlin
  tests that needed the new `environment` field. RN bridges (ios/android) can't
  compile standalone (need Expo host autolinking) but names cross-checked
  against the generated bindings + JS spec.

## Layers (strict dependency order)

### 1. Rust core (`packages/core-rs`) — keystone, TDD
- [ ] `config.rs`: add `environment: Option<String>` + `with_environment()`.
- [ ] `transport/http_client.rs`: add `environment` field + `with_environment()`,
      send `x-rovenue-env` header on GET + POST when present (mirror `platform`).
- [ ] `transport/types.rs`: add `subscriber_id: Option<&str>` to `HttpRequest`
      (+ builder) → `get_json` sends `X-Rovenue-User-Id` header. (config endpoint
      uses this header, NOT `X-Rovenue-App-User-Id`.)
- [ ] `cache/schema.rs`: `MIGRATION_V7` adds `remote_config_cache(resource, body, updated_at_ms)`; bump `LATEST=7`.
- [ ] `cache/remote_config.rs`: `RemoteConfigCacheRepo` (get/put) mirroring `offerings.rs`.
- [ ] `remote_config/` module: `types.rs` (wire + FFI `ExperimentAssignment`),
      `reader.rs` (`RemoteConfigReader`: http + store + identity + clock + bus,
      in-memory `RwLock` state, `refresh()`, typed getters, offline fallback).
- [ ] `observer.rs`: add `ChangeEvent::RemoteConfigChanged`.
- [ ] `api.rs`: build reader (http carries env), wire getters + `refresh_remote_config()`,
      register 60s scheduler tick + staleness async-refresh on read.
- [ ] `librovenue.udl`: `Config.environment`, `ChangeEvent::RemoteConfigChanged`,
      `ExperimentAssignment` dict, `RovenueCore` methods:
      `refresh_remote_config()`, `remote_config_bool/string/int/double(key, fallback)`,
      `remote_config_json(key) -> string?`, `remote_config_keys()`,
      `experiment(key) -> ExperimentAssignment?`, `experiments_all()`.
- [ ] Tests (mockito): refresh parses flags+experiments; getters honor defaults;
      env header sent; offline fallback serves cache; unknown key → fallback.

### 2. Regenerate bindings
- [ ] `npm run sdk:bindings` (Swift/Kotlin uniffi gen; artifacts gitignored).

### 3. Façades
- [ ] RN (`packages/sdk-rn`): `configure.ts` adds `environment`; native spec +
      ios/android bridges pass it; JS `remoteConfig` API + `useRemoteConfig()` hook
      (reactive on `RemoteConfigChanged`).
- [ ] Swift (`packages/sdk-swift`): `configure(environment:)` + remoteConfig getters.
- [ ] Kotlin (`packages/sdk-kotlin`): `configure(environment=)` + remoteConfig getters.

### 4. Verify
- [ ] `cargo test` (core-rs), `testDebugUnitTest` (kotlin), swift tests, RN typecheck.
