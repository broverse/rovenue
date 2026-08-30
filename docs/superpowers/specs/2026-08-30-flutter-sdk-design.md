# Flutter SDK — Design Spec

**Date:** 2026-08-30
**Roadmap area:** §7 SDK platform coverage (55 → 95) — "Flutter SDK — highest ROI"
**Parity bar:** the shipped RN façade (`@rovenue/react-native-sdk` 0.16.0) feature-for-feature; RevenueCat's `purchases_flutter` for ergonomics.

## 1. Context (from the 2026-08-30 exploration)

- **The Rust core is not the whole SDK.** `packages/core-rs/src/librovenue.udl` (v0.16.0) exposes config/identity/entitlements/offerings/receipts/paywall-fetch/remote-config/experiments/events/attributes/virtual-currency/funnels + three callback interfaces (`Observer`, `LogSink`, `FunnelClaimListener`) and 24 `ErrorKind`s. But **store purchase flows, enriched StoreProduct hydration, and paywall rendering are implemented natively per façade** — `ApplePurchaseFlow.swift`/`ProductMapping.swift`/`PaywallUI/*` in sdk-swift, `PlayPurchaseFlow.kt`/`OfferingsHydration.kt`/`paywallui/*` in sdk-kotlin.
- **RN is the precedent, not a warning.** `sdk-rn` bridges through Expo Modules to those same Swift/Kotlin façades (`ios/RovenueModule.swift`, `android/.../RovenueModule.kt`), keeps ~50 methods in a TS spec, and hosts the *native* paywall renderers through an Expo view (`RovenuePaywallExpoView.swift/.kt`) — passing only a placement identifier across the bridge, never the paywall object.
- **`render-fixtures.json` is a three-platform decoder contract** (web/SwiftUI/Android-Views). RN is not a fourth renderer and neither is Flutter.
- **Bucketing** (`bucketing-vectors.json`) is satisfied in Rust core; the façades never draw variants themselves.
- **CI/release exist and are strict**: `.github/workflows/sdk.yml` (fmt/clippy/test, bindgen, swift test, gradle test, RN vitest), `release-sdk.yml` with a **4-way version-parity gate** (`sdk-rn/src/__tests__/version.test.ts` reads Cargo.toml and asserts crate == RN == Kotlin == Swift). All four manifests are at **0.16.0** (ROADMAP's "align versions" item is stale — this spec corrects it).
- **Open blocker that reaches this work**: `packages/sdk-swift/Rovenue.podspec:21` still carries a placeholder `sha256` pointing at an unpublished GitHub release zip. Any iOS plugin that depends on the `Rovenue` pod by version cannot resolve until that release exists. (`sdk-rn`'s pod sidesteps it with `:path` — which is exactly why it is not externally consumable.)

## 2. Goals

1. `rovenue_flutter` — a **federated plugin** giving Dart apps the RN façade's full surface: configure, identity, entitlements (+ reactive stream), offerings, **purchase/restore**, paywalls (fetch + native view), remote config, experiments, virtual currencies, attributes, events, funnels, logging.
2. **Pigeon-generated** type-safe channels (no hand-written `MethodChannel` string maps) over the existing Swift/Kotlin façades — one generated contract, three languages, no drift.
3. **Native paywall hosting** via `PlatformView` (`UiKitView`/`AndroidView`) around `RovenuePaywallView` — no Dart renderer, no fourth decoder.
4. Rich, typed errors: `RovenueException` carrying `kind` (all 24 `ErrorKind`s), `detail`, `serverCode`, `httpStatus`, `retryable`.
5. Join the version-parity gate: **5-way** (crate == RN == Kotlin == Swift == pubspec), all at 0.16.0.
6. CI: a `flutter` job in `sdk.yml` (analyze + test), plus an example app that builds on both platforms.

## 3. Non-goals

- **Pure `dart:ffi` over `librovenue`.** It would reach the core but lose StoreKit/Play purchase flows, product hydration, and paywall UI — all native-only — and uniffi has no Dart backend in this repo. Rejected explicitly so nobody re-litigates it later.
- **A Dart paywall renderer** (would make `render-fixtures.json` a four-platform contract) and a **Dart bucketing implementation** (core owns variant draw).
- Flutter **web/desktop** targets (the SDK is mobile-first; Web SDK is its own §7 item).
- Publishing to pub.dev, or fixing `sdk-rn`'s pod consumability. Publication is release-gated on §4.6's prerequisite; the RN pod is a separate roadmap item.

## 4. Design

### 4.1 Package layout (federated, Flutter's own recommendation)

```
packages/sdk-flutter/
  rovenue_flutter/                  # app-facing package (Dart API, PlatformView widget, docs)
  rovenue_flutter_platform_interface/  # the contract: Pigeon-generated + abstract base
  rovenue_flutter_ios/              # iOS implementation (Swift, depends on the Rovenue pod)
  rovenue_flutter_android/          # Android implementation (Kotlin, depends on dev.rovenue:sdk)
  example/                          # runnable app + integration_test
```

Federation is what lets the iOS/Android implementations version and publish independently of the Dart API — and it is how `purchases_flutter` and every serious plugin is structured. Endorsement wiring in `rovenue_flutter/pubspec.yaml` so app authors add one dependency.

### 4.2 The bridge: Pigeon

One `pigeons/rovenue_api.dart` defines `@HostApi()` (Dart→native calls) and `@FlutterApi()` (native→Dart events); `pigeon` codegen emits Dart, Swift, and Kotlin. This replaces RN's hand-maintained `RovenueModule.types.ts` + two hand-written native modules, and makes an added method a compile error on every side until wired.

- **HostApi** mirrors the RN spec's ~50 methods (the authoritative list is RN's `src/specs/RovenueModule.types.ts` — the plan enumerates them), grouped: configure/lifecycle, identity, entitlements, offerings, purchases (`purchase(productId, options)`, `restorePurchases()`), paywalls (`getPaywall`, `getPaywallPreview`, `setFallbackPlacements`, `logPaywallShown/Closed`), remote config, experiments, virtual currencies, attributes (+ `setEmail/DisplayName/PhoneNumber/PushToken` conveniences), events, funnels (`claimFunnelToken`, `claimInstall`, `claimViaEmail`, `extractFunnelToken` stays pure-Dart), logging.
- **FlutterApi** carries the three callback streams: `onChange(ChangeEvent)`, `onLog(LogRecord)`, `onFunnelClaim(FunnelClaimResult)`. Dart exposes them as broadcast `Stream`s (`Rovenue.changes`, `Rovenue.funnelClaims`), mirroring Swift's async streams and RN's emitter.
- **Errors**: native catches the façade's error type and throws a `PlatformException` whose `code` is the `ErrorKind` name and whose `details` is a map `{detail, serverCode, httpStatus, retryable}`. Dart maps it to `RovenueException`. **This is strictly better than RN**, where only `code`+`message` survive the Expo JSI bridge and extras had to be smuggled inside the message as a JSON envelope (`@rovenue/err1:`); Flutter's `details` is a first-class map, so no envelope hack — and the plan forbids copying one.

### 4.3 Paywall view

`RovenuePaywallView` Dart widget → `UiKitView`/`AndroidView` → native `PlatformViewFactory` that instantiates the existing `RovenuePaywallView` (SwiftUI / Android Views). Creation params: `placementIdentifier`, `locale`, `colorSchemeOverride`, `hasRestoreHandler`, `hasUrlHandler` — **the paywall object never crosses the channel**; the native side re-resolves it, exactly as `sdk-rn/src/paywall-view/native-view.ts` does. Callbacks (`onPurchaseCompleted`, `onPurchaseFailed`, `onClose`, `onRestore`, `onUrl`) ride a per-view `MethodChannel` keyed by view id.

### 4.4 Dart API shape

`Rovenue` singleton mirroring the Swift/Kotlin façades (`Rovenue.instance.configure(...)`), `Future`-returning methods, `Stream` getters, immutable data classes with `==`/`hashCode`/`copyWith` hand-written on the Pigeon-generated types' Dart wrappers (Pigeon's own classes stay internal to the platform interface; the app-facing package re-exports friendlier types so the generated contract can change without breaking apps).

