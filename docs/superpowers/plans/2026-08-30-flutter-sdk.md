# Flutter SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rovenue_flutter` — a federated Flutter plugin with the RN façade's full surface, bridging to the existing Swift/Kotlin façades via Pigeon, hosting the native paywall renderers through PlatformViews.

**Architecture:** Four Dart packages (app-facing, platform-interface, ios, android). One Pigeon contract generates Dart/Swift/Kotlin channel code; the native plugins are thin adapters over `Rovenue.shared` (Swift) and `Rovenue` (Kotlin). No Rust/FFI work, no new renderer, no state duplicated in Dart.

**Tech Stack:** Dart/Flutter (stable channel), Pigeon codegen, Swift (CocoaPods plugin), Kotlin (Gradle plugin), existing `packages/sdk-swift` + `packages/sdk-kotlin`.

**Spec:** `docs/superpowers/specs/2026-08-30-flutter-sdk-design.md`

## Global Constraints

- NEVER create or switch branches/worktrees; commit on current HEAD (main). Conventional commits.
- **Zero changes** to: the Rust core (`packages/core-rs`), the three existing façades' public APIs, `render-fixtures.json`, `bucketing-vectors.json`, or any backend code. If a task seems to need one, stop and escalate.
- Test/build throttle (user directive, binding): every heavy command runs `nice -n 19`; vitest `--maxWorkers=2`; suites strictly sequential; `flutter test`/`gradle`/`swift test` also get the `nice -n 19` prefix.
- Version: everything ships at **0.16.0** (crate == RN == Kotlin == Swift == Flutter pubspecs). The 5-way parity test is the gate.
- Dart style: `flutter analyze` must be clean with the repo's lint set (`package:flutter_lints`); public API gets dartdoc comments; no `dynamic` in public signatures.
- **No RN-style error envelope.** Errors cross as `PlatformException(code: <ErrorKind name>, message: detail, details: {"detail","serverCode","httpStatus","retryable"})` and map to `RovenueException`. Smuggling fields inside the message string is a review-blocking defect.
- The paywall object never crosses the channel — the PlatformView receives `placementIdentifier` and the native side re-resolves it (RN precedent: `packages/sdk-rn/src/paywall-view/native-view.ts`).
- Reference implementations to mirror (read before writing): `packages/sdk-rn/src/specs/RovenueModule.types.ts` (the method contract), `packages/sdk-rn/ios/RovenueModule.swift`, `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`, `packages/sdk-rn/android/.../RovenuePaywallExpoView.kt`.
- **HostApi surface = the 46 methods in RN's native spec** (that file minus the two Expo bookkeeping hooks `addListener`/`removeListeners`). `getPaywallPreview` and `logPaywallShown/Closed` are deliberately out of v1: RN does not expose preview either (it needs a dashboard-issued token), and paywall analytics ride `enqueuePaywallEvent`.

---

### Task 1: Federated skeleton + tooling

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter/pubspec.yaml`, `.../rovenue_flutter/lib/rovenue_flutter.dart`, `.../rovenue_flutter/analysis_options.yaml`
- Create: `packages/sdk-flutter/rovenue_flutter_platform_interface/pubspec.yaml`, `.../lib/rovenue_flutter_platform_interface.dart`, `.../analysis_options.yaml`
- Create: `packages/sdk-flutter/rovenue_flutter_ios/pubspec.yaml`, `.../ios/rovenue_flutter_ios.podspec`, `.../ios/Classes/.gitkeep`
- Create: `packages/sdk-flutter/rovenue_flutter_android/pubspec.yaml`, `.../android/build.gradle`, `.../android/settings.gradle`, `.../android/src/main/AndroidManifest.xml`
- Create: `packages/sdk-flutter/README.md` (layout + dev setup, incl. the pod path-override note)
- Modify: root `.gitignore` (Dart/Flutter artifacts: `.dart_tool/`, `build/`, `.flutter-plugins*`, `Pods/`, `*.iml`), root `pnpm-workspace.yaml` **only if** it would otherwise try to glob these dirs (check; Dart packages have no package.json so likely no change — say which in the report)

**Interfaces:**
- Produces: package names `rovenue_flutter`, `rovenue_flutter_platform_interface`, `rovenue_flutter_ios`, `rovenue_flutter_android`; all `version: 0.16.0`; `environment: sdk: ">=3.4.0 <4.0.0"`, `flutter: ">=3.22.0"`.
- `rovenue_flutter/pubspec.yaml` declares the federation:

```yaml
flutter:
  plugin:
    platforms:
      ios:
        default_package: rovenue_flutter_ios
      android:
        default_package: rovenue_flutter_android
