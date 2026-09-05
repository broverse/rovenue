# rovenue_flutter_example

The example app for the [Rovenue](https://rovenue.app) Flutter SDK. It is a host
for the real plugin — the only place in this repo where `rovenue_flutter`,
`rovenue_flutter_android`, and `rovenue_flutter_ios` are compiled and run
together as a shipping Flutter app rather than as analyzed Dart packages.

`pubspec_overrides.yaml` points every `rovenue_*` dependency at its sibling
directory, so this app always builds the working tree, never a pub.dev release.

## What it exercises

`lib/main.dart` walks the public surface top to bottom:

- `configure()` on boot, then a live `changes` stream subscription
- `entitlementsAll()` rendered as a list and refreshed whenever `changes` fires
- `getOfferings()` rendered as a product list, each row with a `purchase()` button
- a second route mounting `RovenuePaywallView` for the `onboarding` placement,
  with all five callbacks (`onPurchaseCompleted`, `onPurchaseFailed`, `onClose`,
  `onRestore`, `onUrl`) appending to an on-screen event log

Every call is wrapped in try/catch and logs its outcome to the screen, so the
app stays useful without a live backend.

## Running it

The API key in `lib/main.dart` is a placeholder and this app is not wired to a
real project. Replace `_kApiKey` with a public API key from your Rovenue
dashboard to drive it against a live backend.

```sh
flutter pub get
flutter run
```

## Tests

```sh
flutter test                                  # widget test
flutter test -d flutter-tester integration_test   # headless integration test
flutter build apk --debug                     # compiles the Android plugin
```

`integration_test/smoke_test.dart` installs a fake `RovenuePlatform` before
`runApp`, so it needs neither a backend nor a device — `flutter-tester` is
enough. These three commands are exactly what `.github/workflows/sdk.yml` runs.

CI does not build this app for iOS. That is an open decision rather than a
blocked one: `packages/sdk-swift` now ships `RovenueFFI.xcframework` with real
iOS-device, iOS-simulator and macOS slices, so an iOS build has no
architecture-level obstacle — building one in CI just costs a full xcframework
build plus an `xcodebuild` run on a macOS runner. Locally, `flutter build ios`
needs `packages/sdk-swift/scripts/build-xcframework.sh` to have run first.
