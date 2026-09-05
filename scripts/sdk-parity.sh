#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Load cargo env so this script works in fresh shells too.
if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

echo "→ regenerate bindings"
./packages/core-rs/scripts/build-bindings.sh >/dev/null

# Rust authoritative version comes from cargo metadata.
RUST_VER=$(
    cargo metadata --no-deps --format-version 1 \
    | python3 -c 'import json,sys; m=json.load(sys.stdin); print(next(p["version"] for p in m["packages"] if p["name"]=="librovenue"))'
)
echo "→ Rust librovenue version: $RUST_VER"

echo "→ Rust core tests (M1 + M2 surface)"
cargo test -p librovenue --quiet \
    --test integration_smoke \
    --test entitlement_read_test \
    --test identity_test \
    --test polling_test \
    --test post_json_test \
    --test receipt_apple_test \
    --test receipt_google_test \
    --test credits_test \
    --test foreground_refresh_e2e_test \
    >/tmp/rovenue-rust-parity.log 2>&1
tail -3 /tmp/rovenue-rust-parity.log
echo "  ✓ Rust M1 + M2 tests passed"

# Every Apple-side check below — the Swift façade tests, the Flutter iOS
# harness tests and the podspec lint — resolves RovenueFFI through
# `.binaryTarget(path: "RovenueFFI.xcframework")`, a gitignored build artifact.
# Without it `swift test` aborts before compiling a line ("local binary target
# 'RovenueFFI' ... does not contain a binary artifact"), and `pod lib lint`
# fails on a missing `s.vendored_frameworks`. Building it here replaces the old
# DYLD_LIBRARY_PATH hop into target/release, which only ever supplied the host
# platform's dylib and never the device slice.
APPLE_ARTIFACT_BUILT=0
if [ "$(uname -s)" = "Darwin" ] && command -v xcodebuild >/dev/null 2>&1; then
    echo "→ build RovenueFFI.xcframework"
    ./packages/sdk-swift/scripts/build-xcframework.sh >/tmp/rovenue-xcframework.log 2>&1
    APPLE_ARTIFACT_BUILT=1
    echo "  ✓ RovenueFFI.xcframework built"
else
    echo "→ RovenueFFI.xcframework build SKIPPED (needs macOS + xcodebuild)"
fi

# Swift façade test exercises sdkVersion() against the xcframework's macOS slice.
if [ "$APPLE_ARTIFACT_BUILT" -eq 1 ]; then
    echo "→ Swift test"
    (
        cd packages/sdk-swift
        swift test 2>&1
    ) | tee /tmp/rovenue-swift-parity.log >/dev/null
    grep -E "Test Suite 'All tests' passed" /tmp/rovenue-swift-parity.log >/dev/null
    echo "  ✓ Swift façade tests passed"
else
    echo "→ Swift test SKIPPED (no RovenueFFI.xcframework)"
fi

# Kotlin: only run if gradle is on PATH.
if command -v gradle >/dev/null 2>&1; then
    echo "→ Kotlin test"
    (
        cd packages/sdk-kotlin
        gradle test --no-daemon --console=plain 2>&1
    ) | tee /tmp/rovenue-kotlin-parity.log >/dev/null
    grep -E "BUILD SUCCESSFUL" /tmp/rovenue-kotlin-parity.log >/dev/null
    echo "  ✓ Kotlin façade tests passed"
else
    echo "→ Kotlin test SKIPPED (gradle not on PATH)"
fi

# RN: vitest covers the Cargo.toml-version sync test, which is the parity assertion.
echo "→ RN test"
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tee /tmp/rovenue-rn-parity.log >/dev/null
grep -E "Test Files +1 passed|[0-9]+ passed" /tmp/rovenue-rn-parity.log >/dev/null
echo "  ✓ RN unit tests passed"

# Flutter: only run if flutter is on PATH. rovenue_flutter_ios/_android have no
# test/ dir yet — `flutter test` exits 1 (not 0) there ("Test directory
# \"test\" not found."), verified locally, so skip cleanly instead of failing
# the loop on a package with nothing to test.
FLUTTER_PACKAGES=(rovenue_flutter_platform_interface rovenue_flutter rovenue_flutter_ios rovenue_flutter_android)
if command -v flutter >/dev/null 2>&1; then
    echo "→ Flutter analyze + test"
    for p in "${FLUTTER_PACKAGES[@]}"; do
        (
            cd "packages/sdk-flutter/$p"
            flutter pub get
            flutter analyze
            if [ -d test ]; then
                flutter test
            else
                echo "  ~ no test/ directory for $p — skipping flutter test"
            fi
        ) >>/tmp/rovenue-flutter-parity.log 2>&1
    done
    echo "  ✓ Flutter façade analyze + test passed (${FLUTTER_PACKAGES[*]})"

    echo "→ Flutter example app analyze + test"
    (
        cd packages/sdk-flutter/example
        flutter pub get
        flutter analyze
        flutter test
        # integration_test needs a device; flutter-tester is the headless one.
        flutter test -d flutter-tester integration_test
    ) >>/tmp/rovenue-flutter-parity.log 2>&1
    echo "  ✓ Flutter example analyze + test passed"