```

- `rovenue_flutter_ios/pubspec.yaml`:

```yaml
flutter:
  plugin:
    implements: rovenue_flutter
    platforms:
      ios:
        pluginClass: RovenueFlutterIosPlugin
        dartPluginClass: RovenueFlutterIos
        sharedDarwinSource: false
```

- `rovenue_flutter_android/pubspec.yaml` mirrors it with `pluginClass: RovenueFlutterAndroidPlugin`, `dartPluginClass: RovenueFlutterAndroid`, package `dev.rovenue.flutter`.
- `rovenue_flutter_ios/ios/rovenue_flutter_ios.podspec` depends on the published pod plus Flutter:

```ruby
s.dependency 'Flutter'
s.dependency 'Rovenue', '0.16.0'
s.platform = :ios, '15.0'
s.swift_version = '5.9'
```

  with a comment stating the release-order prerequisite from spec §4.6 (the `Rovenue` pod must be published; the example app overrides with `:path`).
- `rovenue_flutter_android/android/build.gradle` depends on `implementation "dev.rovenue:sdk:0.16.0"` with `mavenLocal()` first in `repositories` and a comment saying why.

- [ ] **Step 1: Create the four packages and the podspec/gradle wiring above.** Each `lib/<name>.dart` starts as a single `library` declaration + a dartdoc header; no logic yet.
- [ ] **Step 2: Verify the toolchain sees them**

Run: `cd /Volumes/Development/rovenue/packages/sdk-flutter/rovenue_flutter && nice -n 19 flutter pub get && nice -n 19 flutter analyze`
Expected: PASS (no issues). Repeat `pub get` + `analyze` in the other three packages.
If `flutter` is not installed on this machine, STOP and report BLOCKED with the exact missing tool — do not fake the run.

- [ ] **Step 3: Commit** `feat(sdk-flutter): federated plugin skeleton`

---

### Task 2: Pigeon contract + codegen

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter_platform_interface/pigeons/rovenue_api.dart`
- Create (generated, committed): `.../lib/src/messages.g.dart`, `packages/sdk-flutter/rovenue_flutter_ios/ios/Classes/Messages.g.swift`, `packages/sdk-flutter/rovenue_flutter_android/android/src/main/kotlin/dev/rovenue/flutter/Messages.g.kt`
- Modify: `.../rovenue_flutter_platform_interface/pubspec.yaml` (dev_dependency `pigeon: ^22.0.0`), add script docs to `packages/sdk-flutter/README.md`

