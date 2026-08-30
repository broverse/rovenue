# Rovenue Flutter SDK

Flutter SDK for Rovenue, structured as a **federated plugin** — the same
pattern used by `firebase_*`/`camera`/`video_player` — so the iOS and
Android native implementations wrap the existing platform SDKs
(`packages/sdk-swift`, `packages/sdk-kotlin`) rather than reimplementing the
Rust-core bridge a fourth time.

## Layout

```
sdk-flutter/
  rovenue_flutter/                     app-facing package (what apps depend on)
  rovenue_flutter_platform_interface/  shared Dart contract (plugin_platform_interface)
  rovenue_flutter_ios/                 iOS implementation — wraps the `Rovenue` CocoaPod
  rovenue_flutter_android/             Android implementation — wraps `dev.rovenue:sdk`
```

- `rovenue_flutter` depends on `rovenue_flutter_platform_interface` and
  declares `rovenue_flutter_ios` / `rovenue_flutter_android` as its
  `default_package` for each platform (`flutter.plugin.platforms` in its
  `pubspec.yaml`).
- `rovenue_flutter_platform_interface` defines the Dart-level API surface;
  both platform packages implement it (`flutter.plugin.implements:
  rovenue_flutter` in their `pubspec.yaml`).
- `rovenue_flutter_ios` and `rovenue_flutter_android` each vendor a thin
  Flutter bridge over the platform's existing native SDK — no Rust FFI or
  business logic is duplicated here.

All four packages are versioned together at `0.16.0`, matching the current
`packages/sdk-swift` / `packages/sdk-kotlin` release.

## Dev setup

```
cd rovenue_flutter && flutter pub get && flutter analyze
```

Repeat in the other three packages (`rovenue_flutter_platform_interface`,
`rovenue_flutter_ios`, `rovenue_flutter_android`).

### iOS: the `Rovenue` pod path-override note

`rovenue_flutter_ios/ios/rovenue_flutter_ios.podspec` declares
`s.dependency 'Rovenue', '0.16.0'` against the **published** CocoaPods
Trunk pod (spec §4.6: the pod must be published before this podspec
resolves for a normal consumer). Until a given `Rovenue` version is
published, or when developing against local `packages/sdk-swift` changes,
point Podfile at the local source instead of the registry:

```ruby
# ios/Podfile in the example/host app
pod 'Rovenue', :path => '../../../sdk-swift'
```

### Android: the `mavenLocal()` note

`rovenue_flutter_android/android/build.gradle` lists `mavenLocal()` first
in `repositories` so a local `./gradlew publishToMavenLocal` run inside
`packages/sdk-kotlin` can stand in for a published `dev.rovenue:sdk:0.16.0`
artifact during development — the Android equivalent of the iOS `:path`
override above.

## Toolchain

- Dart SDK `>=3.4.0 <4.0.0`, Flutter `>=3.22.0`.
- Android: building the example app additionally requires the Android SDK
  `cmdline-tools` and accepted licenses (`sdkmanager --licenses`) — not
  needed just to run `flutter pub get` / `flutter analyze`.
