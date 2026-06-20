# iOS Privacy Manifest (Sub-project G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an accurate `PrivacyInfo.xcprivacy` privacy manifest in the Rovenue iOS SDK (Expo pod + sdk-swift SwiftPM package) so the funnel-enabled SDK can pass App Store review.

**Architecture:** A declaration-only plist. `NSPrivacyTracking=false` (no IDFA/device-signal/cross-app linking — unlike Adjust/AppsFlyer/Branch who set true only for their DeviceID); collected data types all `Tracking=false`, `AppFunctionality`/`Analytics`, no advertising purpose; required-reason audit clean. Bundled into the framework via the Expo podspec `resource_bundles` (prebuild-immune — it lives in the SDK's published package, not the consuming app's regenerated `ios/`) and the SwiftPM target `resources`.

**Tech Stack:** Apple Privacy Manifest (plist), CocoaPods podspec, Swift Package Manager, `plutil`.

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on current HEAD.
- Conventional commits.
- **Manifest accuracy invariants (binding):** `NSPrivacyTracking` is `false`; `NSPrivacyTrackingDomains` empty; NO data type has `Tracking=true`; NO data type carries an advertising purpose (`ThirdPartyAdvertising`/`DeveloperAdvertising`).
- The two manifest files (Expo pod + sdk-swift) MUST have identical content.
- No SDK behavior/code-logic change — declaration + packaging only.
- The authoritative compliance gate is App Store Connect upload validation (runs on the user's real build, out of this repo). Here the gate is `plutil -lint` + `swift build` + review.

---

### Task 1: Privacy manifest + packaging wiring

**Files:**
- Create: `packages/sdk-rn/ios/PrivacyInfo.xcprivacy`
- Modify: `packages/sdk-rn/ios/RovenueSdkRn.podspec`
- Create: `packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy` (identical content)
- Modify: `packages/sdk-swift/Package.swift`

**Interfaces:**
- Produces: the bundled `PrivacyInfo.xcprivacy` in both distribution paths. No code symbols.

- [ ] **Step 1: Create the Expo-pod manifest**

Create `packages/sdk-rn/ios/PrivacyInfo.xcprivacy` with EXACTLY this content:

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
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePurchaseHistory</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeUserID</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeName</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePhoneNumber</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeProductInteraction</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAnalytics</string></array>
    </dict>
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
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>C617.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

**Before writing, audit accuracy** (the binding invariants): the data-type list must match what the SDK actually transmits. Grep the SDK's transmitted fields to confirm/adjust:
- `grep -rn "setEmail\|setDisplayName\|setPhoneNumber\|setPushToken\|setAttributes" packages/sdk-swift/Sources packages/core-rs/src` — confirms the attribute PII (email/name/phone → already listed; pushToken/arbitrary → OtherDataTypes).
- Check the `track()` `identityContext` fields and the funnel claim bodies (`packages/core-rs/src`): if `city`/`countryCode`/coarse geo are transmitted, ADD a `NSPrivacyCollectedDataTypeCoarseLocation` entry (Linked true, Tracking false, AppFunctionality). If a listed type is never sent, remove it. Keep every entry `Tracking=false`, no advertising purpose.
- `NSPrivacyAccessedAPITypes`: the audit of Rovenue's own Swift/Rust source is clean (no UserDefaults/boot-time). `FileTimestamp C617.1` is declared defensively for the SQLite cache file (rusqlite). If unsure it applies, this is the one item the App Store upload validation will confirm/deny — leave it declared (over-declaring a real reason is safe; under-declaring fails review).

- [ ] **Step 2: Validate the plist**

Run: `plutil -lint packages/sdk-rn/ios/PrivacyInfo.xcprivacy`
Expected: `packages/sdk-rn/ios/PrivacyInfo.xcprivacy: OK`

- [ ] **Step 3: Wire the Expo podspec**

In `packages/sdk-rn/ios/RovenueSdkRn.podspec`, after the `s.source_files = '**/*.{h,m,swift}'` line, add:

```ruby
  s.resource_bundles = { 'RovenueSdkRn_privacy' => ['PrivacyInfo.xcprivacy'] }
```

(This bundles `PrivacyInfo.xcprivacy` into a `RovenueSdkRn_privacy.bundle` inside the framework — the documented CocoaPods way to ship a privacy manifest. It lives in the SDK's published npm package, NOT the consuming app's prebuild-regenerated `ios/`.)

- [ ] **Step 4: Create the sdk-swift manifest (identical content)**

Copy the Step-1 file verbatim to `packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy`:

Run: `cp packages/sdk-rn/ios/PrivacyInfo.xcprivacy packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy`
Then: `plutil -lint packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy`
Expected: `... OK`

- [ ] **Step 5: Wire the SwiftPM target resource**

In `packages/sdk-swift/Package.swift`, on the `.target(name: "Rovenue", ...)` (it currently has `dependencies`, `path`, `linkerSettings`), add a `resources` parameter so SwiftPM bundles (and doesn't error on) the manifest:

```swift
        .target(
            name: "Rovenue",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            resources: [.copy("PrivacyInfo.xcprivacy")],
            linkerSettings: [
                .linkedLibrary("rovenue"),
                .unsafeFlags(["-L../../target/release"], .when(platforms: [.macOS])),
            ]
        ),
```

- [ ] **Step 6: Build the Swift package**

Run: `cd packages/sdk-swift && swift build`
Expected: `Build complete!` — the `.copy` resource is accepted (no "unhandled files" warning for PrivacyInfo.xcprivacy, no resource error). If the generated uniffi binding isn't present locally, run `npm run sdk:bindings` from the repo root first.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/ios/PrivacyInfo.xcprivacy packages/sdk-rn/ios/RovenueSdkRn.podspec \
        packages/sdk-swift/Sources/Rovenue/PrivacyInfo.xcprivacy packages/sdk-swift/Package.swift
git commit -m "feat(sdk): add iOS privacy manifest (NSPrivacyTracking=false)"
```

---

### Task 2: Version bump (lockstep)

**Files:**
- Modify: `Cargo.toml`, `packages/sdk-rn/src/version.ts`, `packages/sdk-rn/package.json`

- [ ] **Step 1: Bump all three versions in lockstep**

Confirm all three are equal (`0.14.0`), then bump each by one minor to `0.15.0`:
- `Cargo.toml` `[workspace.package]` `version = "0.14.0"` → `"0.15.0"`.
- `packages/sdk-rn/src/version.ts` `SDK_VERSION = "0.14.0"` → `"0.15.0"`.
- `packages/sdk-rn/package.json` `"version": "0.14.0"` → `"0.15.0"`.
All three MUST end identical at `0.15.0`. (If the user changed them meanwhile, bump from the actual value, keeping all three identical at the next minor.)

- [ ] **Step 2: Verify build + parity**

Run: `cargo build -p librovenue`
Expected: builds at `0.15.0` (regenerates `Cargo.lock`).

Run: `cd packages/sdk-rn && pnpm test`
Expected: all green, INCLUDING `src/__tests__/version.test.ts` parity at `0.15.0`. If it fails, a version edit is wrong — fix it.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json
git commit -m "chore(sdk): bump versions to 0.15.0 (iOS privacy manifest)"
```

---

## Self-Review

**Spec coverage:**
- §4 manifest (full content, accuracy invariants) → Task 1 Step 1. §5.1 Expo podspec wiring → Task 1 Step 3. §5.2 sdk-swift copy + Package.swift resources → Task 1 Steps 4-5. §6 testing (plutil -lint both + swift build) → Task 1 Steps 2,4,6. §7 versioning → Task 2. §8 deferred docs note → out of scope (docs last), not a task.

**Placeholder scan:** No TBD/TODO. The manifest content is complete and verbatim. The "audit accuracy" step is a deliberate, concrete instruction (named greps + the explicit add/remove rule + the invariants), not a vague placeholder.

**Type consistency:** The two `PrivacyInfo.xcprivacy` files are byte-identical (Step 4 copies Step 1). The podspec `resource_bundles` key and the Package.swift `.copy("PrivacyInfo.xcprivacy")` both reference the file by its exact name. Version `0.15.0` is identical across all three files in Task 2.
