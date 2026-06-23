#!/usr/bin/env bash
set -euo pipefail

# Cross-compile librovenue for the Android ABIs and stage the result as the
# Kotlin façade's jniLibs, so the published AAR (dev.rovenue:sdk) actually
# carries the native core on-device. Run from repo root:
#   ./packages/core-rs/scripts/build-android.sh
#
# NAME RECONCILIATION (important): the cargo cdylib is `librovenue.so`
# (`[lib] name = "rovenue"`), but the generated UniFFI Kotlin binding hard-codes
# `findLibraryName()` -> "uniffi_librovenue", i.e. JNA loads
# `libuniffi_librovenue.so` at runtime. The desktop unit tests paper over this
# with `-Duniffi.component.librovenue.libraryOverride=rovenue`, but there is no
# such hook on a real device. So we RENAME each ABI's output to
# `libuniffi_librovenue.so` — then the hard-coded name resolves with no override.
#
# Requires: rustup Android targets, cargo-ndk, and an Android NDK. CI installs
# these; locally: `cargo install cargo-ndk` + Android Studio's NDK.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="$ROOT/packages/core-rs"
JNILIBS="$ROOT/packages/sdk-kotlin/src/main/jniLibs"

# Android ABI <-> rust target. Override ABIS to subset (e.g. local dev):
#   ABIS="arm64-v8a x86_64" ./packages/core-rs/scripts/build-android.sh
# (A case function rather than `declare -A` so this runs on macOS's bash 3.2.)
ABIS="${ABIS:-arm64-v8a armeabi-v7a x86_64 x86}"
abi_to_target() {
    case "$1" in
        arm64-v8a)   echo aarch64-linux-android ;;
        armeabi-v7a) echo armv7-linux-androideabi ;;
        x86_64)      echo x86_64-linux-android ;;
        x86)         echo i686-linux-android ;;
        *)           echo "unknown ABI '$1'" >&2; return 1 ;;
    esac
}

# The cdylib basename cargo emits (from [lib] name = "rovenue") and the name the
# UniFFI binding expects to load at runtime.
CDYLIB_NAME="librovenue.so"
RUNTIME_NAME="libuniffi_librovenue.so"

command -v cargo-ndk >/dev/null 2>&1 || {
    echo "✗ cargo-ndk not found. Install it with: cargo install cargo-ndk" >&2
    exit 1
}

# Resolve an NDK if ANDROID_NDK_HOME isn't already exported (cargo-ndk reads it).
# GitHub runners export ANDROID_NDK_LATEST_HOME; fall back to the SDK's ndk dir.
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
    if [[ -n "${ANDROID_NDK_LATEST_HOME:-}" ]]; then
        ANDROID_NDK_HOME="$ANDROID_NDK_LATEST_HOME"
    else
        sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
        if [[ -d "$sdk/ndk" ]]; then
            # latest installed NDK
            ANDROID_NDK_HOME="$(/bin/ls -d "$sdk"/ndk/* | sort -V | tail -1)"
        fi
    fi
    export ANDROID_NDK_HOME
fi
[[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]] || {
    echo "✗ No Android NDK found. Set ANDROID_NDK_HOME or install via Android Studio." >&2
    exit 1
}
echo "→ NDK: $ANDROID_NDK_HOME"

# Ensure the rust targets for the requested ABIs are installed.
for abi in $ABIS; do
    target="$(abi_to_target "$abi")"
    rustup target list --installed 2>/dev/null | grep -qx "$target" || {
        echo "→ installing rust target $target"
        rustup target add "$target"
    }
done

# Build all requested ABIs in one cargo-ndk invocation; -o lays them out as
# jniLibs/<abi>/librovenue.so.
ndk_targets=()
for abi in $ABIS; do ndk_targets+=("-t" "$abi"); done

echo "→ cargo-ndk build (release) for: $ABIS"
# Clean stale .so (don't rm -rf — that would nuke the tracked .gitkeep).
mkdir -p "$JNILIBS"
find "$JNILIBS" -name '*.so' -delete 2>/dev/null || true
cargo ndk "${ndk_targets[@]}" -o "$JNILIBS" \
    build --release -p librovenue --manifest-path "$CORE_DIR/Cargo.toml"

# Rename each ABI's cdylib to the name the UniFFI binding loads.
for abi in $ABIS; do
    src="$JNILIBS/$abi/$CDYLIB_NAME"
    dst="$JNILIBS/$abi/$RUNTIME_NAME"
    test -f "$src" || { echo "✗ missing $src after build" >&2; exit 1; }
    mv -f "$src" "$dst"
done

echo "✓ Android jniLibs staged → $JNILIBS"
find "$JNILIBS" -name '*.so' | sed "s#$JNILIBS/#    #"
