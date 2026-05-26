#!/usr/bin/env bash
set -euo pipefail

# Build librovenue for the host triple and generate Swift + Kotlin bindings.
# Run from repo root: ./packages/core-rs/scripts/build-bindings.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="$ROOT/packages/core-rs"
UDL="$CORE_DIR/src/librovenue.udl"
CONFIG="$CORE_DIR/uniffi.toml"
SWIFT_OUT="$ROOT/packages/sdk-swift/Sources/Rovenue/Generated"
KOTLIN_OUT="$ROOT/packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated"

echo "→ cargo build (release, host triple)"
cargo build --release --manifest-path "$CORE_DIR/Cargo.toml" -p librovenue
cargo build --release --manifest-path "$ROOT/packages/core-rs/bindgen/Cargo.toml" -p rovenue-uniffi-bindgen

case "$(uname -s)" in
    Darwin) DYLIB="librovenue.dylib" ;;
    Linux)  DYLIB="librovenue.so" ;;
    *)      echo "unsupported host"; exit 1 ;;
esac
DYLIB_PATH="$ROOT/target/release/$DYLIB"
test -f "$DYLIB_PATH" || { echo "missing $DYLIB_PATH"; exit 1; }

BINDGEN="$ROOT/target/release/rovenue-uniffi-bindgen"
test -x "$BINDGEN" || { echo "missing $BINDGEN"; exit 1; }

echo "→ generate Swift bindings → $SWIFT_OUT"
mkdir -p "$SWIFT_OUT"
"$BINDGEN" generate "$UDL" \
    --language swift \
    --out-dir "$SWIFT_OUT" \
    --config "$CONFIG"

echo "→ generate Kotlin bindings → $KOTLIN_OUT"
mkdir -p "$KOTLIN_OUT"
"$BINDGEN" generate "$UDL" \
    --language kotlin \
    --out-dir "$KOTLIN_OUT" \
    --config "$CONFIG"

echo "✓ bindings generated"
echo "  Swift output:"
ls -1 "$SWIFT_OUT" | sed 's/^/    /'
echo "  Kotlin output:"
ls -1 "$KOTLIN_OUT" | sed 's/^/    /'