else
    echo "→ Flutter test SKIPPED (flutter not on PATH)"
fi

# The plugin's NATIVE halves. `flutter analyze` is a Dart analyzer — it never
# compiles HostApiImpl.kt or HostApiImpl.swift, so these two blocks are the
# only thing that builds and runs them.
echo "→ Flutter plugin Android unit tests"
if command -v flutter >/dev/null 2>&1 && command -v java >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
    (
        cd packages/sdk-flutter/rovenue_flutter_android/android
        ./gradlew test --no-daemon --console=plain
    ) >/tmp/rovenue-flutter-android-parity.log 2>&1
    grep -E "BUILD SUCCESSFUL" /tmp/rovenue-flutter-android-parity.log >/dev/null
    echo "  ✓ rovenue_flutter_android gradle tests passed"
    echo "→ Flutter example Android debug APK"
    (
        cd packages/sdk-flutter/example
        flutter build apk --debug
    ) >/tmp/rovenue-flutter-apk-parity.log 2>&1
    echo "  ✓ example app-debug.apk built"
else
    echo "  ~ flutter/java/Android SDK unavailable — Flutter Android native checks skipped"
fi

echo "→ Flutter plugin iOS unit tests"
# ios/Package.swift depends on packages/sdk-swift, so it needs the xcframework
# built above just as the façade's own tests do.
if command -v flutter >/dev/null 2>&1 && [ "$APPLE_ARTIFACT_BUILT" -eq 1 ]; then
    (
        cd packages/sdk-flutter/rovenue_flutter_ios/ios
        swift test
    ) 2>&1 | tee /tmp/rovenue-flutter-ios-parity.log >/dev/null
    grep -E "Test Suite 'All tests' passed" /tmp/rovenue-flutter-ios-parity.log >/dev/null
    echo "  ✓ rovenue_flutter_ios swift tests passed"
    # No iOS example build here (or in .github/workflows/sdk.yml). Whether to
    # add one is an open decision, not a blocked one.
else
    echo "  ~ flutter unavailable, or no RovenueFFI.xcframework — Flutter iOS native checks skipped"
fi

# ---- RN sample app native compile (best-effort) ----
echo "→ RN sample app native compile"

# iOS
if command -v xcodebuild >/dev/null 2>&1 && [ -d "/Applications/Xcode.app" ]; then
  (
    set -e
    cd examples/sample-rn-expo
    pnpm install --frozen-lockfile >/dev/null 2>&1 || true
    pnpm expo prebuild --platform ios --no-install >/tmp/rovenue-sample-ios.log 2>&1
    (cd ios && pod install >>/tmp/rovenue-sample-ios.log 2>&1)
    SCHEME=$(ls ios/*.xcworkspace | head -n 1 | xargs -I {} basename {} .xcworkspace)
    xcodebuild -workspace "ios/${SCHEME}.xcworkspace" -scheme "${SCHEME}" \
      -sdk iphonesimulator -configuration Debug build \
      >>/tmp/rovenue-sample-ios.log 2>&1
  )
  echo "  ✓ iOS sample build succeeded"
else
  echo "  ~ xcodebuild unavailable — iOS sample build skipped"
fi

# Android
if command -v java >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
  (
    set -e
    cd examples/sample-rn-expo
    pnpm expo prebuild --platform android --no-install >/tmp/rovenue-sample-android.log 2>&1
    (cd android && ./gradlew assembleDebug >>/tmp/rovenue-sample-android.log 2>&1)
  )
  echo "  ✓ Android sample build succeeded"
else
  echo "  ~ gradle/Android SDK unavailable — Android sample build skipped"
fi

# ---- Rovenue podspec lint (best-effort) ----
# `pod lib lint`, never `pod spec lint`: lib lint builds from the checked-out
# sources and the xcframework built above, which is what a local parity run can
# actually assert. `pod spec lint` resolves the podspec's :http source over the
# network, so it can only pass once a GitHub Release exists — it belongs in
# release-sdk.yml's publish-swift job, and PR checks no longer run it.
echo "→ Rovenue podspec lint"
if command -v pod >/dev/null 2>&1 && [ "$APPLE_ARTIFACT_BUILT" -eq 1 ]; then
  for platform in ios macos; do
    pod lib lint packages/sdk-swift/Rovenue.podspec \
      --allow-warnings --skip-tests "--platforms=$platform" \
      >"/tmp/rovenue-podspec-lint-$platform.log" 2>&1
    echo "  ✓ Rovenue.podspec lints ($platform)"
  done
else
  echo "  ~ cocoapods unavailable, or no RovenueFFI.xcframework — podspec lint skipped"
fi

echo
echo "✓ Parity: all available codepaths agree on version $RUST_VER"
