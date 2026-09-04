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
