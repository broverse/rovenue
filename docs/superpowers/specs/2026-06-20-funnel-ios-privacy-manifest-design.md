# Sub-project G — iOS Privacy Manifest + Required-Reason Audit (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Scope:** Sub-project **G** — the App Store privacy compliance for shipping the
iOS SDK (including the funnel features). This is the last funnel sub-project. The
integrator-responsibility **docs note** is deferred (docs are being done last).

## 1. Background

Apple requires a `PrivacyInfo.xcprivacy` manifest in third-party SDK frameworks
declaring (a) tracking status, (b) collected data types + purposes, and (c)
"required-reason" API usage. The Rovenue SDK currently has **no** privacy
manifest. Before the iOS SDK (with the funnel features — clipboard read, claim
flow) can ship to the App Store, it needs an accurate manifest.

**Audit findings (verified):**
- No existing Rovenue privacy manifest (only RN/third-party ones under
  `node_modules`).
- Distribution entry point: `packages/sdk-rn/ios/RovenueSdkRn.podspec` (Expo
  module pod, iOS 13, `static_framework`).
- **Required-Reason API audit is clean** in Rovenue's own source: no
  `UserDefaults`, no system boot time, no file-timestamp/disk-space APIs.
  `UIPasteboard` (clipboard, sub-project C) is used but is **not** a
  required-reason API (it has its own consent banner). The Rust core uses SQLite
  (rusqlite) but our source does no file stat'ing.

## 2. Decision: `NSPrivacyTracking = false` (research-backed)

All three major MMPs (Adjust, AppsFlyer, Branch) set `NSPrivacyTracking = true`
— but **only because they collect a cross-app DeviceID** (IDFA/device signal)
and operate the attribution graph; they pin `Tracking=true` + the advertising
purpose **specifically to the DeviceID** data type. Their event/interaction data
is `Tracking=false`, purpose `Analytics` — not advertising.

The Rovenue SDK is materially weaker: **no IDFA, no device-signal collection, no
fingerprinting, no cross-app linking** (deterministic-only, established across
A–E). The SDK transports developer-supplied events to the app's own first-party
backend; the optional Meta CAPI / TikTok forwarding is the **app developer's**
server-side config, off-device. Apple's "tracking" = linking with other
companies' data for ads / sharing with data brokers — the SDK does none of this.

→ `NSPrivacyTracking = false`. Following Branch's published division of
responsibility, the integrator who enables Meta/TikTok forwarding must declare
the advertising purpose + set `NSPrivacyTracking=true` + ATT-gate in **their
own** app manifest (a docs note, deferred).

## 3. Goals / Non-goals

**Goals**
- Ship an accurate `PrivacyInfo.xcprivacy` in the Expo iOS module pod.
- A parallel manifest in the sdk-swift SwiftPM package (secondary distribution).

**Non-goals**
- The integrator-responsibility docs note (deferred — docs last).
- Any code logic / SDK behavior change. This is a declaration file.
- App Store Connect nutrition labels — those are the consuming app's
  responsibility.

## 4. The manifest (`PrivacyInfo.xcprivacy`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <!-- Receipts → /v1/receipts -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePurchaseHistory</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- app_user_id / subscriber id (identify) -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeUserID</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- setEmail / claimViaEmail / event identityContext.email -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- setDisplayName / identityContext firstName/lastName -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeName</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- setPhoneNumber / identityContext.phone -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePhoneNumber</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- track() events + funnel interaction -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeProductInteraction</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAnalytics</string></array>
    </dict>
    <!-- pushToken, arbitrary attributes, identityContext ip/userAgent -->
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeOtherDataTypes</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
  </array>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <!-- SQLite cache file access (rusqlite). Include if the App Store upload
         validation flags FileTimestamp; the MMPs declare this. Remove if the
         validation does not flag it. -->
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>C617.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

**Accuracy invariants (the implementer must hold):**
- `NSPrivacyTracking` is `false`; `NSPrivacyTrackingDomains` is empty.
- NO data type has `Tracking=true`; NO data type carries an advertising purpose
  (`ThirdPartyAdvertising` / `DeveloperAdvertising`).
- The data-type list must match what the SDK actually transmits — the
  implementer audits the SDK's transmitted fields (receipts, identify, the
  `setEmail`/`setDisplayName`/`setPhoneNumber`/`setPushToken`/`setAttributes`
  attributes, `track` + `identityContext`, the funnel claim bodies) and adjusts
  the list (e.g. add `NSPrivacyCollectedDataTypeCoarseLocation` if
  `identityContext.city`/`countryCode` are transmitted; drop a type the SDK
  never sends).
- `NSPrivacyAccessedAPITypes` starts from the clean audit; only declare a
  required-reason API the SDK genuinely triggers (FileTimestamp `C617.1` is the
  likely one via SQLite; confirm against the App Store upload validation, which
  is the authoritative check).

## 5. Wiring

### 5.1 Expo module pod (primary)
- Create `packages/sdk-rn/ios/PrivacyInfo.xcprivacy` (the manifest above).
- In `packages/sdk-rn/ios/RovenueSdkRn.podspec`, add:
  ```ruby
  s.resource_bundles = { 'RovenueSdkRn_privacy' => ['PrivacyInfo.xcprivacy'] }
  ```
  so the manifest is bundled into the framework Apple scans.

### 5.2 sdk-swift SwiftPM package (secondary)
- Create `packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy` (same content).
- In `packages/sdk-swift/Package.swift`, add it to the target's `resources`:
  ```swift
  resources: [.copy("PrivacyInfo.xcprivacy")]
  ```
  (for apps consuming the Swift façade via SwiftPM directly).

## 6. Testing / Verification

- **`plutil -lint packages/sdk-rn/ios/PrivacyInfo.xcprivacy`** — valid plist XML
  (and the sdk-swift copy). This is the runnable gate.
- **Podspec/Package.swift reference** — confirm the resource is wired (review +
  `pod lib lint` if available locally; `swift build` for the SwiftPM resource).
- **No runtime test** — the authoritative gate is **App Store Connect upload
  validation** (it flags undeclared required-reason APIs / tracking-domain
  mismatches). That runs on the user's real build/upload, out of this repo.
  State this limitation; the manifest is review + plist-lint verified here.

## 7. Versioning

This is additive packaging metadata. Bump the unified version (crate = TS
`SDK_VERSION` = npm) one minor, in lockstep, per the `version.test.ts` parity.

## 8. Deferred (docs, integrator responsibility)

A docs note (done in the docs pass): integrators who enable Meta CAPI / TikTok
forwarding must, in **their own** app's `PrivacyInfo.xcprivacy` + App Store
Connect labels, set `NSPrivacyTracking=true`, declare the relevant advertising
purpose + hashed-identifier data types, and gate the feature behind an ATT
prompt — mirroring Branch's / AppsFlyer's published division of responsibility.
