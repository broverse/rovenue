# Apple XCFramework Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-slice static library vendored to Apple consumers with a three-slice `RovenueFFI.xcframework`, which simultaneously fixes the wrong-platform binary, makes the React Native pod externally consumable, and makes macOS an official Swift SDK target.

**Architecture:** One build script produces `RovenueFFI.xcframework` (iOS device, iOS simulator, macOS) carrying uniffi's own `RovenueFFI.h` + `module.modulemap`. Because the module map now travels inside the artifact, every `SWIFT_INCLUDE_PATHS` workaround that reaches out of its pod into the monorepo is deleted. SwiftPM consumes it as a local `binaryTarget` in this repo and as a `url` + `checksum` binary target in a generated distribution repository; CocoaPods consumes it as `vendored_frameworks`.

**Tech Stack:** Rust 1.88.0 (stable), `cargo` cross-compilation, `lipo`, `xcodebuild -create-xcframework`, SwiftPM 5.9, CocoaPods 1.16.2, GitHub Actions (macos-14 runners), Bash.

**Spec:** `docs/superpowers/specs/2026-09-05-apple-xcframework-distribution-design.md`

## Global Constraints

- **Stay on the current branch.** Never create or switch branches, and never create a git worktree. The user manages branching.
- **No magic values.** Every literal that appears more than once — the repo slug, the pod name, deployment targets, the slice library basename, the xcframework name — is declared once in `packages/sdk-swift/release.config.json` and read from there. Structured data tables (the Rust target list, the slice table) are data, not magic values, and may be written literally.
- **Exact values, copied from the spec:**
  - iOS deployment target: `16.0`; macOS deployment target: `12.0`
  - Rust targets: `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`, `aarch64-apple-darwin`, `x86_64-apple-darwin`
  - Slice library basename, identical in all three slices: `librovenue_ffi.a`
  - Artifact name: `RovenueFFI.xcframework`; pod name: `Rovenue`; version: `0.16.0` (**no bump** — nothing is published)
  - Mach-O platform ids asserted per slice: `2` = iOS, `7` = iOS Simulator, `1` = macOS
- **Verification runs against real artifacts.** Assertions read actual Mach-O headers with `otool` and run real `pod lib lint` / `swift test`. A test that would pass without the artifact existing proves nothing and does not count.
- **Throttle heavy builds.** Prefix cargo and swift builds with `nice -n 19`. Do not run the monorepo's full vitest suite; nothing in this plan touches TypeScript tests other than `sdk-rn`'s own.
- **Conventional commits**, one per task.
- tvOS / watchOS / visionOS are out of scope (Tier 3 Rust targets). Do not add them.
- `pod trunk push`, GitHub Release creation, and creating the distribution repository are operator actions. Scripts may print the command; they must never run it.

---

### Task 1: XCFramework build + verification scripts

**Files:**
- Create: `packages/sdk-swift/release.config.json`
- Create: `packages/sdk-swift/scripts/verify-xcframework.sh`
- Create: `packages/sdk-swift/scripts/build-xcframework.sh`
- Delete: `packages/sdk-swift/scripts/build-ios-static.sh`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `release.config.json` keys read by every later task: `repoSlug`, `podName`, `version`, `xcframeworkName`, `sliceLibName`, `iosDeploymentTarget`, `macosDeploymentTarget`
  - `scripts/build-xcframework.sh [OUT_DIR]` → writes `$OUT_DIR/RovenueFFI.xcframework`, defaulting `OUT_DIR` to `packages/sdk-swift`
  - `scripts/verify-xcframework.sh <XCFRAMEWORK_PATH>` → exit 0 on a valid artifact, non-zero with a named failure otherwise

- [ ] **Step 1: Write the config file**

`packages/sdk-swift/release.config.json`:

```json
{
  "repoSlug": "broverse/rovenue",
  "podName": "Rovenue",
  "version": "0.16.0",
  "xcframeworkName": "RovenueFFI.xcframework",
  "sliceLibName": "librovenue_ffi.a",
  "iosDeploymentTarget": "16.0",
  "macosDeploymentTarget": "12.0"
}
```

> `repoSlug` is the repository the release artifacts are published from. It is
> `broverse/rovenue` because that is the actual git remote. If the operator
> moves the project to a `rovenue` org, this one line changes and every URL
> follows.

- [ ] **Step 2: Write the verification script (the failing test)**

`packages/sdk-swift/scripts/verify-xcframework.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# verify-xcframework.sh — asserts that a built RovenueFFI.xcframework is
# actually shaped the way consumers require. Every check here exists because
# its absence has already cost us something:
#
#  * platform ids     — the previously shipped librovenue_ffi.a claimed to be
#                       an arm64 *device* library but was an iOS *simulator*
#                       build (Mach-O platform 7). It would not have linked on
#                       device.
#  * identical names  — CocoaPods refuses a static-library xcframework whose
#                       slices have differing binary names, and reports it with
#                       a truncated message that reads like a blanket refusal.
#  * bundled headers  — the module map travelling inside the artifact is the
#                       whole point; without it every consumer needs a
#                       SWIFT_INCLUDE_PATHS hack pointing into this monorepo.

if [ $# -ne 1 ]; then
  echo "usage: $0 <XCFRAMEWORK_PATH>" >&2
  exit 2
fi

XCF="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$HERE/../release.config.json"

cfg() { ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['$1']"; }

SLICE_LIB_NAME="$(cfg sliceLibName)"
IOS_MIN="$(cfg iosDeploymentTarget)"
MACOS_MIN="$(cfg macosDeploymentTarget)"

fail() { echo "✗ $*" >&2; exit 1; }

test -d "$XCF" || fail "no xcframework at $XCF"

# Expected slice directory → Mach-O platform id → expected minimum OS version.
# Mach-O platform ids: 1 = macOS, 2 = iOS, 7 = iOS Simulator.
EXPECTED_SLICES="ios-arm64:2:$IOS_MIN ios-arm64_x86_64-simulator:7:$IOS_MIN macos-arm64_x86_64:1:$MACOS_MIN"

slice_count=$(find "$XCF" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[ "$slice_count" -eq 3 ] || fail "expected 3 slices, found $slice_count"

for entry in $EXPECTED_SLICES; do
  dir="${entry%%:*}"
  rest="${entry#*:}"
  want_platform="${rest%%:*}"
  want_minos="${rest#*:}"

  lib="$XCF/$dir/$SLICE_LIB_NAME"
  test -f "$lib" || fail "$dir: missing $SLICE_LIB_NAME (all slices must share this basename)"

  got_platform=$(otool -l "$lib" | awk '/LC_BUILD_VERSION/{f=1} f&&/platform/{print $2; f=0}' | sort -u | tr '\n' ' ' | xargs)
  [ "$got_platform" = "$want_platform" ] \
    || fail "$dir: Mach-O platform is '$got_platform', expected '$want_platform'"

  got_minos=$(otool -l "$lib" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; f=0}' | sort -u | tr '\n' ' ' | xargs)
  [ "$got_minos" = "$want_minos" ] \
    || fail "$dir: minimum OS is '$got_minos', expected '$want_minos' — export the *_DEPLOYMENT_TARGET vars before cargo build"

  test -f "$XCF/$dir/Headers/RovenueFFI.h" || fail "$dir: Headers/RovenueFFI.h missing"
  test -f "$XCF/$dir/Headers/module.modulemap" || fail "$dir: Headers/module.modulemap missing"
done

echo "✓ $XCF — 3 slices, matching basenames, correct platforms and deployment targets"
```