### 4.5 Testing

- **Platform interface**: unit tests with a mock `HostApi` (Pigeon generates a test harness); every Dart method asserts the exact channel call + argument marshalling; error mapping tested for all 24 `ErrorKind`s (table-driven).
- **iOS/Android implementations**: Swift/Kotlin unit tests asserting the plugin calls the right façade method (the façades themselves are already covered by `swift test` / `gradle test`).
- **Example app**: `integration_test` driving configure → offerings → paywall view mount → entitlement stream, run headless in CI on both platforms where the runners allow; at minimum `flutter build` for iOS (no signing) and Android.
- **No self-confirming tests**: the version-parity test reads the real `Cargo.toml`; channel tests assert against the generated contract, not a hand-copied mirror of it.

### 4.6 Release / prerequisite (honest about the blocker)

- `rovenue_flutter_ios`'s podspec depends on `Rovenue` **by version** (`s.dependency 'Rovenue', '0.16.0'`), which is correct for a published plugin and **cannot resolve until the Swift pod is actually published** — `Rovenue.podspec`'s `sha256` is still a placeholder over an unpublished release zip. The monorepo example app uses a documented **path override** (`pod 'Rovenue', :path => '../../sdk-swift'` in the example's Podfile) so development and CI work today.
- Therefore: **publishing `rovenue_flutter_ios` to pub.dev is blocked on running `packages/sdk-swift/scripts/release-pod.sh` + `pod trunk push`** — an external side effect outside this spec. The spec ships the plugin correct-by-construction and documents the release order; it does not fake the dependency.
- `rovenue_flutter_android` depends on `dev.rovenue:sdk:0.16.0` from the configured Maven repo, with a `mavenLocal()` fallback documented for development.
- `release-sdk.yml` gains a `flutter` boolean and a `publish-flutter` job (`dart pub publish --force`) that runs only after `verify`; `verify` grows to the **5-way** parity assertion.

## 5. Data changes

None. No API, DB, or wire changes — this is a client façade over existing endpoints.

## 6. Risks / decisions worth stating

- **Pigeon over hand-written channels** costs one codegen step in the build but removes the exact class of drift RN carries (its TS spec lists methods the UDL doesn't).
- **Federated over single-package** costs four pubspecs but is required for independent platform publishing and matches ecosystem norms.
- **Version lockstep**: joining the parity gate means a Flutter release can never lag the crate — deliberate; a lagging façade is how `sdk-swift`/`sdk-kotlin` drifted before.
- **No Dart-side caching or state**: the native façades already own the offline cache and reactive store; Dart holds only stream controllers. Duplicating state in Dart would create a second source of truth.

## 7. Acceptance criteria

1. An app adds one dependency (`rovenue_flutter`), calls `Rovenue.instance.configure(apiKey: ...)`, and can: read/refresh entitlements, listen to `changes`, fetch offerings, **complete a purchase and restore**, fetch a paywall, mount `RovenuePaywallView` and receive its callbacks, read remote config/experiments/virtual currencies, set attributes, track events, and claim a funnel token — on both platforms.
2. Every `ErrorKind` surfaces as a typed `RovenueException` with `detail`/`serverCode`/`httpStatus`/`retryable` intact (no message-envelope hack).
3. `flutter analyze` clean; platform-interface + implementation tests green; example app builds for iOS and Android; `integration_test` passes on at least one platform in CI.
4. Version parity is **5-way** and enforced in CI; `sdk.yml` has a `flutter` job.
5. Docs: `apps/docs` gets a Flutter quickstart + API page matching the other SDKs' structure; the RN↔Flutter feature table shows parity.
6. Zero changes to the Rust core, the three existing façades' public APIs, or `render-fixtures.json`.
