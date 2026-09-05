#!/usr/bin/env bash
set -euo pipefail

# Asserts that every hand-maintained statement of the Apple-side SDK version
# agrees with packages/sdk-swift/release.config.json:
#
#   Cargo.toml                          the Rust core the façades wrap
#   Rovenue.podspec                     s.version (read from the config)
#   packages/sdk-rn/package.json        the RN bridge pod's `Rovenue` version
#   rovenue_flutter_ios.podspec         s.version
#   rovenue_flutter_ios.podspec         s.dependency 'Rovenue', '<version>'
#
# The last two are the pair no other check covers: version.test.ts reads the
# Flutter *pubspecs*, never this podspec, so a bump could land everywhere both
# checks look and still ship `rovenue_flutter_ios <new>` demanding
# `Rovenue <old>` from Trunk — the previous Swift façade linked against the new
# Pigeon interface, or a resolution failure.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SWIFT_DIR/../.." && pwd)"

CONFIG="$SWIFT_DIR/release.config.json"
SWIFT_PODSPEC="$SWIFT_DIR/Rovenue.podspec"
FLUTTER_IOS_PODSPEC="$ROOT/packages/sdk-flutter/rovenue_flutter_ios/ios/rovenue_flutter_ios.podspec"

# -------- Preflight --------
# Both podspecs are *evaluated*, not regex-matched: Rovenue.podspec computes
# s.version from release.config.json, so a regex over its text would only ever
# re-read the file this script is comparing against. That makes cocoapods-core
# a hard dependency of this script — and this script is the FIRST step of
# sdk.yml's `swift` job, which does not install CocoaPods. Say so plainly
# instead of failing with a bare LoadError on a check unrelated to the job.
command -v ruby >/dev/null 2>&1 || { echo "✗ ruby not found — required to evaluate the podspecs" >&2; exit 1; }
ruby -rcocoapods-core -e '' >/dev/null 2>&1 || {
  echo "✗ the 'cocoapods-core' rubygem is not loadable by $(command -v ruby)" >&2
  echo "  install it with:  gem install cocoapods-core     (or the full 'cocoapods' gem)" >&2
  echo "  This check evaluates the podspecs rather than pattern-matching them," >&2
  echo "  because Rovenue.podspec derives its version from release.config.json." >&2
  exit 1
}

config_version=$(ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['version']")
pod_name=$(ruby -rjson -e "print JSON.parse(File.read('$CONFIG'))['podName']")

cargo_version=$(grep -m1 '^version = ' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')
sdk_rn_version=$(ruby -rjson -e "print JSON.parse(File.read('$ROOT/packages/sdk-rn/package.json'))['version']")

# One ruby process emits all three podspec-derived values, in order:
#   1. Rovenue.podspec              s.version
#   2. rovenue_flutter_ios.podspec  s.version
#   3. rovenue_flutter_ios.podspec  the exact version it pins `Rovenue` at
podspec_values=$(ruby - "$SWIFT_PODSPEC" "$FLUTTER_IOS_PODSPEC" "$pod_name" <<'RUBY'
require 'cocoapods-core'

swift_podspec_path, flutter_ios_podspec_path, pod_name = ARGV

swift = Pod::Specification.from_file(swift_podspec_path)
flutter_ios = Pod::Specification.from_file(flutter_ios_podspec_path)

dep = flutter_ios.dependencies.find { |d| d.name == pod_name }
if dep.nil?
  warn "✗ #{flutter_ios_podspec_path} declares no `s.dependency '#{pod_name}'` — " \
       "the Flutter iOS package wraps that pod and must pin it"
  exit 1
end

exact = dep.requirement.requirements.find { |operator, _| operator == '=' }
if exact.nil?
  warn "✗ #{flutter_ios_podspec_path} pins #{pod_name} as '#{dep.requirement}' — it must be " \
       "an exact version: s.dependency '#{pod_name}', '<version>'"
  exit 1
end

puts swift.version.to_s
puts flutter_ios.version.to_s
puts exact[1].to_s
RUBY
)

swift_podspec_version=$(printf '%s\n' "$podspec_values" | sed -n 1p)
flutter_ios_version=$(printf '%s\n' "$podspec_values" | sed -n 2p)
flutter_ios_rovenue_dep=$(printf '%s\n' "$podspec_values" | sed -n 3p)

# -------- Compare --------
mismatch=0
expect() { # <label> <value>
  if [ "$2" != "$config_version" ]; then
    echo "✗ $1 = ${2:-<empty>} (expected $config_version)" >&2
    mismatch=1
  fi
}

expect "Cargo.toml version"                            "$cargo_version"
expect "Rovenue.podspec s.version"                     "$swift_podspec_version"
expect "sdk-rn/package.json version"                   "$sdk_rn_version"
expect "rovenue_flutter_ios.podspec s.version"         "$flutter_ios_version"
expect "rovenue_flutter_ios.podspec $pod_name dependency" "$flutter_ios_rovenue_dep"

if [ "$mismatch" -ne 0 ]; then
  echo "✗ version mismatch against release.config.json ($config_version)" >&2
  exit 1
fi

echo "✓ version $config_version consistent across release.config.json, Cargo.toml, Rovenue.podspec, sdk-rn/package.json and rovenue_flutter_ios.podspec (s.version + $pod_name dependency)"