- [ ] **Step 3: Run the verifier to confirm it fails**

Run: `chmod +x packages/sdk-swift/scripts/verify-xcframework.sh && ./packages/sdk-swift/scripts/verify-xcframework.sh packages/sdk-swift/RovenueFFI.xcframework`
Expected: FAIL — `✗ no xcframework at packages/sdk-swift/RovenueFFI.xcframework`

- [ ] **Step 4: Write the build script**

`packages/sdk-swift/scripts/build-xcframework.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# build-xcframework.sh — cross-compiles librovenue for every Apple platform we
# officially support and packages the results as RovenueFFI.xcframework, with
# uniffi's generated C header and module map bundled inside each slice.
#
# Replaces build-ios-static.sh, which produced a single bare .a and could
# therefore serve exactly one platform.
#
# Usage: ./packages/sdk-swift/scripts/build-xcframework.sh [OUT_DIR]
#   OUT_DIR defaults to packages/sdk-swift/

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SWIFT_DIR/../.." && pwd)"
CONFIG="$SWIFT_DIR/release.config.json"

cfg() { ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['$1']"; }

OUT_DIR="${1:-$SWIFT_DIR}"
XCF_NAME="$(cfg xcframeworkName)"
SLICE_LIB_NAME="$(cfg sliceLibName)"
IOS_MIN="$(cfg iosDeploymentTarget)"
MACOS_MIN="$(cfg macosDeploymentTarget)"

GEN="$SWIFT_DIR/Sources/Rovenue/Generated"
STAGE="$SWIFT_DIR/build/xcframework"

command -v rustup >/dev/null 2>&1 || { echo "✗ rustup not found — https://rustup.rs" >&2; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "✗ xcodebuild not found — install Xcode" >&2; exit 1; }

# uniffi emits RovenueFFI.h and RovenueFFI.modulemap; both are gitignored build
# artifacts, so regenerate rather than assume they are present.
echo "→ generate uniffi bindings"
"$ROOT/packages/core-rs/scripts/build-bindings.sh" >/dev/null

# Deployment targets must be exported BEFORE cargo build: without them, cc
# compiles the bundled C (SQLite, ring) against the host SDK's default minimum
# and every object triggers an "object file was built for newer ... version"
# linker warning in consumers.
export IPHONEOS_DEPLOYMENT_TARGET="$IOS_MIN"
export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"

RUST_TARGETS="aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin"
for t in $RUST_TARGETS; do
  echo "→ ensure toolchain $t"
  rustup target add "$t" >/dev/null
  echo "→ cargo build --release --target $t"
  nice -n 19 cargo build --release \
    --manifest-path "$ROOT/packages/core-rs/Cargo.toml" \
    --target "$t" -p librovenue
done

rm -rf "$STAGE"
mkdir -p "$STAGE/headers" "$STAGE/ios" "$STAGE/iossim" "$STAGE/macos"

# A self-contained headers directory. uniffi's own modulemap already refers to
# the header by bare name ("RovenueFFI.h"), so no rewriting is needed — but the
# hand-written Sources/RovenueFFI/module.modulemap does NOT work here: it uses
# a ../ path that escapes the slice.
cp "$GEN/RovenueFFI.h" "$STAGE/headers/"
cp "$GEN/RovenueFFI.modulemap" "$STAGE/headers/module.modulemap"

# Every slice's library MUST have the same basename — see verify-xcframework.sh.
cp "$ROOT/target/aarch64-apple-ios/release/librovenue.a" "$STAGE/ios/$SLICE_LIB_NAME"
lipo -create \
  "$ROOT/target/aarch64-apple-ios-sim/release/librovenue.a" \
  "$ROOT/target/x86_64-apple-ios/release/librovenue.a" \
  -output "$STAGE/iossim/$SLICE_LIB_NAME"
lipo -create \
  "$ROOT/target/aarch64-apple-darwin/release/librovenue.a" \
  "$ROOT/target/x86_64-apple-darwin/release/librovenue.a" \
  -output "$STAGE/macos/$SLICE_LIB_NAME"

mkdir -p "$OUT_DIR"
rm -rf "${OUT_DIR:?}/$XCF_NAME"
xcodebuild -create-xcframework \
  -library "$STAGE/ios/$SLICE_LIB_NAME"    -headers "$STAGE/headers" \
  -library "$STAGE/iossim/$SLICE_LIB_NAME" -headers "$STAGE/headers" \
  -library "$STAGE/macos/$SLICE_LIB_NAME"  -headers "$STAGE/headers" \
  -output "$OUT_DIR/$XCF_NAME"

"$HERE/verify-xcframework.sh" "$OUT_DIR/$XCF_NAME"
echo "✓ $OUT_DIR/$XCF_NAME"
```

- [ ] **Step 5: Run the build script and confirm the verifier now passes**

Run: `chmod +x packages/sdk-swift/scripts/build-xcframework.sh && ./packages/sdk-swift/scripts/build-xcframework.sh`
Expected: ends with
```
✓ packages/sdk-swift/RovenueFFI.xcframework — 3 slices, matching basenames, correct platforms and deployment targets
✓ packages/sdk-swift/RovenueFFI.xcframework
```

- [ ] **Step 6: Prove the name assertion is not vacuous**

Temporarily rename one slice's library and re-run the verifier:

```bash
mv packages/sdk-swift/RovenueFFI.xcframework/macos-arm64_x86_64/librovenue_ffi.a \
   packages/sdk-swift/RovenueFFI.xcframework/macos-arm64_x86_64/librovenue_macos.a
./packages/sdk-swift/scripts/verify-xcframework.sh packages/sdk-swift/RovenueFFI.xcframework
```

Expected: FAIL — `✗ macos-arm64_x86_64: missing librovenue_ffi.a (all slices must share this basename)`

Then rebuild to restore: `./packages/sdk-swift/scripts/build-xcframework.sh`

- [ ] **Step 7: Delete the superseded script**

```bash
git rm packages/sdk-swift/scripts/build-ios-static.sh
```

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-swift/release.config.json \
        packages/sdk-swift/scripts/build-xcframework.sh \
        packages/sdk-swift/scripts/verify-xcframework.sh
git commit -m "feat(sdk-swift): build RovenueFFI.xcframework with asserted slices

Replaces build-ios-static.sh, whose single arm64 slice could serve one
platform and which shipped a simulator build labelled as device.

