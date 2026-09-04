# sample-rn-expo

Minimal Expo dev client app for smoke-testing `@rovenue/react-native-sdk`.

Renders SDK version + anonymous user ID; logs bridge events via
`Rovenue.setLogHandler`.

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
