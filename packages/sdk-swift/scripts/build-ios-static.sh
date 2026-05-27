#!/usr/bin/env bash
set -euo pipefail

# build-ios-static.sh — cross-compile librovenue as a static library for
# iOS arm64 devices. Output: <OUT_DIR>/librovenue.a
#
# Usage:
#   ./packages/sdk-swift/scripts/build-ios-static.sh <OUT_DIR>
#
# Single-arch (aarch64-apple-ios) only. Apple Silicon simulators
# (aarch64-apple-ios-sim) and Intel simulators (x86_64-apple-ios) need
# an XCFramework — Open Question 1 in the M7.1 spec.

if [ $# -ne 1 ]; then
  echo "usage: $0 <OUT_DIR>" >&2
  exit 2
fi

OUT_DIR="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="$ROOT/packages/core-rs"
TARGET="aarch64-apple-ios"

# rustup is required for `target add`. Bail clearly if absent.
if ! command -v rustup >/dev/null 2>&1; then
  echo "✗ rustup not found on PATH — install via https://rustup.rs" >&2
  exit 1
fi

# Idempotent: rustup target add is a no-op if already installed.
echo "→ ensure $TARGET toolchain"
rustup target add "$TARGET" >/dev/null

echo "→ cargo build --release --target $TARGET -p librovenue"
cargo build --release \
  --manifest-path "$CORE_DIR/Cargo.toml" \
  --target "$TARGET" \
  -p librovenue

SRC_LIB="$ROOT/target/$TARGET/release/librovenue.a"
test -f "$SRC_LIB" || {
  echo "✗ expected $SRC_LIB after build — check Cargo.toml crate-type includes staticlib" >&2
  exit 1
}

mkdir -p "$OUT_DIR"
cp "$SRC_LIB" "$OUT_DIR/librovenue.a"

# Sanity: file should be a Mach-O 64-bit ar archive for arm64.
if command -v file >/dev/null 2>&1; then
  file "$OUT_DIR/librovenue.a" | sed 's/^/  /'
fi

echo "✓ librovenue.a → $OUT_DIR/librovenue.a"
