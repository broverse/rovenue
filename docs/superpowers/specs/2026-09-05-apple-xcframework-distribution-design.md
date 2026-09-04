# Apple distribution: `RovenueFFI.xcframework`

**Date:** 2026-09-05
**Roadmap:** §7 SDK platform coverage — closes three open items in one change
**Status:** design approved, empirically probed

## Why

Three §7 items look independent but share one root cause: the Rust core is
distributed to Apple consumers as a **bare single-slice static library**
checked into git.

| §7 item | What actually blocks it |
|---|---|
| "Fix release blockers: Rust fmt/clippy CI reds, Swift podspec sha256 placeholder" | The Rust half is **stale** — `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -D warnings` and `cargo test --workspace --all-targets` are all green as of 2026-09-04. The real blocker is that the vendored `.a` is the wrong platform slice (below). |
| "Make the RN iOS pod externally consumable; RN SDK distribution" | `RovenueSdkRn.podspec` reaches out of the pod with `SWIFT_INCLUDE_PATHS => "${PODS_ROOT}/../../../../packages/sdk-swift/Sources/RovenueFFI"`. That path exists only inside this monorepo. It exists *because* the bare `.a` carries no module map. |
| "Official macOS / tvOS / watchOS / visionOS targets in the Swift SDK" | A single-slice `.a` can serve exactly one platform. |

Two concrete defects, both verified:

1. **The shipped slice is the wrong platform.** `packages/sdk-swift/Sources/Rovenue/librovenue_ffi.a`
   is tracked in git (commit `51866667`, 32 MB). `Rovenue.podspec` documents it as
   "arm64 iOS devices only", but `otool -l` reports `platform 7` —
   **iOS Simulator**. A pod published today would fail to link on device.
2. **`Package.swift` cannot be consumed as a dependency at all.** It carries
   `.unsafeFlags(["-L../../target/release"])`. SwiftPM refuses to resolve any
   package that uses `unsafeFlags` as a dependency, so the Swift SDK has no
   working SPM channel today — independent of the binary problem.

## What we build

A single artifact, `RovenueFFI.xcframework`, containing three slices and a
self-contained headers directory (`RovenueFFI.h` + `module.modulemap`, both
emitted by uniffi):

| Slice directory | Rust targets |
|---|---|
| `ios-arm64` | `aarch64-apple-ios` |
| `ios-arm64_x86_64-simulator` | `aarch64-apple-ios-sim` + `x86_64-apple-ios`, `lipo`-merged |
| `macos-arm64_x86_64` | `aarch64-apple-darwin` + `x86_64-apple-darwin`, `lipo`-merged |

tvOS / watchOS / visionOS are **out of scope** and stay open on the roadmap:
those Rust targets are Tier 3 (not installable via `rustup target add`; they
need a nightly toolchain and `-Z build-std`), while CI is pinned to stable
1.88.0. Adding them is a second build pipeline, not a slice.

### The non-obvious constraint

CocoaPods accepts a static-library xcframework, but **every slice's library
file must have the same basename**. Naming them per-platform
(`librovenue_ios.a`, `librovenue_iossim.a`, …) fails validation with a message
that reads as a blanket refusal:

```
Unable to install vendored xcframework `RovenueFFI` for Pod `Rovenue`
because it contains static libraries
```

The sentence continues `with differing binary names: …`
(`cocoapods-1.16.2/lib/cocoapods/installer/xcode/pods_project_generator/pod_target_installer.rb:1190`),
but the truncated form invites the wrong conclusion — that static-library
xcframeworks are unsupported. **All three slices must be named
`librovenue_ffi.a`**, each in its own staging directory. This is the single
easiest thing to get wrong here, so the build script asserts it.

### Probe results (2026-09-05, this machine, CocoaPods 1.16.2 / Xcode 26.5)

With slices correctly named and the xcframework vendored via
`s.vendored_frameworks`, and with `SWIFT_INCLUDE_PATHS`, `preserve_paths` and
the whole `Sources/RovenueFFI/` directory **deleted**:

- `pod lib lint --platforms=ios` → `Rovenue passed validation.`
- `pod lib lint --platforms=macos` → `Rovenue passed validation.`
- `s.static_framework = true` is **not** required for the `Rovenue` pod.
- SwiftPM `.binaryTarget(path:)` with no `systemLibrary` target and no
  `unsafeFlags` → `swift build` clean.
- Baseline before any change: `swift test` 343/343 green; Rust workspace
  fmt + clippy + tests green.

Not verifiable here: `pod lib lint` on `RovenueSdkRn.podspec`. Expo pods cannot
be loaded outside an Expo app's autolinking environment
(`ExpoModulesCore.podspec` raises `Pod::DSLError` standalone). That claim is
verified by an Expo app build instead — see Verification.

## Distribution channels