verify-xcframework.sh reads real Mach-O headers: platform id per slice,
minimum OS version, and the identical-basename rule CocoaPods enforces
but reports with a truncated message."
```

---

### Task 2: SwiftPM consumes the xcframework as a binary target

**Files:**
- Modify: `packages/sdk-swift/Package.swift`
- Delete: `packages/sdk-swift/Sources/RovenueFFI/module.modulemap` (and the now-empty directory)
- Delete: `packages/sdk-swift/Sources/Rovenue/librovenue_ffi.a` (tracked, 32 MB, wrong platform)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `scripts/build-xcframework.sh` from Task 1, which must have been run so `packages/sdk-swift/RovenueFFI.xcframework` exists
- Produces: a `Package.swift` with a `RovenueFFI` binary target and **no** `unsafeFlags`, which later tasks copy into the generated distribution repo

- [ ] **Step 1: Confirm the current baseline before changing anything**

Run: `cd packages/sdk-swift && nice -n 19 swift test 2>&1 | tail -3`
Expected: `Executed 343 tests, with 0 failures`

Record the number. It must not change in Step 5.

- [ ] **Step 2: Rewrite `Package.swift`**

```swift
// swift-tools-version: 5.9
import PackageDescription

// RovenueFFI.xcframework is a build artifact, not a checked-in binary — run
// packages/sdk-swift/scripts/build-xcframework.sh before building this package.
//
// It is a `binaryTarget` rather than a `systemLibrary` + `-L` linker flag on
// purpose: SwiftPM refuses a version-based dependency whose product contains a
// target with `unsafeFlags`, so the previous manifest could never be consumed
// by an external package at all.
let package = Package(
    name: "Rovenue",
    platforms: [.iOS(.v16), .macOS(.v12)],
    products: [
        .library(name: "Rovenue", targets: ["Rovenue"]),
    ],
    targets: [
        .binaryTarget(
            name: "RovenueFFI",
            path: "RovenueFFI.xcframework"
        ),
        .target(
            name: "Rovenue",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            resources: [.copy("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "RovenueTests",
            dependencies: ["Rovenue"],
            path: "Tests/RovenueTests"
        ),
    ]
)
```

- [ ] **Step 3: Delete the superseded system-library shim and the tracked binary**

```bash
git rm -r packages/sdk-swift/Sources/RovenueFFI
git rm packages/sdk-swift/Sources/Rovenue/librovenue_ffi.a
```

- [ ] **Step 4: Ignore built artifacts**

Append to `.gitignore`:

```gitignore
# Apple binary artifacts are built by packages/sdk-swift/scripts/build-xcframework.sh,
# never committed. A 32 MB librovenue_ffi.a used to live in the tree — and it
# was the wrong platform slice for its entire life.
**/RovenueFFI.xcframework
packages/sdk-swift/build/
```

- [ ] **Step 5: Run the tests against the binary target**

Run: `cd packages/sdk-swift && nice -n 19 swift test 2>&1 | tail -3`
Expected: `Executed 343 tests, with 0 failures` — the same count as Step 1, with no `DYLD_LIBRARY_PATH` set.

- [ ] **Step 6: Confirm the unsafe flag is gone**

Run: `grep -c unsafeFlags packages/sdk-swift/Package.swift`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-swift/Package.swift .gitignore
git commit -m "feat(sdk-swift): consume RovenueFFI as a binaryTarget

Drops the systemLibrary shim and the unsafeFlags linker hop. SwiftPM
rejects a version-based dependency whose product contains unsafe flags,
so the old manifest had no working external SPM channel regardless of
the binary.

Also removes the tracked 32 MB librovenue_ffi.a, which otool reports as
an iOS *simulator* build despite the podspec documenting it as device."
```

---

### Task 3: `Rovenue.podspec` vendors the xcframework and gains macOS

**Files:**
- Modify: `packages/sdk-swift/Rovenue.podspec`
- Create: `packages/sdk-swift/Tests/config-version-parity.sh`

**Interfaces:**
- Consumes: `release.config.json` (Task 1), `RovenueFFI.xcframework` (Task 1)
- Produces: a podspec whose `:http` source URL derives from `repoSlug`; later tasks patch only its `:sha256`

- [ ] **Step 1: Write the parity check (the failing test)**

The podspec version, the Cargo workspace version and `release.config.json` must
agree. Three hand-maintained copies of one number is exactly the kind of link
that rots silently.

`packages/sdk-swift/Tests/config-version-parity.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Asserts that the Swift release config, the Cargo workspace and the podspec
# all state the same version. Run in CI; a mismatch means a release would ship
# a podspec pointing at an artifact built from different sources.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SWIFT_DIR/../.." && pwd)"

config_version=$(ruby -rjson -e "print JSON.parse(File.read('$SWIFT_DIR/release.config.json'))['version']")
cargo_version=$(grep -m1 '^version = ' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')
podspec_version=$(ruby -e "
  require 'cocoapods-core'
  print Pod::Specification.from_file('$SWIFT_DIR/Rovenue.podspec').version.to_s
")

if [ "$config_version" != "$cargo_version" ] || [ "$config_version" != "$podspec_version" ]; then
  echo "✗ version mismatch: release.config.json=$config_version Cargo.toml=$cargo_version Rovenue.podspec=$podspec_version" >&2
  exit 1
fi

echo "✓ version $config_version consistent across release.config.json, Cargo.toml and Rovenue.podspec"
```

- [ ] **Step 2: Run it against the current podspec to see it fail**

Run: `chmod +x packages/sdk-swift/Tests/config-version-parity.sh && ./packages/sdk-swift/Tests/config-version-parity.sh`
Expected: PASS at this point (all three already read `0.16.0`). To prove the check is not vacuous, temporarily edit `release.config.json`'s `version` to `9.9.9`, re-run, and expect
`✗ version mismatch: release.config.json=9.9.9 Cargo.toml=0.16.0 Rovenue.podspec=0.16.0`
Then restore `0.16.0`.

- [ ] **Step 3: Rewrite the podspec**

`packages/sdk-swift/Rovenue.podspec`:

```ruby
# Rovenue.podspec — CocoaPods wrapper for the Swift façade.
#
# The release artifact is a sha256-pinned zip on GitHub Releases containing
# Sources/ + RovenueFFI.xcframework + this podspec. The xcframework carries
# three slices (iOS device, iOS simulator, macOS) and uniffi's own module map,
# which is why this spec needs no SWIFT_INCLUDE_PATHS: consumers resolve the
# RovenueFFI Clang module from inside the vendored artifact.
require 'json'

CONFIG = JSON.parse(File.read(File.join(__dir__, 'release.config.json'))).freeze

Pod::Spec.new do |s|
  s.name             = CONFIG['podName']
  s.version          = CONFIG['version']
  s.summary          = 'Rovenue Swift façade'
  s.homepage         = 'https://rovenue.app'
  s.license          = { :type => 'AGPL-3.0' }
  s.authors          = 'Rovenue'
  s.platforms        = {
    :ios => CONFIG['iosDeploymentTarget'],
    :osx => CONFIG['macosDeploymentTarget'],
  }
  s.swift_version    = '5.9'
  s.source           = {
    :http   => "https://github.com/#{CONFIG['repoSlug']}/releases/download/sdk-swift-v#{s.version}/#{s.name}-#{s.version}.zip",
    :sha256 => '0000000000000000000000000000000000000000000000000000000000000000'
  }
  s.source_files        = 'Sources/Rovenue/**/*.swift'
  s.vendored_frameworks = CONFIG['xcframeworkName']

  # Apple privacy manifest — bundled so the publishable artifact carries its
  # own PrivacyInfo.xcprivacy, not just the Expo bridge pod.
  s.resource_bundles    = { 'Rovenue_privacy' => ['Sources/Rovenue/PrivacyInfo.xcprivacy'] }
end
```

Note what is **gone**: `vendored_libraries`, `preserve_paths`, `pod_target_xcconfig`, and the `librovenue.a`-vs-`libRovenue.a` case-collision comment (there is no vendored bare library to collide any more).

- [ ] **Step 4: Lint both platforms**

Run:
```bash
cd packages/sdk-swift
pod lib lint Rovenue.podspec --allow-warnings --skip-tests --platforms=ios
pod lib lint Rovenue.podspec --allow-warnings --skip-tests --platforms=macos
```
Expected: `Rovenue passed validation.` twice.

- [ ] **Step 5: Confirm the source URL now points at the real repository**

Run: `ruby -rcocoapods-core -e "puts Pod::Specification.from_file('packages/sdk-swift/Rovenue.podspec').source[:http]"`
Expected: a URL containing `broverse/rovenue`, not `rovenue/rovenue`.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Rovenue.podspec packages/sdk-swift/Tests/config-version-parity.sh
git commit -m "feat(sdk-swift): vendor the xcframework, add macOS, fix the release URL

vendored_frameworks replaces vendored_libraries, so preserve_paths and
SWIFT_INCLUDE_PATHS both go: the module map ships inside the artifact.

The :http source pointed at github.com/rovenue/rovenue, which does not
exist — the remote is broverse/rovenue. The owner/repo is now stated once
in release.config.json and every URL derives from it.

config-version-parity.sh pins release.config.json, Cargo.toml and the
podspec to one version."
```

---

### Task 4: The React Native pod stops reaching into the monorepo

**Files:**
- Modify: `packages/sdk-rn/ios/RovenueSdkRn.podspec`
- Modify: `packages/sdk-rn/plugin/withRovenueIos.ts`
- Modify: `packages/sdk-rn/plugin/__tests__/withRovenueIos.test.ts` (create if absent)

**Interfaces:**
- Consumes: the `Rovenue` pod from Task 3, which now carries its own module map
- Produces: a podspec with no path escaping its own directory — the property Task 10 verifies with a real app build

- [ ] **Step 1: Write the failing test for the config plugin's default pod line**

The plugin's default was `pod 'Rovenue', '~> 0.1'`, an optimistic constraint
that would accept any `0.x`. The bridge and the façade are released in lockstep,
so it must pin exactly, matching what `rovenue_flutter_ios.podspec` already does.

`packages/sdk-rn/plugin/__tests__/withRovenueIos.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { rovenuePodLine } from "../withRovenueIos";

describe("rovenuePodLine", () => {
  it("pins the exact package version when no local path is given", () => {
    expect(rovenuePodLine(undefined)).toBe(`  pod 'Rovenue', '${pkg.version}'`);
  });

  it("uses a local path reference for monorepo consumers", () => {
    expect(rovenuePodLine("../../packages/sdk-swift")).toBe(
      "  pod 'Rovenue', :path => '../../packages/sdk-swift'",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice -n 19 pnpm --filter @rovenue/react-native-sdk test -- withRovenueIos`
Expected: FAIL — `rovenuePodLine` is not exported.

- [ ] **Step 3: Extract and fix the pod line in the plugin**

In `packages/sdk-rn/plugin/withRovenueIos.ts`, replace the inline ternary with an exported function:

```typescript
import pkg from "../package.json";

/**
 * The Podfile line injected into the consumer's target.
 *
 * External consumers get an exact version pin: the bridge pod and the `Rovenue`
 * façade are released together, and a bridge built against a different façade
 * version fails at link time rather than at resolve time. Monorepo consumers
 * pass a path and bypass Trunk entirely.
 */
export function rovenuePodLine(rovenueSwiftPath: string | undefined): string {
  return rovenueSwiftPath
    ? `  pod 'Rovenue', :path => '${rovenueSwiftPath}'`
    : `  pod 'Rovenue', '${pkg.version}'`;
}
```

and use it in the mod:

```typescript
    const podLine = rovenuePodLine(opts?.rovenueSwiftPath);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice -n 19 pnpm --filter @rovenue/react-native-sdk test -- withRovenueIos`
Expected: PASS, 2 tests.

- [ ] **Step 5: Strip both xcconfig blocks from the bridge podspec**

In `packages/sdk-rn/ios/RovenueSdkRn.podspec`, delete `s.pod_target_xcconfig`,
`s.user_target_xcconfig` and their explanatory comments, and replace the
`s.dependency 'Rovenue'` line with an exact pin. Replace the removed comments
with one that records why they are gone:

```ruby
  # Swift façade. Pinned exactly: the bridge is compiled against this façade's
  # generated types.
  #
  # No SWIFT_INCLUDE_PATHS here. The `Rovenue` pod vendors
  # RovenueFFI.xcframework, which carries uniffi's module map inside each
  # slice, so the transitive `RovenueFFI` Clang module resolves without any
  # target needing a path into this monorepo. That path is precisely what made
  # this pod impossible to consume from npm.
  s.dependency 'Rovenue', package['version']
```

- [ ] **Step 6: Assert no path escapes the package**

Run: `grep -n "PODS_ROOT\|SWIFT_INCLUDE_PATHS\|\.\./\.\./" packages/sdk-rn/ios/RovenueSdkRn.podspec`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/ios/RovenueSdkRn.podspec \
        packages/sdk-rn/plugin/withRovenueIos.ts \
        packages/sdk-rn/plugin/__tests__/withRovenueIos.test.ts
git commit -m "feat(sdk-rn): remove the monorepo escape from the iOS pod

Both xcconfig blocks existed only to put sdk-swift's module map on the
import path; \${PODS_ROOT}/../../../.. resolves to nothing in an npm
install. The xcframework carries the module map, so they go.

The config plugin's default pod line was '~> 0.1', which accepts any 0.x
release of a façade the bridge is compiled against. Now pinned exactly."
```

---

### Task 5: The Flutter example drops its `post_install` workaround

**Files:**
- Modify: `packages/sdk-flutter/example/ios/Podfile`

**Interfaces:**
- Consumes: the `Rovenue` pod from Task 3
- Produces: an example Podfile with no `SWIFT_INCLUDE_PATHS` manipulation — verified by a real build in Task 10

- [ ] **Step 1: Delete the workaround block**

Remove the entire block that begins with the comment
`# Work around a CocoaPods bug when \`Rovenue\`'s SWIFT_INCLUDE_PATHS` and ends
with the `end` closing `installer.pods_project.targets.each`, including the
`rovenue_ffi_include_path` assignment.

Its comment claimed the problem was *"not fixable from `Rovenue.podspec`"*. That
was true of a bare `.a` with an out-of-pod module map; it stops being true once
the module map ships inside the vendored artifact.

- [ ] **Step 2: Assert the workaround is gone**

Run: `grep -n "SWIFT_INCLUDE_PATHS\|rovenue_ffi_include_path" packages/sdk-flutter/example/ios/Podfile`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-flutter/example/ios/Podfile
git commit -m "fix(sdk-flutter): drop the SWIFT_INCLUDE_PATHS post_install hack

The block rewrote SWIFT_INCLUDE_PATHS on the Rovenue and
rovenue_flutter_ios targets because CocoaPods dropped the RovenueFFI leaf
segment when propagating the path. With the module map inside the
xcframework there is no path to propagate."
```

---

### Task 6: CI builds the artifact and lints with the right tool

**Files:**
- Modify: `.github/workflows/sdk.yml` (the `swift` job)
- Modify: `.github/workflows/sdk-swift-pod-lint.yml`

**Interfaces:**
- Consumes: `scripts/build-xcframework.sh` (Task 1), the podspec (Task 3), `Tests/config-version-parity.sh` (Task 3)
- Produces: green PR checks that do not depend on a published release

- [ ] **Step 1: Replace the `swift` job's test step in `.github/workflows/sdk.yml`**

```yaml
  swift:
    name: Swift façade
    runs-on: macos-14
    needs: bindgen-host
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.88.0
      - uses: Swatinem/rust-cache@v2
      - name: Version parity (config / Cargo / podspec)
        run: ./packages/sdk-swift/Tests/config-version-parity.sh
      # Builds the bindings and all five Apple slices, then asserts the
      # artifact's shape. Replaces the previous DYLD_LIBRARY_PATH hop into
      # target/release, which only ever worked for the host platform.
      - name: Build RovenueFFI.xcframework
        run: ./packages/sdk-swift/scripts/build-xcframework.sh
      - name: swift test
        working-directory: packages/sdk-swift
        run: swift test
```

- [ ] **Step 2: Replace `.github/workflows/sdk-swift-pod-lint.yml` entirely**

```yaml
# Lints packages/sdk-swift/Rovenue.podspec on any PR that touches the
# sdk-swift package or this workflow.
#
# Uses `pod lib lint`, which builds from the checked-out sources. The previous
# `pod spec lint` resolved the podspec's :http source over the network, so it
# could not pass until a GitHub Release existed — the workflow documented that
# as an expected failure. That red was the wrong tool, not a missing release.
# `pod spec lint` belongs in the release job, where the release exists.

name: sdk-swift pod lint

on:
  pull_request:
    paths:
      - 'packages/sdk-swift/**'
      - '.github/workflows/sdk-swift-pod-lint.yml'

jobs:
  lint:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.88.0
      - uses: Swatinem/rust-cache@v2
      - name: Build RovenueFFI.xcframework
        run: ./packages/sdk-swift/scripts/build-xcframework.sh
      - name: pod lib lint (iOS)
        run: pod lib lint packages/sdk-swift/Rovenue.podspec --allow-warnings --skip-tests --platforms=ios
      - name: pod lib lint (macOS)
        run: pod lib lint packages/sdk-swift/Rovenue.podspec --allow-warnings --skip-tests --platforms=macos
```

- [ ] **Step 3: Validate the workflow files parse**

Run: `ruby -ryaml -e "%w[.github/workflows/sdk.yml .github/workflows/sdk-swift-pod-lint.yml].each { |f| YAML.load_file(f); puts \"ok #{f}\" }"`
Expected: `ok` for both.

- [ ] **Step 4: Confirm the stale expectation is gone**

Run: `grep -rn "Expected to FAIL\|expected to fail" .github/workflows/`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/sdk.yml .github/workflows/sdk-swift-pod-lint.yml
git commit -m "ci(sdk-swift): build the xcframework, lint with pod lib lint

pod spec lint resolves the :http source over the network, so the pod-lint
workflow could not pass before a release existed and said so in a comment.
pod lib lint builds from local sources and belongs in PRs; pod spec lint
moves to the release job.

The swift job now builds the real artifact instead of pointing
DYLD_LIBRARY_PATH at a host-only target/release build."
```

---

### Task 7: `release-pod.sh` produces two artifacts and stops being a release path

**Files:**
- Modify: `packages/sdk-swift/scripts/release-pod.sh`

**Interfaces:**
- Consumes: `build-xcframework.sh`, `release.config.json` (Task 1); the podspec (Task 3)
- Produces: `build/Rovenue-<v>.zip` and `build/RovenueFFI-<v>.xcframework.zip` plus both checksums, printed for the release job and the operator

- [ ] **Step 1: Replace the script entirely**

`packages/sdk-swift/scripts/release-pod.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# release-pod.sh — builds the two release artifacts and prints their checksums.
#
# This script MUTATES NOTHING. It does not create releases, patch files, commit
# or tag; .github/workflows/release-sdk.yml is the single authoritative release
# path. A local script that can also cut a release is how a release gets cut
# from an unclean tree.
#
# Two artifacts, because the channels need differently shaped zips:
#
#   Rovenue-<v>.zip                  Sources/ + RovenueFFI.xcframework + podspec
#                                    → pinned by Rovenue.podspec's :sha256
#   RovenueFFI-<v>.xcframework.zip   the xcframework at the ZIP ROOT, nothing
#                                    else → pinned by the SwiftPM distribution
#                                    package's binaryTarget(checksum:)
#
# `binaryTarget(url:)` fails to resolve if the .xcframework is nested inside a
# directory in the zip, and the error does not say so.
#
# Usage: ./packages/sdk-swift/scripts/release-pod.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
CONFIG="$SWIFT_DIR/release.config.json"
PODSPEC="$SWIFT_DIR/Rovenue.podspec"
BUILD_DIR="$SWIFT_DIR/build"

cfg() { ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['$1']"; }

POD_NAME="$(cfg podName)"
VERSION="$(cfg version)"
XCF_NAME="$(cfg xcframeworkName)"

# -------- Preflight --------
echo "→ preflight"
for tool in pod shasum zip swift; do
  command -v "$tool" >/dev/null 2>&1 \
    || { echo "✗ missing required tool: $tool" >&2; exit 1; }
done

"$SWIFT_DIR/Tests/config-version-parity.sh"

STAGE_DIR="$BUILD_DIR/$POD_NAME-$VERSION"
POD_ZIP="$BUILD_DIR/$POD_NAME-$VERSION.zip"
XCF_ZIP="$BUILD_DIR/RovenueFFI-$VERSION.xcframework.zip"

# -------- Build --------
echo "→ build $XCF_NAME"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
"$HERE/build-xcframework.sh" "$STAGE_DIR" >/dev/null

# -------- Stage the CocoaPods artifact --------
echo "→ stage Sources + podspec into $STAGE_DIR"
mkdir -p "$STAGE_DIR/Sources"
cp -R "$SWIFT_DIR/Sources/Rovenue" "$STAGE_DIR/Sources/Rovenue"
cp "$PODSPEC" "$CONFIG" "$STAGE_DIR/"

echo "→ zip → $POD_ZIP"
rm -f "$POD_ZIP"
( cd "$BUILD_DIR" && zip -rq "$(basename "$POD_ZIP")" "$POD_NAME-$VERSION" )

# -------- Zip the SwiftPM artifact (xcframework at the root) --------
echo "→ zip → $XCF_ZIP"
rm -f "$XCF_ZIP"
( cd "$STAGE_DIR" && zip -rq "$XCF_ZIP" "$XCF_NAME" )

# -------- Checksums --------
POD_SHA=$(shasum -a 256 "$POD_ZIP" | awk '{print $1}')
XCF_SHA=$(swift package compute-checksum "$XCF_ZIP")

# -------- Local lint --------
# pod lib lint, never pod spec lint: the :http source does not exist until the
# release job uploads. pod spec lint runs there, against the live URL.
echo "→ pod lib lint (ios, macos)"
pod lib lint "$PODSPEC" --allow-warnings --skip-tests --platforms=ios
pod lib lint "$PODSPEC" --allow-warnings --skip-tests --platforms=macos

# -------- Report --------
cat <<REPORT

──────────────────────────────────────────────────────────────
Artifacts built. Nothing was uploaded, patched, committed or tagged.

  $POD_ZIP
    sha256 (Rovenue.podspec :sha256)      $POD_SHA

  $XCF_ZIP
    checksum (binaryTarget checksum:)     $XCF_SHA

To publish, run the release-sdk.yml workflow with swift: true.
It uploads both, pins both checksums, then tags — in that order.
──────────────────────────────────────────────────────────────
REPORT
```

Note what is gone along with the old body: the `--dry-run` and `--skip-upload`
flags, the `gh` preflight and auth check, the clean-tree and branch checks (a
script that changes nothing needs no clean tree), and the duplicated
`build-ios-static.sh` call that existed only because `cp -R` overwrote the first
invocation's output.

- [ ] **Step 2: Run it and check both artifacts**

Run: `./packages/sdk-swift/scripts/release-pod.sh`
Expected: prints two paths and two checksums; both files exist.

- [ ] **Step 3: Assert the SwiftPM zip's shape**

`binaryTarget(url:)` fails at resolve time if the xcframework is nested inside a
directory in the zip, and the failure message does not say so.

Run:
```bash
unzip -l packages/sdk-swift/build/RovenueFFI-0.16.0.xcframework.zip | awk 'NR>3{print $4}' | cut -d/ -f1 | sort -u | head
```
Expected: a single entry, `RovenueFFI.xcframework`.

- [ ] **Step 4: Assert the script no longer mutates anything**

Run: `grep -n "gh release create\|git commit\|git tag\|pod trunk push" packages/sdk-swift/scripts/release-pod.sh`
Expected: matches only inside `echo` lines that print instructions, never as executed commands.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/scripts/release-pod.sh
git commit -m "refactor(sdk-swift): release-pod.sh builds both artifacts, mutates nothing

CocoaPods and SwiftPM need differently shaped zips: the pod artifact
carries Sources + podspec + xcframework, while binaryTarget(url:) requires
the xcframework at the zip root. One zip cannot serve both checksums.

The script no longer creates releases, patches files, commits or tags —
release-sdk.yml is the single authoritative release path. A local script
that can also cut a release is how a release gets cut from an unclean tree."
```

---

### Task 8: Generate the SwiftPM distribution repository

**Files:**
- Create: `packages/sdk-swift/scripts/generate-swift-dist.sh`

**Interfaces:**
- Consumes: `release.config.json` (Task 1), `Package.swift` (Task 2), the xcframework zip and its checksum (Task 7)
- Produces: `build/swift-dist/` — a complete, committable package tree; the release job pushes it

- [ ] **Step 1: Write the generator**

`packages/sdk-swift/scripts/generate-swift-dist.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# generate-swift-dist.sh — renders the standalone SwiftPM distribution package.
#
# External SPM consumers cannot depend on this monorepo: a tag here would carry
# a manifest whose binaryTarget points at a local path. They depend on a
# separate repository whose tags carry a manifest with a fixed url + checksum.
# That repository is generated output, never hand-edited.
#
# Usage: ./generate-swift-dist.sh <XCFRAMEWORK_ZIP_CHECKSUM> [OUT_DIR]

if [ $# -lt 1 ]; then
  echo "usage: $0 <XCFRAMEWORK_ZIP_CHECKSUM> [OUT_DIR]" >&2
  exit 2
fi

CHECKSUM="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
CONFIG="$SWIFT_DIR/release.config.json"
OUT_DIR="${2:-$SWIFT_DIR/build/swift-dist}"

cfg() { ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['$1']"; }

REPO_SLUG="$(cfg repoSlug)"
VERSION="$(cfg version)"
POD_NAME="$(cfg podName)"

# A 64-character lowercase hex string is the only thing SwiftPM accepts.
echo "$CHECKSUM" | grep -Eq '^[0-9a-f]{64}$' \
  || { echo "✗ checksum is not 64 hex chars: $CHECKSUM" >&2; exit 1; }

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/Sources"
cp -R "$SWIFT_DIR/Sources/Rovenue" "$OUT_DIR/Sources/Rovenue"

cat > "$OUT_DIR/Package.swift" <<EOF
// swift-tools-version: 5.9
//
// GENERATED by packages/sdk-swift/scripts/generate-swift-dist.sh — do not edit.
// Source of truth: https://github.com/$REPO_SLUG (packages/sdk-swift)
import PackageDescription

let package = Package(
    name: "$POD_NAME",
    platforms: [.iOS(.v16), .macOS(.v12)],
    products: [
        .library(name: "$POD_NAME", targets: ["$POD_NAME"]),
    ],
    targets: [
        .binaryTarget(
            name: "RovenueFFI",
            url: "https://github.com/$REPO_SLUG/releases/download/sdk-swift-v$VERSION/RovenueFFI-$VERSION.xcframework.zip",
            checksum: "$CHECKSUM"
        ),
        .target(
            name: "$POD_NAME",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            resources: [.copy("PrivacyInfo.xcprivacy")]
        ),
    ]
)
EOF

cat > "$OUT_DIR/README.md" <<EOF
# $POD_NAME (Swift Package)

Generated distribution package for the Rovenue Swift SDK. **Do not send pull
requests here** — the source lives at https://github.com/$REPO_SLUG under
\`packages/sdk-swift\`, and this repository is regenerated on every release.

\`\`\`swift
.package(url: "https://github.com/$REPO_SLUG-swift.git", from: "$VERSION"),
\`\`\`
EOF

echo "✓ $OUT_DIR (version $VERSION, checksum ${CHECKSUM:0:12}…)"
```

- [ ] **Step 2: Verify it rejects a bad checksum**

Run: `chmod +x packages/sdk-swift/scripts/generate-swift-dist.sh && ./packages/sdk-swift/scripts/generate-swift-dist.sh not-a-checksum`
Expected: FAIL — `✗ checksum is not 64 hex chars: not-a-checksum`

- [ ] **Step 3: Generate with the real checksum and confirm the manifest parses**

```bash
CHK=$(swift package compute-checksum packages/sdk-swift/build/RovenueFFI-0.16.0.xcframework.zip)
./packages/sdk-swift/scripts/generate-swift-dist.sh "$CHK"
cd packages/sdk-swift/build/swift-dist && swift package dump-package > /dev/null && echo "manifest ok"
```
Expected: `manifest ok`. (`swift build` here would download the release URL, which does not exist yet — that is Task 10's operator step, not a check we can run now.)

- [ ] **Step 4: Confirm the generated tree is a pure function of its inputs**

Run:
```bash
./packages/sdk-swift/scripts/generate-swift-dist.sh "$CHK" /tmp/dist-a
./packages/sdk-swift/scripts/generate-swift-dist.sh "$CHK" /tmp/dist-b
diff -r /tmp/dist-a /tmp/dist-b && echo "deterministic"
```
Expected: `deterministic` with no diff output. This is the drift guard: the
release job regenerates from scratch, so any difference against the previous
tag must come from a source change.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/scripts/generate-swift-dist.sh
git commit -m "feat(sdk-swift): generate the SwiftPM distribution package

External SPM consumers need a tag whose manifest pins url + checksum. A
manifest that switches on local filesystem state or an env var resolves
differently on different machines, so the distribution package is a
separate, generated repository — the shape Mozilla and Matrix use for the
same Rust-core-plus-Swift-facade problem.

Generation is deterministic, which is what makes hand edits detectable."
```

---

### Task 9: Wire the release workflow to the corrected ordering

**Files:**
- Modify: `.github/workflows/release-sdk.yml` (the `publish-swift` job)

**Interfaces:**
- Consumes: `release-pod.sh` (Task 7), `generate-swift-dist.sh` (Task 8)
- Produces: the single authoritative release path

- [ ] **Step 1: Rewrite the `publish-swift` job**

```yaml
  publish-swift:
    name: Publish Swift (CocoaPods + SwiftPM)
    needs: verify
    if: ${{ inputs.swift }}
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.88.0
      - uses: Swatinem/rust-cache@v2

      # 1. Build both artifacts. The script mutates nothing.
      - name: Build release artifacts
        working-directory: packages/sdk-swift
        run: ./scripts/release-pod.sh

      # 2. Upload before pinning: a checksum must describe a file that exists.
      - name: Create GitHub Release
        working-directory: packages/sdk-swift
        run: |
          VERSION=$(ruby -rjson -e "print JSON.parse(File.read('release.config.json'))['version']")
          gh release create "sdk-swift-v$VERSION" \
            "build/Rovenue-$VERSION.zip" \
            "build/RovenueFFI-$VERSION.xcframework.zip" \
            --title "sdk-swift v$VERSION" \
            --notes "Rovenue Swift façade $VERSION."
        env:
          GH_TOKEN: ${{ github.token }}

      # 3. Pin both checksums against the uploaded files.
      - name: Pin podspec sha256
        working-directory: packages/sdk-swift
        run: |
          VERSION=$(ruby -rjson -e "print JSON.parse(File.read('release.config.json'))['version']")
          SHA=$(shasum -a 256 "build/Rovenue-$VERSION.zip" | awk '{print $1}')
          sed -i'' -E "s/:sha256 => '[0-9a-fA-F]{64}'/:sha256 => '$SHA'/" Rovenue.podspec
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add Rovenue.podspec
          git commit -m "chore(sdk-swift): pin Rovenue podspec sha256 for v$VERSION"
          git push

      # 4. Release lint runs against the now-live :http source — this is where
      #    `pod spec lint` belongs, and the only place it can pass.
      - name: pod spec lint
        working-directory: packages/sdk-swift
        run: pod spec lint Rovenue.podspec --allow-warnings --skip-tests

      - name: pod trunk push
        working-directory: packages/sdk-swift
        run: pod trunk push Rovenue.podspec --allow-warnings
        env:
          COCOAPODS_TRUNK_TOKEN: ${{ secrets.COCOAPODS_TRUNK_TOKEN }}

      # 5. Generate and push the SwiftPM distribution repository, then tag it
      #    LAST — a consumer resolving the tag must find the pinned checksum.
      - name: Publish SwiftPM distribution package
        working-directory: packages/sdk-swift
        run: |
          VERSION=$(ruby -rjson -e "print JSON.parse(File.read('release.config.json'))['version']")
          SLUG=$(ruby -rjson -e "print JSON.parse(File.read('release.config.json'))['repoSlug']")
          CHK=$(swift package compute-checksum "build/RovenueFFI-$VERSION.xcframework.zip")
          ./scripts/generate-swift-dist.sh "$CHK"
          cd build/swift-dist
          git init -q .
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -q -m "Rovenue Swift SDK $VERSION"
          git tag "$VERSION"
          git push --force "https://x-access-token:${GH_TOKEN}@github.com/${SLUG}-swift.git" HEAD:main --tags
        env:
          GH_TOKEN: ${{ secrets.SWIFT_DIST_REPO_TOKEN }}
```

- [ ] **Step 2: Remove the stale note in the `publish-flutter` job**

The `publish-flutter` job carries a NOTE saying `Rovenue.podspec`'s sha256 is a
placeholder over an unpublished release. That is now handled by the ordering
above — `publish-swift` uploads and pins before Flutter publishes. Replace the
note with a `needs: publish-swift` dependency so the ordering is enforced by the
graph rather than described in prose:

```yaml
  publish-flutter:
    name: Publish Flutter (pub.dev)
    # rovenue_flutter_ios depends on the `Rovenue` pod from Trunk, so the
    # Swift publish must land first. Previously a comment; now an edge.
    needs: [verify, publish-swift]
```

- [ ] **Step 3: Validate the workflow parses**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/release-sdk.yml'); puts 'ok'"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-sdk.yml
git commit -m "ci(sdk-swift): correct release ordering; publish SwiftPM package

Upload, then pin both checksums, then tag. The old flow created the
release, patched the podspec and committed — leaving the git tag pointing
at the commit before the pin. CocoaPods survived that because it resolves
an :http URL, but a SwiftPM consumer resolves the tag.

publish-flutter's prose note about the unpublished pod becomes a needs:
edge on publish-swift."
```

---

### Task 10: Verify in real apps — the only check lint cannot make

**Files:**
- Modify: none expected. Fix whatever the builds reveal.

**Interfaces:**
- Consumes: every preceding task
- Produces: evidence that the RN and Flutter pods build with no module-path workaround anywhere

This task exists because `pod lib lint` cannot load Expo pods outside an Expo
app's autolinking environment (`ExpoModulesCore.podspec` raises
`Pod::DSLError` standalone), so Tasks 4 and 5 shipped unverified claims.

- [ ] **Step 1: Build the xcframework fresh**

Run: `./packages/sdk-swift/scripts/build-xcframework.sh`
Expected: the verifier's `✓` line.

- [ ] **Step 2: Install pods for the Expo example**

```bash
cd examples/sample-rn-expo
rm -rf ios/Pods ios/Podfile.lock
npx expo prebuild --platform ios --clean
cd ios && pod install
```
Expected: `pod install` completes and the `Rovenue` pod resolves via the config
plugin's `:path` reference.

- [ ] **Step 3: Assert no include-path workaround survives anywhere in the app**

```bash
grep -rn "SWIFT_INCLUDE_PATHS" examples/sample-rn-expo/ios/ || echo "clean"
```
Expected: `clean`. If any match appears, the module map is not being found
through the xcframework and Task 4 is not actually done — investigate before
continuing rather than reinstating the hack.

- [ ] **Step 4: Build the app for a simulator**

```bash
cd examples/sample-rn-expo/ios
xcodebuild -workspace *.xcworkspace -scheme samplernexpo \
  -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' build | tail -5
```
Expected: `** BUILD SUCCEEDED **`

> The simulator slice is what makes this possible at all: the previously
> vendored library was a simulator build mislabelled as device, so a device
> build would have failed and a simulator build passed by accident.

- [ ] **Step 5: Build the Flutter example for iOS**

```bash
cd packages/sdk-flutter/example
flutter pub get
flutter build ios --simulator --no-codesign 2>&1 | tail -5
```
Expected: build succeeds with the `post_install` block deleted in Task 5.

- [ ] **Step 6: Run the completeness grep**

Every module-path workaround should now be gone. The only permitted `RovenueFFI`
matches outside `Generated/` are the artifact's own name and `sdk.yml`'s check
that the binding file was emitted.

```bash
grep -rn "RovenueFFI" packages/ examples/ .github/ \
  --include="*.podspec" --include="Podfile" --include="Package.swift" \
  --include="*.yml" --include="*.sh" --include="*.ts" \
  2>/dev/null | grep -v node_modules | grep -v "/Generated/"
```

Expected: only lines naming `RovenueFFI.xcframework` (build/verify/generate
scripts, `Package.swift`, `Rovenue.podspec`) and `sdk.yml`'s
`ls packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift`. Any
`SWIFT_INCLUDE_PATHS` or `PODS_ROOT` match is a failure.

- [ ] **Step 7: Record the results in the spec**

Append a short "Verified" line to the spec's Verification section stating which
of items 6 and 7 passed, with the date. These were the two claims flagged as
unsettled; leaving them unmarked after building is how an unverified claim
becomes folklore.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-05-apple-xcframework-distribution-design.md
git commit -m "test(sdk): verify RN and Flutter iOS builds with no include-path hack

The two claims pod lib lint could not settle, settled by real builds."
```

---

### Task 11: Documentation and roadmap

**Files:**
- Modify: `apps/docs/content/docs/platforms/ios-swift.mdx`
- Modify: `apps/docs/content/docs/platforms/react-native.mdx`
- Modify: `packages/sdk-flutter/*/pubspec.yaml` (four files — the `repository:` URL)
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: the distribution URL shape from Task 8
- Produces: documentation that matches what actually ships

- [ ] **Step 1: Fix the iOS install instructions**

`apps/docs/content/docs/platforms/ios-swift.mdx` currently advertises
`https://github.com/rovenue/sdk-swift.git` `from: "0.6.0"` — a third URL, and a
version that has never existed. Replace the SPM block with the generated
distribution repository and the current version, and state that macOS is
supported:

```swift
.package(url: "https://github.com/broverse/rovenue-swift.git", from: "0.16.0"),
```

Immediately below the SPM block, add exactly this sentence:

> Supported platforms: iOS 16.0+ (device and simulator) and macOS 12.0+.

Do the same in `react-native.mdx` wherever it states the iOS deployment target,
so the two pages cannot disagree.

- [ ] **Step 2: Fix the four Flutter `repository:` URLs**

Each of `rovenue_flutter`, `rovenue_flutter_platform_interface`,
`rovenue_flutter_ios` and `rovenue_flutter_android` declares
`repository: https://github.com/rovenue/rovenue`, which does not resolve.
Change all four to `https://github.com/broverse/rovenue`.

- [ ] **Step 3: Assert no stale URL remains**

Run: `grep -rn "github.com/rovenue/" --include="*.mdx" --include="*.yaml" --include="*.podspec" --include="*.swift" apps/ packages/ | grep -v node_modules`
Expected: no output.

- [ ] **Step 4: Update `ROADMAP.md` §7**

Mark closed, with what actually shipped:

```markdown
- [x] Fix release blockers (shipped 2026-09-05) — the Rust half was stale: fmt,
      clippy and the workspace tests were already green. The real blocker was
      the vendored `librovenue_ffi.a`, which `otool` reports as an iOS
      *simulator* slice despite the podspec documenting it as arm64 device — a
      published pod would not have linked on device. Replaced by
      `RovenueFFI.xcframework` (iOS device / iOS simulator / macOS). The
      podspec sha256 stays a placeholder until the operator cuts the first
      release; `release-sdk.yml` pins it.
- [x] Make the RN iOS pod externally consumable (shipped 2026-09-05) — both
      `SWIFT_INCLUDE_PATHS` blocks are gone. They existed only to put
      sdk-swift's module map on the import path; `${PODS_ROOT}/../../../..`
      resolves to nothing in an npm install. The module map now ships inside
      the xcframework. The same workaround in the Flutter example's Podfile,
      whose comment called it unfixable from the podspec, is gone too.
- [x] Official macOS target in the Swift SDK (shipped 2026-09-05) — a macOS
      slice plus `:osx => '12.0'`; `pod lib lint --platforms=macos` and
      `swift test` both pass. tvOS / watchOS / visionOS remain open: those
      Rust targets are Tier 3 and need a nightly toolchain with `-Z build-std`,
      a second build pipeline rather than a fourth slice.
- [ ] tvOS / watchOS / visionOS targets in the Swift SDK (Tier 3 Rust targets)
```

Also note under §7 that nothing is published yet: Trunk, pub.dev, npm and
GitHub Releases were all empty as of 2026-09-05, so `0.16.0` is unconsumed and
the first release is still ahead.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs/platforms/ios-swift.mdx \
        apps/docs/content/docs/platforms/react-native.mdx \
        packages/sdk-flutter/*/pubspec.yaml ROADMAP.md
git commit -m "docs: correct the Swift install URL and close three §7 items

The iOS page advertised github.com/rovenue/sdk-swift at 0.6.0 — a third
repository URL, and a version that never existed. Four Flutter pubspecs
pointed at github.com/rovenue/rovenue, which does not resolve."
```

---

## Operator steps (not part of implementation)

These need credentials the implementation does not have. After Task 11:

1. Create the distribution repository `broverse/rovenue-swift` (or decide the
   canonical org and change `repoSlug` in `packages/sdk-swift/release.config.json` first — one line).
2. Add a `SWIFT_DIST_REPO_TOKEN` secret with push access to it.
3. `pod trunk register <email> '<name>'` once, then store `COCOAPODS_TRUNK_TOKEN`.
4. Confirm `release-sdk.yml`'s `publish-swift` job can push to the monorepo —
   the sha256 pin step commits and pushes, so the job needs
   `permissions: contents: write` and a checkout on a branch
   (`actions/checkout@v4` with `ref: ${{ github.ref_name }}`), not a detached
   HEAD. Add both if the workflow's existing permissions do not already cover it.
5. Run the `release-sdk.yml` workflow with `swift: true` to cut the first
   release. Only after it succeeds does `rovenue_flutter_ios` resolve its
   `Rovenue` dependency from Trunk.
6. **Close the last verification gap** (spec Verification item 9): from a scratch
   directory, create a package depending on the distribution repo by version and
   build it —

   ```bash
   swift package init --name SpmConsumerCheck
   # add: .package(url: "https://github.com/broverse/rovenue-swift.git", from: "0.16.0")
   swift build
   ```

   This is the only check that exercises the published `url` + `checksum` binary
   target, and it cannot run before the release exists. If it fails, the
   xcframework zip's shape or the pinned checksum is wrong — not the Swift
   sources.
