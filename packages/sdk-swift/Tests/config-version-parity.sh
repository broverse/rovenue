#!/usr/bin/env bash
set -euo pipefail

# Asserts that the Swift release config, the Cargo workspace, the podspec and
# the React Native bridge package all state the same version. Run in CI; a
# mismatch means a release would ship a podspec pointing at an artifact built
# from different sources, or an RN bridge pod (Task 4) requesting a `Rovenue`
# pod version that was never published.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SWIFT_DIR/../.." && pwd)"

config_version=$(ruby -rjson -e "print JSON.parse(File.read('$SWIFT_DIR/release.config.json'))['version']")
cargo_version=$(grep -m1 '^version = ' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')
podspec_version=$(ruby -e "
  require 'cocoapods-core'
  print Pod::Specification.from_file('$SWIFT_DIR/Rovenue.podspec').version.to_s
")
sdk_rn_version=$(ruby -rjson -e "print JSON.parse(File.read('$ROOT/packages/sdk-rn/package.json'))['version']")

if [ "$config_version" != "$cargo_version" ] || [ "$config_version" != "$podspec_version" ] || [ "$config_version" != "$sdk_rn_version" ]; then
  echo "✗ version mismatch: release.config.json=$config_version Cargo.toml=$cargo_version Rovenue.podspec=$podspec_version sdk-rn/package.json=$sdk_rn_version" >&2
  exit 1
fi

echo "✓ version $config_version consistent across release.config.json, Cargo.toml, Rovenue.podspec and sdk-rn/package.json"
