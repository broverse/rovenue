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

# Swift façade test exercises sdkVersion() against the dylib.
echo "→ Swift test"
(
    cd packages/sdk-swift
    DYLD_LIBRARY_PATH="$ROOT/target/release" swift test 2>&1
) | tee /tmp/rovenue-swift-parity.log >/dev/null
grep -E "Test Suite 'All tests' passed" /tmp/rovenue-swift-parity.log >/dev/null
echo "  ✓ Swift façade tests passed"

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
echo "  ✓ RN stub tests passed"

echo
echo "✓ Parity: all available codepaths agree on version $RUST_VER"
