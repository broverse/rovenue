# Sub-project B — Android Install Referrer (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Builds on:** [Sub-project A — Funnel Claim Core](./2026-06-20-funnel-claim-core-design.md)
**Scope:** Sub-project **B** only — native Android collection of the Google
Play Install Referrer + device context, auto-fed into `claimInstall`. iOS
deferred source (C), deep-link resolution (D), first-launch orchestration (E),
email/code (F), privacy manifest (G) are out of scope.

## 1. Background

Sub-project A shipped the claim client: `Rovenue.claimInstall(params)` where the
caller supplies the full `ClaimInstallParams` (platform, locale, timezone,
screenDims, deviceModel?, installReferrer?). On Android, the deterministic,
Google-sanctioned way to recover a funnel token across a cold install is the
**Play Install Referrer API** (`com.android.installreferrer`): the funnel "open"
link sends the user to the Play Store with a `referrer` parameter that survives
the install, and the app reads it on first launch.

This sub-project makes the SDK **collect the referrer + device context natively**
on Android, so the host app simply calls `Rovenue.claimInstall()` with no
arguments (the MMP ergonomic). No Rust core, uniffi, or Kotlin-façade change —
the auto-fill happens in the Expo Android module, which already holds the Android
`Context` and constructs `ClaimInstallParams` before forwarding to the façade.

## 2. Goals / Non-goals

**Goals**
- Native Android reading of the Play Install Referrer (raw string) via
  `InstallReferrerClient`, with a connection timeout and graceful failure → null.
- Native Android collection of device context (locale, timezone, screen
  dimensions, device model) for the backend-required `claim-install` fields.
- `claimInstall` auto-fills these on Android; caller-supplied params override.
- TS `claimInstall(params?)` — params become **optional**.

**Non-goals (this sub-project)**
- Parsing the referrer in the SDK — the backend's `parseInstallReferrer`
  extracts `rovenue_funnel_token`; the SDK sends the **raw** referrer string.
- iOS device-context / clipboard collection (sub-project C). The iOS Expo
  module's `claimInstall` keeps A's pass-through behavior until C.
- Automatic first-launch orchestration + the resolution timeout policy
  (sub-project E). B reads the referrer on demand when `claimInstall` is called.
- Once-per-install dedup — already handled by A's `funnel_claim_state`
  (sub-project E reads it).

## 3. Backend contracts (authoritative, unchanged)

- `POST /v1/sdk/claim-install` (A): requires `platform, locale, timezone,
  screen_dims, install_id`; optional `device_model, install_referrer`. Returns
  `{ data: { token } }` (200) or `{ data: null }` (404 = no match). The SDK then
  chains the recovered token into `claim-funnel-token` (A).
- Referrer format (`apps/api/src/services/funnel/install-referrer.ts`): the key
  is `rovenue_funnel_token`; `parseInstallReferrer(raw)` does
  `new URLSearchParams(raw).get("rovenue_funnel_token")`. So the SDK sends the
  **raw referrer string** in `install_referrer`; the server parses it.

## 4. Public API change (RN TS)

```ts
// Before (A): params required
Rovenue.claimInstall(params: ClaimInstallParams): Promise<FunnelClaimResult | null>
// After (B): params optional — native auto-fills on Android
Rovenue.claimInstall(params?: Partial<ClaimInstallParams>): Promise<FunnelClaimResult | null>
```

`Partial<ClaimInstallParams>` is passed to native as-is; the Android native
module merges it over auto-collected values (caller wins). On iOS the params are
used as supplied (A behavior) until sub-project C adds iOS collection — so an
argument-less `claimInstall()` is only fully functional on Android in this
sub-project.

## 5. Implementation

### 5.1 `packages/sdk-rn/android/build.gradle`
Add to `dependencies`:
```gradle
implementation 'com.android.installreferrer:installreferrer:2.2'
```
(minSdk 24 / compileSdk 34 — compatible.)

### 5.2 `packages/sdk-rn/android/.../RovenueModule.kt`
Two private helpers (mirroring the existing `readPackageVersionName()` pattern;
`Context` via `appContext.reactContext?.applicationContext`):