Both channels ship the same xcframework; neither keeps a binary in git.

### CocoaPods

`Rovenue.podspec` vendors the xcframework from the release zip:

- `s.vendored_libraries` → `s.vendored_frameworks = 'RovenueFFI.xcframework'`
- `s.platforms` gains `:osx => '12.0'`
- `s.preserve_paths` and `s.pod_target_xcconfig` are deleted
- `RovenueSdkRn.podspec` loses **both** xcconfig blocks — with them goes the
  `${PODS_ROOT}/../../../..` monorepo escape, which is what makes the RN pod
  externally consumable
- `withRovenueIos.ts`'s default pod line is pinned to the package's own
  version instead of `'~> 0.1'`, matching what `rovenue_flutter_ios.podspec`
  already does (`s.dependency 'Rovenue', '0.16.0'`)

### SwiftPM

The monorepo's `Package.swift` keeps a **local** `.binaryTarget(path:)`. It is
a development manifest and is not what external consumers resolve.

External SPM consumers resolve a **separate distribution repository**
(`rovenue/rovenue-swift`), whose tags carry a generated `Package.swift` with a
fixed `url` + `checksum` binary target. This is the shape Mozilla
(`rust-components-swift`) and Matrix (`matrix-rust-components-swift`) use, and
it is chosen over a conditional manifest for one reason: **a tag must resolve
to the same graph on every machine.** A manifest that switches on local
filesystem state or an environment variable breaks that.

The distribution repo is generated, never hand-edited: the release job writes
its `Package.swift`, copies the Swift façade sources into it, commits, and
pushes a tag.

### Release ordering

`release-pod.sh` today does: create release → patch podspec sha256 → commit.
That order is safe for CocoaPods, which resolves an `:http` URL rather than a
git tag, which is why nobody has hit it. It is **not** safe for SwiftPM, where
consumers resolve a tag: the tag would point at the commit *before* the
checksum landed.

Corrected order, and the script enforces it:

1. build xcframework → zip
2. upload zip to the GitHub release
3. `shasum -a 256` (CocoaPods) and `swift package compute-checksum` (SwiftPM)
4. commit both pinned files
5. **create the tag / push the distribution repo tag last**

## CI

- **PRs** lint with `pod lib lint` (builds from local sources, needs no
  release). This structurally removes the "expected to FAIL on the merge PR
  itself" note in `sdk-swift-pod-lint.yml` — that red was the wrong tool, not a
  missing release: `pod spec lint` resolves the `:http` source over the
  network.
- `pod spec lint` moves to the release job, where the release genuinely exists.
- The Swift job builds the xcframework before `swift build` / `swift test`, and
  lints both `--platforms=ios` and `--platforms=macos`.
- `release-sdk.yml` uploads the xcframework and pushes the distribution repo tag.

## Repository hygiene

`packages/sdk-swift/Sources/Rovenue/librovenue_ffi.a` is deleted and
git-ignored, along with `**/RovenueFFI.xcframework`. Deleting it stops the
bleeding; it does **not** shrink the repository, because the 32 MB blob stays
in history. Rewriting published history (`git filter-repo`) is out of scope and
is not done without an explicit decision.

## Verification

Each item is a command with an expected result, not a claim:

1. `otool -l` on each of the three slices reports platform `2` (iOS), `7`
   (iOS Simulator), `1` (macOS) respectively. The build script asserts this,
   so the current sim-for-device mix-up cannot silently return.
2. The build script asserts all three slice binaries share the basename
   `librovenue_ffi.a`.
3. `pod lib lint Rovenue.podspec --platforms=ios` and `--platforms=macos` pass.
4. `swift build` and `swift test` (343 tests) pass against the binary target.
5. The linker emits no `built for newer 'iOS' version` warnings — the build
   script exports `IPHONEOS_DEPLOYMENT_TARGET=16.0` and
   `MACOSX_DEPLOYMENT_TARGET=12.0`. Without them, cargo builds objects against
   the host SDK's default (observed: 26.5) and the linker warns on every one.
6. **RN pod**: `examples/sample-rn-expo` completes `pod install` and an iOS
   build with no `SWIFT_INCLUDE_PATHS` entry anywhere in the app's Podfile or
   the pod's xcconfig. This is the only claim in this design that the earlier
   probe could not settle.
7. `rovenue_flutter_ios`'s example app resolves `Rovenue` (local `:path`
   override during development).

## Out of scope

- tvOS / watchOS / visionOS slices (Tier 3 Rust targets — stays open in §7)
- `pod trunk push`, GitHub Release creation, and creating the
  `rovenue/rovenue-swift` repository — these need credentials the
  implementation does not have; the operator runs them
- On-device smoke testing (§3, needs physical devices and store sandbox)
- Rewriting git history to reclaim the 32 MB blob
