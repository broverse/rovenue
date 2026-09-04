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

# -------- Preflight --------
# ruby must be checked before the first cfg() call below, since cfg() shells
# out to it — otherwise a machine without ruby gets a raw LoadError instead of
# this script's own message.
echo "→ preflight"
for tool in ruby pod shasum zip swift; do
  command -v "$tool" >/dev/null 2>&1 \
    || { echo "✗ missing required tool: $tool" >&2; exit 1; }
done

cfg() { ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['$1']"; }

POD_NAME="$(cfg podName)"
VERSION="$(cfg version)"
XCF_NAME="$(cfg xcframeworkName)"

"$SWIFT_DIR/Tests/config-version-parity.sh"

STAGE_DIR="$BUILD_DIR/$POD_NAME-$VERSION"
POD_ZIP="$BUILD_DIR/$POD_NAME-$VERSION.zip"
XCF_ZIP="$BUILD_DIR/${XCF_NAME%.xcframework}-$VERSION.xcframework.zip"

# -------- Build --------
# Build into $SWIFT_DIR (build-xcframework.sh's default with no OUT_DIR arg),
# i.e. beside the podspec — never straight into the ephemeral $STAGE_DIR.
# pod lib lint resolves `s.vendored_frameworks` relative to the podspec's own
# directory, not the staging directory, so the lint step below needs the
# xcframework to actually land at $SWIFT_DIR/$XCF_NAME. One build then serves
# both the lint and the pod zip via the copy in the staging step.
echo "→ build $XCF_NAME"
"$HERE/build-xcframework.sh" >/dev/null

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# -------- Stage the CocoaPods artifact --------
echo "→ stage Sources + xcframework + podspec into $STAGE_DIR"
mkdir -p "$STAGE_DIR/Sources"
cp -R "$SWIFT_DIR/Sources/Rovenue" "$STAGE_DIR/Sources/Rovenue"
cp -R "$SWIFT_DIR/$XCF_NAME" "$STAGE_DIR/"
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
