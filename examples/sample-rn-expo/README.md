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
