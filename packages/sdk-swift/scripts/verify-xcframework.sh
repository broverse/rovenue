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

# Numeric (not lexical) version compare: "9.0" must not sort above "14.0".
# Missing components compare as 0, so "16" == "16.0". Echoes nothing; use in
# an `if` (never bare, so a false result doesn't trip `set -e`).
version_gt() {
  local a="${1:-0}" b="${2:-0}"
  local IFS=.
  local -a av=($a) bv=($b)
  local n=${#av[@]}
  [ "${#bv[@]}" -gt "$n" ] && n=${#bv[@]}
  local i ai bi
  for ((i = 0; i < n; i++)); do
    ai="${av[i]:-0}"
    bi="${bv[i]:-0}"
    if ((10#$ai > 10#$bi)); then return 0; fi
    if ((10#$ai < 10#$bi)); then return 1; fi
  done
  return 1
}

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

  # rustc's own precompiled std for some targets bakes in a minos *older* than
  # what we build with (harmless — an older floor links and warns about
  # nothing) — so the real defect to catch is an object *newer* than our
  # deployment target (that's what produced hundreds of "object file was
  # built for newer ... version" linker warnings before). Assert the ceiling,
  # not equality.
  max_minos="0"
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if version_gt "$v" "$max_minos"; then
      max_minos="$v"
    fi
  done < <(otool -l "$lib" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; f=0}' | sort -u)

  if version_gt "$max_minos" "$want_minos"; then
    fail "$dir: minimum OS is '$max_minos', which exceeds the configured deployment target '$want_minos' — export the *_DEPLOYMENT_TARGET vars before cargo build"
  fi

  test -f "$XCF/$dir/Headers/RovenueFFI.h" || fail "$dir: Headers/RovenueFFI.h missing"
  test -f "$XCF/$dir/Headers/module.modulemap" || fail "$dir: Headers/module.modulemap missing"
done

echo "✓ $XCF — 3 slices, matching basenames, correct platforms and deployment targets"
