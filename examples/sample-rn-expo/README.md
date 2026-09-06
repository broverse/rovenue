# sample-rn-expo

Minimal Expo dev client app for smoke-testing `@rovenue/react-native-sdk`.

Demonstrates the same flow as the other example apps
(`packages/sdk-flutter/example`, `examples/ios-swift`,
`examples/android-kotlin`): identify / logOut, offerings, a paywall,
purchase, restore, entitlements, and virtual-currency balances, all wired
to a rolling on-screen event log fed by `Rovenue.setLogHandler` and a
log-only `Rovenue.addChangeListener` (see the note in `App.tsx` about why
that listener never calls `refreshX()` itself).

## Paywall

`Rovenue.getPaywall(placementId)` resolves the `"onboarding"` placement —
the same identifier the Flutter/iOS/Android examples use — to an
already-resolved `Paywall` object, which is handed to
`RovenuePaywallView`. Unlike Flutter's `RovenuePaywallView` (which takes a
placement identifier directly and resolves it itself), React Native's view
takes the *already-resolved* `Paywall`, matching the iOS shape — the app
must call `getPaywall` first. This is deliberate: `RovenuePaywallView` is
an Expo view that hosts the native SwiftUI/Compose paywall renderer
(`packages/sdk-rn/src/paywall-view/`); React Native is not a fourth
renderer implementation.

## Run locally

```bash
pnpm install                           # from repo root
cd examples/sample-rn-expo

# Generate native ios/ + android/ projects from the Expo config
pnpm prebuild

# iOS (requires Xcode + a connected sim/device)
pnpm ios

# Android (requires Android SDK + JDK 17 + an emulator/device)
pnpm android
```

## Why not Expo Go?

Expo Go cannot load native modules like `@rovenue/react-native-sdk`.
Use the dev client (`expo-dev-client`) — `pnpm prebuild` + `pnpm ios` /
`pnpm android` produces a custom dev client with the Rovenue native
bridge linked in.

## Config plugin

`app.json` declares `"plugins": ["@rovenue/react-native-sdk"]`. At
prebuild time, the plugin patches `ios/Podfile` to add `pod 'Rovenue',
:path => '../../../packages/sdk-swift'` and patches Android's
`settings.gradle.kts` + `app/build.gradle` to add
`includeBuild("../../../packages/sdk-kotlin")` and
`implementation("dev.rovenue:sdk:0.1.0")`.

## Known monorepo hazard: `ExpoModulesCore` picks the wrong React Native

`ExpoModulesCore.podspec` decides which React Native API to compile against
by shelling out to `node --print "require('react-native/package.json').version"`
**from its own directory**. In this pnpm workspace `expo-modules-core` is
hoisted to the repo-root `node_modules/`, where that lookup finds the root's
React Native (0.86.x, pulled in by other workspace packages) instead of this
app's 0.74.5. CocoaPods then bakes `REACT_NATIVE_TARGET_VERSION=86` into the
Pods project and `BridgelessJSCallInvoker.h` / `TestingSyncJSCallInvoker.h`
take the RN ≥ 75 branch, which fails to compile against RN 0.74.5's
`react::CallFunc = std::function<void()>`:

```
error: no matching function for call to object of type 'react::CallFunc'
```

This has nothing to do with the Rovenue pods. Until the hoisting is fixed,
pin the lookup before `pod install`:

```bash
mkdir -p ../../node_modules/expo-modules-core/node_modules
ln -sfn "$PWD/node_modules/react-native" \
  ../../node_modules/expo-modules-core/node_modules/react-native
# verify: prints 74, not 86
grep -o 'REACT_NATIVE_TARGET_VERSION=[0-9]*' ios/Pods/Pods.xcodeproj/project.pbxproj | sort -u
```

The app's iOS deployment target is 16.0 because the `Rovenue` pod's floor is
16.0 (`packages/sdk-swift/release.config.json`); a lower value makes
`pod install` fail with "required a higher minimum deployment target".

### Same hazard, JS side: Metro/`@expo/cli` also resolve the wrong version

The CocoaPods hoisting problem above has a JS-toolchain sibling.
`packages/sdk-rn`'s `peerDependencies` require `expo >=52.0.0`,
`expo-modules-core >=2.0.0` and `react-native >=0.76` — versions newer than
this app's pinned `expo ~51.0.0` / `expo-modules-core ~1.12.0` /
`react-native 0.74.5`. That skew hoists a **newer** `@expo/cli` to the
repo-root `node_modules/` (the one satisfying the SDK's peer range), while
this app keeps its own older, locally-installed `expo` package. The
hoisted `@expo/cli` then requires `metro/src/lib/TerminalReporter` (and,
via the plain React Native CLI path, `metro-cache/src/stores/FileStore`)
from the repo-root `metro`, whose newer `"exports"` map doesn't expose
those subpaths:

```
Error: Package subpath './src/lib/TerminalReporter' is not defined by "exports" in .../node_modules/metro/package.json
```

Reproducible via either entry point — `npx expo export --platform ios`
(or `--platform android`) and `node_modules/.bin/react-native bundle
--platform ios ...` both fail this way, before either ever reads this
app's source. It is a repo-wide dependency-graph mismatch, not something
`App.tsx` or `app.json` can work around, and — like the CocoaPods hazard —
is not fixable by touching just this example; it needs the sdk-rn peer
range and this app's Expo/RN pin reconciled (or the two isolated with
`node-linker: isolated` instead of the hoisted layout this workspace uses).
Until then, `pnpm exec tsc --noEmit` (module resolution + types, including
the SDK's actual exported surface) is the verifiable proxy for "the JS
graph resolves" — a full Metro bundle and a native build are both blocked
by monorepo hazards, not by app code.