**Interfaces:**
- Produces the contract every later task consumes. Shape (abbreviated — the full method list is the 46 from RN's spec; enumerate them all):

```dart
import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(PigeonOptions(
  dartOut: 'lib/src/messages.g.dart',
  swiftOut: '../rovenue_flutter_ios/ios/Classes/Messages.g.swift',
  kotlinOut: '../rovenue_flutter_android/android/src/main/kotlin/dev/rovenue/flutter/Messages.g.kt',
  kotlinOptions: KotlinOptions(package: 'dev.rovenue.flutter'),
  dartPackageName: 'rovenue_flutter_platform_interface',
))
class PigeonUser { PigeonUser({required this.rovenueId, this.appUserId}); String rovenueId; String? appUserId; }
class PigeonEntitlement { PigeonEntitlement({required this.id, required this.active, this.expiresAt, this.productId}); String id; bool active; String? expiresAt; String? productId; }
// … PigeonOffering(s), PigeonStoreProduct, PigeonPurchaseResult, PigeonExperimentAssignment,
//     PigeonPaywall, PigeonFunnelClaim, PigeonChangeEvent, PigeonLogRecord — field-for-field
//     from RN's DTOs in packages/sdk-rn/src/specs/RovenueModule.types.ts.

enum PigeonLogLevel { off, error, warn, info, debug, trace }
enum PigeonProductType { subscription, consumable, nonConsumable }
enum PigeonSessionEventKind { open, background, close }

@HostApi()
abstract class RovenueHostApi {
  void configure(String apiKey, String? baseUrl, PigeonLogLevel logLevel, String? appVersion, String? environment);
  void shutdown();
  void setForeground(bool foreground);
  String getVersion();
  String? getAppVersion();

  @async PigeonUser currentUser();
  @async void identify(String appUserId);
  @async void logOut();

  @async PigeonEntitlement? entitlement(String id);
  @async List<PigeonEntitlement> entitlementsAll();
  @async void refreshEntitlements();

  @async Map<String, int> virtualCurrencies();
  @async int virtualCurrency(String code);
  @async void refreshVirtualCurrencies();

  @async PigeonOfferings getOfferings();
  @async PigeonPaywall? getPaywall(String placementId, String? locale);
  @async int setFallbackPlacements(String json);
  @async PigeonPurchaseResult purchase(String productId, PigeonProductType productType, String? promotionalOfferId, String? basePlanId, String? offerId);
  @async PigeonPurchaseResult restorePurchases();

  @async void refreshRemoteConfig();
  @async bool remoteConfigBool(String key, bool fallback);
  @async String remoteConfigString(String key, String fallback);
  @async int remoteConfigInt(String key, int fallback);
  @async double remoteConfigDouble(String key, double fallback);
  @async String? remoteConfigJson(String key);
  @async List<String> remoteConfigKeys();
  @async String remoteConfigAllJson();
  @async PigeonExperimentAssignment? experiment(String key);
  @async List<PigeonExperimentAssignment> experimentsAll();

  @async String getAppAccountToken();
  @async void recordSessionEvent(PigeonSessionEventKind kind, String occurredAt, int? durationMs);
  @async int flushSessionEvents();

  @async PigeonFunnelClaim claimFunnelToken(String token);
  @async PigeonFunnelClaim? claimInstall(PigeonClaimInstallParams params);
  @async void claimViaEmail(String email);
  @async PigeonFunnelClaim? claimFromClipboard();
  @async String installId();
  @async bool hasResolvedFunnelClaim();

  @async void track(String envelopeJson);
  @async void enqueuePaywallEvent(String envelopeJson);

  @async void setAttributes(Map<String, String?> attributes);
  @async void setEmail(String? email);
  @async void setDisplayName(String? name);
  @async void setPhoneNumber(String? phone);
  @async void setPushToken(String? token);
  @async int flushAttributes();
}

@FlutterApi()
abstract class RovenueFlutterApi {
  void onChange(PigeonChangeEvent event);
  void onLog(PigeonLogRecord record);
  void onFunnelClaim(PigeonFunnelClaim claim);
}
```

- [ ] **Step 1: Write the contract** with ALL 46 host methods and the DTOs, field-for-field against `packages/sdk-rn/src/specs/RovenueModule.types.ts`. A method or field present there and absent here is a defect.
- [ ] **Step 2: Generate**

Run: `cd /Volumes/Development/rovenue/packages/sdk-flutter/rovenue_flutter_platform_interface && nice -n 19 dart run pigeon --input pigeons/rovenue_api.dart`
Expected: writes the three generated files; `flutter analyze` clean in the interface package.

- [ ] **Step 3: Add a drift guard test** — `test/contract_test.dart` asserting the generated Dart API exposes exactly the expected method count and that a representative method's signature compiles against a mock (Pigeon's generated `RovenueHostApi` is abstract; instantiate a test double implementing it — a compile-time check plus one runtime assertion that all 46 names exist via `noSuchMethod` recording is acceptable; state which you used).
- [ ] **Step 4: Run** `nice -n 19 flutter test` in the interface package. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sdk-flutter): pigeon contract mirroring the RN native surface`

---

### Task 3: Platform interface + error mapping

**Files:**
- Create: `.../rovenue_flutter_platform_interface/lib/src/rovenue_platform.dart` (abstract base), `.../lib/src/method_channel_rovenue.dart` (Pigeon-backed default), `.../lib/src/errors.dart`, `.../lib/src/models.dart` (public data classes), `.../lib/rovenue_flutter_platform_interface.dart` (barrel)
- Test: `.../test/error_mapping_test.dart`, `.../test/method_channel_test.dart`

**Interfaces:**
- Consumes: `messages.g.dart` (Task 2).
- Produces:

```dart
abstract class RovenuePlatform extends PlatformInterface {
  RovenuePlatform() : super(token: _token);
  static final Object _token = Object();
  static RovenuePlatform _instance = MethodChannelRovenue();
  static RovenuePlatform get instance => _instance;
  static set instance(RovenuePlatform v) { PlatformInterface.verifyToken(v, _token); _instance = v; }
  // one method per HostApi entry, returning public models (not Pigeon types)
  Future<List<Entitlement>> entitlementsAll();
  Stream<RovenueChangeEvent> get changes;
  // …
}