- `private suspend fun readInstallReferrer(): String?`
  - Build an `InstallReferrerClient`, bridge `startConnection`'s
    `InstallReferrerStateListener` callback into a coroutine via
    `suspendCancellableCoroutine`, wrapped in `withTimeoutOrNull(3_000)`.
  - On `OK`: return `referrerClient.installReferrer.installReferrer` (the raw
    string). On `FEATURE_NOT_SUPPORTED` / `SERVICE_UNAVAILABLE` / any throwable /
    timeout / no Play Store: return `null`. Always `endConnection()` in a finally.
- `private fun collectAndroidContext(): AndroidInstallContext`
  - `locale` = `Locale.getDefault().toLanguageTag()` (e.g. "en-US")
  - `timezone` = `TimeZone.getDefault().id` (e.g. "Europe/Istanbul")
  - `screenDims` = from `context.resources.displayMetrics` as `"<width>x<height>"`
  - `deviceModel` = `Build.MODEL`
  - Pure formatting → extract into a unit-testable helper (see §6).

Modify the existing `AsyncFunction("claimInstall") Coroutine { params: Map<String, Any?> -> ... }`:
- Treat `params` as overrides. Build `ClaimInstallParams` with:
  - `platform` = `params["platform"] ?: "android"`
  - `locale` = `params["locale"] ?: ctx.locale`
  - `timezone` = `params["timezone"] ?: ctx.timezone`
  - `screenDims` = `params["screenDims"] ?: ctx.screenDims`
  - `deviceModel` = `params["deviceModel"] ?: ctx.deviceModel`
  - `installReferrer` = `params["installReferrer"] ?: readInstallReferrer()`
- Forward to `Rovenue.shared.claimInstall(p)` exactly as today; same return
  mapping (`{subscriberId, funnelAnswersJson}` or null).

If the referrer is unavailable, `installReferrer` is null and the request still
carries device context; the backend returns 404 (no referrer match) → the method
resolves `null`. Graceful.

### 5.3 RN TS (`packages/sdk-rn/src/`)
- `src/api/funnel.ts`: change `claimInstall(params: ClaimInstallParams)` →
  `claimInstall(params: Partial<ClaimInstallParams> = {})`; pass `params`
  through unchanged (native fills the rest).
- `src/specs/RovenueModule.types.ts`: the native `claimInstall` param type
  becomes a partial/all-optional object (the native module tolerates missing
  keys).
- `index.ts`: no surface change beyond the optional signature (already exported).

## 6. Testing

- **Android native (`RovenueModule.kt`)**: compile-checked only — the Expo module
  is built by Gradle but has no instrumented tests, and `InstallReferrerClient`
  needs an Android runtime + Play Store. Verified by the Android library
  compiling + real-device integration. **Honest limitation, stated explicitly.**
- **Pure formatting helper**: extract the device-context string formatting (e.g.
  `formatScreenDims(width, height) -> "WxH"`, locale/timezone normalization) into
  a plain function placed where it can be unit-tested under `sdk-kotlin`'s JUnit5
  suite (`./gradlew testDebugUnitTest`) — no Android runtime needed for the pure
  parts.
- **RN TS (Vitest)**: `claimInstall()` with no args calls the native module with
  an empty/partial object; `claimInstall({ installReferrer: "x" })` passes the
  override through. (The native auto-fill itself isn't exercised in JS — it's
  native — but the optional-params contract + pass-through is.)
- **Façade unaffected**: `sdk-kotlin` `claimInstall(params)` is unchanged; its
  existing test stays green.

## 7. Versioning

Additive, non-breaking (optional params widen the API). Minor bump of the
unified version (crate = TS `SDK_VERSION` = npm `package.json`) in lockstep, per
the current scheme + the `version.test.ts` parity assertions.

## 8. Out-of-scope dependencies noted for later sub-projects

- iOS `claimInstall` auto-collection (clipboard token + minimal/no device
  context, with the backend IP-only relaxation) — sub-project C.
- Automatic first-launch resolution that calls `claimInstall()` once and applies
  a timeout across sources — sub-project E (uses A's `funnel_claim_state` to run
  once per install).
