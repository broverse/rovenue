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

# rustc's own precompiled std/core/alloc for the two Apple-Silicon-hosted targets
# (aarch64-apple-ios-sim, aarch64-apple-darwin) ships with a fixed LC_BUILD_VERSION
# minos (14.0 / 11.0) baked in at Rust's own release time — set BEFORE we ever
# invoke cargo, so IPHONEOS_DEPLOYMENT_TARGET/MACOSX_DEPLOYMENT_TARGET above cannot
# touch it. Only the code compiled locally by this build (librovenue and its
# dependency graph) honors those vars. Left alone, the resulting static lib
# contains two different minos values for the same platform — precisely what
# verify-xcframework.sh checks for. (aarch64-apple-ios and both x86_64 targets are
# unaffected: their precompiled std uses the older LC_VERSION_MIN_* command, which
# carries no such conflict with the modern LC_BUILD_VERSION objects we compile.)
#
# Fix in place: rewrite the minos field of every LC_BUILD_VERSION load command for
# the matching platform, in every object inside the static lib, to the deployment
# target we built with. This only overwrites an existing 4-byte field — it never
# grows a load command — so it works on relocatable objects, where vtool (which
# operates only on final linked binaries) refuses with "not enough space to hold
# load commands".
normalize_minos() {
  local archive="$1" platform_id="$2" major="$3" minor="$4"
  local work; work="$(mktemp -d)"
  ar -t "$archive" >"$work/.members"
  ( cd "$work" && ar -x "$archive" )
  while IFS= read -r member; do
    case "$member" in __.SYMDEF*) continue ;; esac
    test -f "$work/$member" || continue
    ruby -e '
      path, platform_id, major, minor = ARGV[0], ARGV[1].to_i, ARGV[2].to_i, ARGV[3].to_i
      data = File.binread(path)
      exit 0 if data.bytesize < 32
      exit 0 unless data[0,4].unpack1("V") == 0xfeedfacf # MH_MAGIC_64
      ncmds = data[16,4].unpack1("V")
      off = 32
      changed = false
      ncmds.times do
        break if off + 8 > data.bytesize
        cmd, cmdsize = data[off, 8].unpack("VV")
        if cmd == 0x32 # LC_BUILD_VERSION
          platform = data[off + 8, 4].unpack1("V")
          if platform == platform_id
            data[off + 12, 4] = [(major << 16) | (minor << 8)].pack("V")
            changed = true
          end
        end
        off += cmdsize
      end
      File.binwrite(path, data) if changed
    ' "$work/$member" "$platform_id" "$major" "$minor"
  done <"$work/.members"
  ( cd "$work" && grep -v '^__.SYMDEF' .members | tr '\n' '\0' | xargs -0 ar -rc "$archive.normalized" )
  ranlib "$archive.normalized"
  mv "$archive.normalized" "$archive"
  rm -rf "$work"
}

# Rust target → Mach-O platform id → deployment-target config key.
# Mach-O platform ids: 1 = macOS, 2 = iOS, 7 = iOS Simulator.
TARGET_PLATFORM_TABLE="aarch64-apple-ios:2:$IOS_MIN aarch64-apple-ios-sim:7:$IOS_MIN x86_64-apple-ios:7:$IOS_MIN aarch64-apple-darwin:1:$MACOS_MIN x86_64-apple-darwin:1:$MACOS_MIN"

for entry in $TARGET_PLATFORM_TABLE; do
  t="${entry%%:*}"
  rest="${entry#*:}"
  platform_id="${rest%%:*}"
  minos="${rest#*:}"

  echo "→ ensure toolchain $t"
  rustup target add "$t" >/dev/null
  echo "→ cargo build --release --target $t"
  nice -n 19 cargo build --release \
    --manifest-path "$ROOT/packages/core-rs/Cargo.toml" \
    --target "$t" -p librovenue

  normalize_minos "$ROOT/target/$t/release/librovenue.a" "$platform_id" "${minos%%.*}" "${minos#*.}"
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