enum RovenueErrorKind {
  networkUnavailable, timeout, rateLimited, serverError, invalidApiKey, forbidden,
  notFound, invalidRequest, conflict, invalidArgument, insufficientCredits,
  funnelTokenNotFound, funnelTokenExpired, funnelTokenAlreadyClaimed,
  purchaseCanceled, productNotAvailable, alreadyOwned, paymentDeclined,
  storeServiceUnavailable, ineligible, receiptInvalid, storeProblem, storage, internal,
  unknown, // for a code the SDK does not recognise — never throw a raw PlatformException at app code
}

class RovenueException implements Exception {
  final RovenueErrorKind kind; final String detail;
  final String? serverCode; final int? httpStatus; final bool retryable;
  const RovenueException({required this.kind, required this.detail, this.serverCode, this.httpStatus, this.retryable = false});
}

RovenueException rovenueExceptionFrom(PlatformException e); // exported for the impl packages
```

- The 24 kinds are exactly `ErrorKind` in `packages/core-rs/src/librovenue.udl`; `unknown` is the 25th, ours.

- [ ] **Step 1: Failing tests first** — `error_mapping_test.dart`, table-driven over all 24 kinds:

```dart
void main() {
  const cases = <String, RovenueErrorKind>{
    'NetworkUnavailable': RovenueErrorKind.networkUnavailable,
    'Timeout': RovenueErrorKind.timeout,
    // … all 24, names exactly as in librovenue.udl
  };
  test('maps every ErrorKind name', () {
    for (final entry in cases.entries) {
      final ex = rovenueExceptionFrom(PlatformException(
        code: entry.key, message: 'boom',
        details: {'detail': 'boom', 'serverCode': 'E42', 'httpStatus': 503, 'retryable': true}));
      expect(ex.kind, entry.value);
      expect(ex.detail, 'boom');
      expect(ex.serverCode, 'E42');
      expect(ex.httpStatus, 503);
      expect(ex.retryable, isTrue);
    }
  });
  test('unrecognised code becomes unknown without losing detail', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'SomethingNew', message: 'x'));
    expect(ex.kind, RovenueErrorKind.unknown);
    expect(ex.detail, 'x');
  });
  test('details map absent — no crash, retryable defaults false', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'Timeout', message: null));
    expect(ex.kind, RovenueErrorKind.timeout);
    expect(ex.retryable, isFalse);
  });
}
```

- [ ] **Step 2: Run** `nice -n 19 flutter test test/error_mapping_test.dart`. Expected: FAIL (`rovenueExceptionFrom` undefined).
- [ ] **Step 3: Implement** `errors.dart`, `models.dart`, `rovenue_platform.dart`, `method_channel_rovenue.dart` — the channel impl wraps every Pigeon call in `try/on PlatformException catch (e) { throw rovenueExceptionFrom(e); }` and converts Pigeon DTOs to public models.
- [ ] **Step 4: Add** `method_channel_test.dart` using Pigeon's generated test harness (`TestRovenueHostApi.setUp(fake)`) to assert three representative calls marshal correctly: `entitlementsAll()` (list mapping), `purchase(...)` (enum + optional args), `setAttributes({'a': null})` (nullable map values survive).
- [ ] **Step 5: Run** `nice -n 19 flutter test` in the interface package. Expected: PASS. Then `nice -n 19 flutter analyze`.
- [ ] **Step 6: Commit** `feat(sdk-flutter): platform interface with typed error mapping`

---

### Task 4: iOS implementation

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter_ios/ios/Classes/RovenueFlutterIosPlugin.swift`, `.../ios/Classes/HostApiImpl.swift`, `.../ios/Classes/Mapping.swift`, `.../ios/Classes/EventBridge.swift`
- Create: `.../lib/rovenue_flutter_ios.dart` (registers `RovenueFlutterIos` dart plugin class — a no-op registrant, since the default platform impl is channel-based)
- Test: `.../ios/Tests/HostApiImplTests.swift` (XCTest; wired via the example app's Xcode project or a lightweight SwiftPM test target — pick one and say which)

**Interfaces:**
- Consumes: `Messages.g.swift` (Task 2), the Swift façade `Rovenue.shared` from `packages/sdk-swift`.
- Produces: `RovenueFlutterIosPlugin.register(with:)` installing `RovenueHostApiSetup.setUp(binaryMessenger:api:)` and holding a `RovenueFlutterApi` for events.
- Error contract (every method):

```swift
private func fail(_ error: Error) -> PigeonError {
  if let e = error as? RovenueError {   // the Swift façade's error type
    return PigeonError(code: e.kindName, message: e.detail,
      details: ["detail": e.detail, "serverCode": e.serverCode as Any,
                "httpStatus": e.httpStatus as Any, "retryable": e.retryable])
  }
  return PigeonError(code: "Internal", message: String(describing: error),
    details: ["detail": String(describing: error), "retryable": false])
}
```

  Read `packages/sdk-swift/Sources/Rovenue/Errors.swift` first and use its actual case/property names; `kindName` must equal the UDL `ErrorKind` variant name.
- Events: subscribe to the façade's `changes` / `funnelClaims` async streams once at `configure`, forward on the main thread through `RovenueFlutterApi.onChange/onFunnelClaim`; `Rovenue.setLogHandler` (or its actual name in `Rovenue.swift`) forwards to `onLog`.

- [ ] **Step 1: Mirror `packages/sdk-rn/ios/RovenueModule.swift` method by method** — it already adapts the same façade to a bridge; the differences are Pigeon types instead of Expo's and `PigeonError` instead of Expo exceptions.
- [ ] **Step 2: Unit tests** for `Mapping.swift` (façade type → Pigeon DTO) covering: an entitlement with `expiresAt` nil, an offering with two packages, a purchase result, and one error conversion asserting `code == "PurchaseCanceled"` and `details["retryable"] as? Bool == false`.
- [ ] **Step 3: Run** the iOS tests (`nice -n 19 swift test` if SwiftPM target, else `xcodebuild test` via the example app — state the command used). Expected: PASS.
- [ ] **Step 4: Commit** `feat(sdk-flutter): iOS plugin over the Swift façade`

---

### Task 5: Android implementation

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter_android/android/src/main/kotlin/dev/rovenue/flutter/RovenueFlutterAndroidPlugin.kt`, `.../HostApiImpl.kt`, `.../Mapping.kt`, `.../EventBridge.kt`
- Create: `.../lib/rovenue_flutter_android.dart`
- Test: `.../android/src/test/kotlin/dev/rovenue/flutter/MappingTest.kt`, `.../HostApiImplTest.kt`

**Interfaces:**
- Consumes: `Messages.g.kt` (Task 2), the Kotlin façade `Rovenue` from `packages/sdk-kotlin`.
- Produces: `RovenueFlutterAndroidPlugin : FlutterPlugin, ActivityAware` — `ActivityAware` is required because `purchase()` needs the current `Activity` for Play Billing (see `packages/sdk-rn/android/.../RovenueModule.kt` for how it obtains one).
- Suspend-fn façade calls run on a plugin-scoped `CoroutineScope(Dispatchers.Main + SupervisorJob())`; results marshal back through Pigeon's `Result<T>` callbacks.
- Errors: catch the façade's `RovenueException` and produce `FlutterError(code = kindName, message = detail, details = mapOf("detail" to …, "serverCode" to …, "httpStatus" to …, "retryable" to …))`. Read `packages/sdk-kotlin/.../RovenueException.kt` for the real property names.

- [ ] **Step 1: Mirror `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`** method by method, with Pigeon types and `FlutterError`.
- [ ] **Step 2: Unit tests** for `Mapping.kt` (same four cases as iOS: nil-expiry entitlement, two-package offering, purchase result, one error conversion asserting `code == "PurchaseCanceled"` and `details["retryable"] == false`) plus one `HostApiImplTest` proving `purchase()` fails with `code == "Internal"` and a clear message when no Activity is attached (rather than crashing).
- [ ] **Step 3: Run** `cd packages/sdk-flutter/rovenue_flutter_android/android && nice -n 19 ./gradlew test --no-daemon` (or the example app's gradle wrapper if the plugin has none — state which). Expected: PASS.
- [ ] **Step 4: Commit** `feat(sdk-flutter): Android plugin over the Kotlin façade`

---

### Task 6: App-facing Dart API

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter/lib/src/rovenue.dart`, `.../lib/src/types.dart` (re-exports of the interface's models + Flutter-friendly extras), `.../lib/rovenue_flutter.dart` (barrel exporting `Rovenue`, models, `RovenueException`, `RovenueErrorKind`, `RovenuePaywallView` [added in Task 7], `extractFunnelToken`)
- Create: `.../lib/src/funnel_token.dart` (pure-Dart `extractFunnelToken(String)` — port `packages/sdk-rn/src/api/funnel.ts`'s extractor, same regex/rules)
- Test: `.../test/rovenue_test.dart`, `.../test/funnel_token_test.dart`

**Interfaces:**
- Consumes: `RovenuePlatform.instance` (Task 3).
- Produces the public API:

```dart
class Rovenue {
  static final Rovenue instance = Rovenue._();
  Rovenue._();
  Future<void> configure({required String apiKey, String? baseUrl, RovenueLogLevel logLevel = RovenueLogLevel.warn, String? appVersion, String? environment});
  Future<RovenueUser> currentUser();
  Future<void> identify(String appUserId);
  Future<void> logOut();
  Future<Entitlement?> entitlement(String id);
  Future<List<Entitlement>> entitlementsAll();
  Future<void> refreshEntitlements();
  Future<Offerings> getOfferings();
  Future<PurchaseResult> purchase(StoreProduct product, {String? promotionalOfferId, SubscriptionOption? option});
  Future<PurchaseResult> restorePurchases();
  Future<Paywall?> getPaywall(String placementIdentifier, {String? locale});
  Future<int> setFallbackPlacements(String json);
  // remote config, experiments, virtual currencies, attributes, events, funnels, session, logging…
  Stream<RovenueChangeEvent> get changes;
  Stream<FunnelClaim> get funnelClaims;
  Stream<RovenueLogRecord> get logs;
}
```

- `purchase` takes the `StoreProduct` (and optional `SubscriptionOption`) rather than raw ids, and unpacks `productId`/`productType`/`basePlanId`/`offerId` internally — matching the Swift/Kotlin façades' ergonomics rather than the wire shape.
- Streams are broadcast and lazily subscribe the platform interface; multiple listeners must not double-register (test it).

- [ ] **Step 1: Failing tests** — `rovenue_test.dart` installs a fake `RovenuePlatform` (subclass with recorded calls) via `RovenuePlatform.instance = fake` and asserts: `purchase(product, option: opt)` forwards the right five fields; `entitlementsAll()` passes models through; `changes` yields events from the fake and supports two simultaneous listeners with one underlying subscription; a thrown `RovenueException` propagates unwrapped. `funnel_token_test.dart` ports RN's extractor cases (valid deep link, query param, no token → null) — read `packages/sdk-rn/src/api/funnel.ts` and its test for the exact inputs.
- [ ] **Step 2: Run** `nice -n 19 flutter test` in `rovenue_flutter`. Expected: FAIL (undefined `Rovenue`).
- [ ] **Step 3: Implement** the façade + token extractor.
- [ ] **Step 4: Run** `nice -n 19 flutter test` then `nice -n 19 flutter analyze`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(sdk-flutter): public Dart API`

---

### Task 7: Native paywall PlatformView

**Files:**
- Create: `packages/sdk-flutter/rovenue_flutter/lib/src/paywall_view.dart`
- Create: `packages/sdk-flutter/rovenue_flutter_ios/ios/Classes/PaywallPlatformView.swift`, `.../PaywallViewFactory.swift`
- Create: `packages/sdk-flutter/rovenue_flutter_android/android/src/main/kotlin/dev/rovenue/flutter/PaywallPlatformView.kt`, `.../PaywallViewFactory.kt`
- Modify: the two plugin registrants (Task 4/5) to register the factory under view type `dev.rovenue.flutter/paywall_view`
- Test: `packages/sdk-flutter/rovenue_flutter/test/paywall_view_test.dart`

**Interfaces:**
- Produces:

```dart
class RovenuePaywallView extends StatefulWidget {
  const RovenuePaywallView({
    super.key,
    required this.placementIdentifier,
    this.locale,
    this.colorScheme,              // RovenueColorScheme.light | .dark | null = system
    this.onPurchaseCompleted,      // void Function(PurchaseResult)
    this.onPurchaseFailed,         // void Function(RovenueException)
    this.onClose,                  // VoidCallback
    this.onRestore,                // VoidCallback?  — presence toggles hasRestoreHandler
    this.onUrl,                    // void Function(String)? — presence toggles hasUrlHandler
  });
}
```

- Creation params sent to the platform view (exactly, mirroring RN's `native-view.ts`): `{"placementIdentifier": String, "locale": String?, "colorSchemeOverride": String?, "hasRestoreHandler": bool, "hasUrlHandler": bool}`. **No paywall object.**
- Per-view callback channel: `dev.rovenue.flutter/paywall_view_<viewId>`, methods `onPurchaseCompleted` (args = purchase-result map), `onPurchaseFailed` (args = the error map shape from the Global Constraints), `onCloseRequested`, `onRestoreRequested`, `onUrlRequested` (args `{"url": String}`).
- iOS: `PaywallPlatformView` wraps `UIHostingController(rootView: RovenuePaywallView(...))` — copy the prop-defer and reload behavior from `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`. Android: wraps `dev.rovenue.sdk.paywallui.RovenuePaywallView`, mirroring `RovenuePaywallExpoView.kt`.

- [ ] **Step 1: Failing Dart test** — `paywall_view_test.dart` uses `TestDefaultBinaryMessengerBinding` to intercept the platform-view creation message and asserts the creation params map equals the five keys above with `hasRestoreHandler`/`hasUrlHandler` reflecting whether callbacks were passed; a second test pushes an `onPurchaseFailed` message through the per-view channel and asserts the widget's callback receives a `RovenueException` (not a raw `PlatformException`).
- [ ] **Step 2: Run** `nice -n 19 flutter test test/paywall_view_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** the Dart widget, then the two native factories/views.
- [ ] **Step 4: Run** the Dart test (PASS) and re-run the iOS/Android unit suites from Tasks 4-5 to prove the registrant changes didn't break them.
- [ ] **Step 5: Commit** `feat(sdk-flutter): native paywall PlatformView`

---

### Task 8: Example app + integration test

**Files:**
- Create: `packages/sdk-flutter/example/` (standard `flutter create` layout: `pubspec.yaml`, `lib/main.dart`, `ios/`, `android/`), `example/integration_test/smoke_test.dart`
- Modify: `example/ios/Podfile` — add the documented dev override `pod 'Rovenue', :path => '../../../sdk-swift'` with a comment pointing at spec §4.6
- Modify: `example/android/build.gradle` — `mavenLocal()` in `repositories` so a locally-published `dev.rovenue:sdk` resolves

**Interfaces:**
- `lib/main.dart` exercises: configure → `getOfferings` → list products → `purchase` button → `entitlementsAll` + live `changes` stream → a route mounting `RovenuePaywallView` with all five callbacks logging to screen.
- `integration_test/smoke_test.dart` runs against a **fake platform** (installs a `RovenuePlatform` fake before `runApp`) so it needs no network or store: asserts the widget tree builds, the entitlement list renders from the fake, and the paywall route mounts a `PlatformViewLink`.

- [ ] **Step 1: Scaffold the example, wire the dev overrides, write `main.dart`.**
- [ ] **Step 2: Write the integration test** per the interface above.
- [ ] **Step 3: Run** `cd packages/sdk-flutter/example && nice -n 19 flutter test integration_test/smoke_test.dart` (headless via `flutter test`, not a device). Expected: PASS.
- [ ] **Step 4: Build both platforms** — `nice -n 19 flutter build apk --debug` and `nice -n 19 flutter build ios --no-codesign`. If either toolchain is unavailable on this machine, report exactly which and mark that build UNVERIFIED in the report rather than claiming it passed.
- [ ] **Step 5: Commit** `feat(sdk-flutter): example app with integration smoke test`

---

### Task 9: 5-way version parity + CI

**Files:**
- Modify: `packages/sdk-rn/src/__tests__/version.test.ts` (add the Flutter pubspecs to the parity assertion)
- Modify: `.github/workflows/sdk.yml` (new `flutter` job; add `packages/sdk-flutter/**` to the path filters)
- Modify: `.github/workflows/release-sdk.yml` (`flutter` boolean input; `publish-flutter` job gated on `verify`)
- Modify: `scripts/sdk-parity.sh` (add the Flutter analyze/test steps)

**Interfaces:**
- Parity test reads `packages/sdk-flutter/*/pubspec.yaml` and asserts every `version:` equals the crate version already parsed from `Cargo.toml` — **all four** Flutter pubspecs, not just the app-facing one.
- `sdk.yml` `flutter` job:

```yaml
  flutter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with: { channel: stable }
      - run: flutter --version
      - name: Analyze + test each package
        run: |
          for p in rovenue_flutter_platform_interface rovenue_flutter rovenue_flutter_ios rovenue_flutter_android; do
            (cd packages/sdk-flutter/$p && flutter pub get && flutter analyze && flutter test || exit 1)
          done
```

  (`rovenue_flutter_ios`/`_android` have no Dart tests yet — `flutter test` on a package with no `test/` dir exits 0; verify and keep the loop uniform.)
- `publish-flutter` job runs `dart pub publish --force` for the four packages in dependency order (platform_interface → ios/android → rovenue_flutter), and **must carry a comment** that iOS publication is release-gated on the `Rovenue` pod being live (spec §4.6).

- [ ] **Step 1: Extend the parity test first** (it will fail until the pubspecs exist — they do, from Task 1). Run `cd apps/api && true; nice -n 19 pnpm --filter @rovenue/react-native-sdk test -- src/__tests__/version.test.ts`. Expected: PASS (all at 0.16.0).
- [ ] **Step 2: Wire the two workflows + the parity script.** Validate YAML by running `nice -n 19 npx --yes yaml-lint .github/workflows/sdk.yml .github/workflows/release-sdk.yml` (or `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" …` — state which).
- [ ] **Step 3: Commit** `ci(sdk-flutter): 5-way version parity and flutter job`

---

### Task 10: Docs

**Files:**
- Create: `apps/docs/content/docs/platforms/flutter.mdx` (quickstart: install, configure, entitlements, offerings/purchase, paywall widget, funnel claim, error handling) — mirror the structure of the existing platform pages in that folder
- Modify: `apps/docs/content/docs/platforms/meta.json` (register the page)
- Modify: `ROADMAP.md` §7 (tick "Flutter SDK"; correct the stale "Align Swift/Kotlin versions with core" item — all four were already 0.16.0 before this work, now five; leave the podspec-sha256 and RN-pod items open with a note that Flutter iOS publication shares the podspec blocker)

- [ ] **Step 1: Write the page** — every code sample must compile against the API from Tasks 6-7 (copy signatures, don't invent). Include the error-handling sample using `RovenueException` fields and the paywall widget with all five callbacks. **MDX gotcha: no bare `{{...}}` in prose.**
- [ ] **Step 2: Build docs** — `nice -n 19 pnpm --filter @rovenue/docs build`. Expected: exit 0, page prerendered.
- [ ] **Step 3: ROADMAP edit** — stage ONLY `ROADMAP.md` plus the docs files; never the unrelated dirty files (`apps/dashboard/src/components/assets/asset-library.tsx`, `packages/db/seed.ts`).
- [ ] **Step 4: Full battery** (sequential, throttled; report actual numbers): `nice -n 19 pnpm build --concurrency=2`; the four Flutter packages' `flutter analyze` + `flutter test`; `nice -n 19 pnpm --filter @rovenue/react-native-sdk test`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`.
- [ ] **Step 5: Commit** `docs: Flutter SDK quickstart; roadmap §7 update` with the numbers in the body.

---

## Self-review notes (for executors)

- **Task ordering is hard**: 2 → 3 → 4 → 5 → 6 → 7. Tasks 4 and 5 both consume Task 2's generated files and are the only tasks touching native code; never run them concurrently.
- **If `flutter` is not installed**, Task 1 must report BLOCKED immediately — every later task depends on it. Do not stub the toolchain.
- The spec forbids a Dart bucketing implementation and a Dart paywall renderer; a task that adds either is a spec violation, not an enhancement.
- `getPaywallPreview` and `logPaywallShown/Closed` are deliberately absent from the HostApi (Global Constraints) — a reviewer flagging them as "missing from the UDL surface" should get that citation.
- The iOS podspec's `Rovenue` dependency will not resolve outside this repo until the Swift pod is published; the example's `:path` override is the documented development path, not a workaround to remove.
