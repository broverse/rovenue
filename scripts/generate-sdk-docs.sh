#!/usr/bin/env bash
set -uo pipefail
# Note: deliberately no `-e` — every fallible command below is already
# guarded by an explicit `if ! ...; then` so a failure is handled (recorded
# in FAILED, or SKIPPED for a missing toolchain) rather than aborting the
# whole script before the other four generators get a chance to run.

# generate-sdk-docs.sh — per-SDK API reference generation (ROADMAP §11).
#
# Runs whatever doc toolchain is present on this machine for each of the six
# SDKs (core-rs/rustdoc, sdk-swift/DocC, sdk-kotlin/Dokka, sdk-rn/TypeDoc,
# sdk-flutter/dartdoc, sdk-web/TypeDoc) and a root orchestrator (this script,
# `pnpm docs:sdk-ref`). The contract, deliberately:
#
#   - A MISSING toolchain is a SKIP, not a failure — this script must still
#     exit 0 on a machine that only has some of the six installed.
#   - A PRESENT toolchain that fails to generate, or generates a suspiciously
#     empty archive, is a hard FAILURE — silently accepting an empty output
#     directory is exactly the bug this repo already shipped once (a
#     simulator slice labelled as a device slice, in code nothing ever
#     built). So every generator is verified on file COUNT, not exit code.
#
# Usage: ./scripts/generate-sdk-docs.sh [rustdoc|docc|dokka|typedoc|typedoc-web|dartdoc ...]
#   With no arguments, runs all six.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Load cargo env so this script works in fresh shells too (matches
# scripts/sdk-parity.sh).
if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

# Minimum file counts below which a generator's output is treated as
# "suspiciously empty" even though the tool exited 0. These are floors, not
# targets — set well below what a healthy run produces (see
# .superpowers/sdd/2026-09-06-docs-and-developer-experience/task-21-report.md
# for the actual counts measured when this script was written) so a small,
# legitimate shrink doesn't false-positive, while a near-empty archive still
# trips it.
MIN_FILES_RUSTDOC=50
MIN_FILES_DOCC=500
MIN_FILES_DOKKA=100
MIN_FILES_TYPEDOC=20
MIN_FILES_DARTDOC=50
# sdk-web's public surface is the smallest of the six (three thin entry
# points, no native purchase surface) — 35 files measured when this was
# written, well above a broken/near-empty run's handful of scaffold files.
MIN_FILES_TYPEDOC_WEB=15

FAILED=0
RAN=0
SKIPPED=0

count_files() {
    find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}

assert_min_files() {
    local label="$1" dir="$2" min="$3"
    if [ ! -d "$dir" ]; then
        echo "  ✗ $label: output directory $dir does not exist" >&2
        return 1
    fi
    local n
    n=$(count_files "$dir")
    if [ "$n" -lt "$min" ]; then
        echo "  ✗ $label: only $n files generated in $dir (expected >= $min) — treating as a failed/empty archive" >&2
        return 1
    fi
    echo "  ✓ $label: $n files generated in $dir"
    return 0
}

run_rustdoc() {
    echo "→ rustdoc (core-rs)"
    if ! command -v cargo >/dev/null 2>&1; then
        echo "  ⊘ skipping: cargo not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    rm -rf "$ROOT/target/doc"
    if ! cargo doc --no-deps -p librovenue >/tmp/rovenue-rustdoc.log 2>&1; then
        echo "  ✗ cargo doc failed:" >&2
        tail -40 /tmp/rovenue-rustdoc.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "rustdoc" "$ROOT/target/doc" "$MIN_FILES_RUSTDOC"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

run_docc() {
    echo "→ DocC (sdk-swift)"
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "  ⊘ skipping: DocC only runs on macOS"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    if ! command -v xcodebuild >/dev/null 2>&1 || ! command -v swift >/dev/null 2>&1; then
        echo "  ⊘ skipping: Xcode / swift toolchain not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    local SWIFT_DIR="$ROOT/packages/sdk-swift"

    if [ ! -d "$SWIFT_DIR/RovenueFFI.xcframework" ]; then
        echo "  → RovenueFFI.xcframework missing, building it first"
        if ! "$SWIFT_DIR/scripts/build-xcframework.sh" >/tmp/rovenue-xcframework.log 2>&1; then
            echo "  ✗ build-xcframework.sh failed:" >&2
            tail -40 /tmp/rovenue-xcframework.log >&2
            FAILED=$((FAILED + 1))
            return 1
        fi
    fi

    local archive_out="$SWIFT_DIR/.build/docc-archive"
    rm -rf "$archive_out"
    if ! (cd "$SWIFT_DIR" && swift package --disable-sandbox generate-documentation \
        --target Rovenue --output-path "$archive_out" \
        >/tmp/rovenue-docc.log 2>&1); then
        echo "  ✗ swift package generate-documentation failed:" >&2
        tail -60 /tmp/rovenue-docc.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "DocC" "$archive_out" "$MIN_FILES_DOCC"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

run_dokka() {
    echo "→ Dokka (sdk-kotlin)"
    if ! command -v java >/dev/null 2>&1; then
        echo "  ⊘ skipping: java (JDK) not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    local KOTLIN_DIR="$ROOT/packages/sdk-kotlin"
    local dokka_out="$KOTLIN_DIR/build/dokka/html"
    rm -rf "$dokka_out"
    if ! (cd "$KOTLIN_DIR" && ./gradlew dokkaHtml --no-daemon >/tmp/rovenue-dokka.log 2>&1); then
        echo "  ✗ ./gradlew dokkaHtml failed:" >&2
        tail -60 /tmp/rovenue-dokka.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "Dokka" "$dokka_out" "$MIN_FILES_DOKKA"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

run_typedoc() {
    echo "→ TypeDoc (sdk-rn)"
    if ! command -v node >/dev/null 2>&1; then
        echo "  ⊘ skipping: node not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    local RN_DIR="$ROOT/packages/sdk-rn"
    local td_out="$RN_DIR/docs/api"
    rm -rf "$td_out"
    if ! (cd "$RN_DIR" && npx typedoc >/tmp/rovenue-typedoc.log 2>&1); then
        echo "  ✗ typedoc failed:" >&2
        tail -60 /tmp/rovenue-typedoc.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "TypeDoc" "$td_out" "$MIN_FILES_TYPEDOC"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

run_dartdoc() {
    echo "→ dartdoc (sdk-flutter)"
    if ! command -v dart >/dev/null 2>&1; then
        echo "  ⊘ skipping: dart not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    local FLUTTER_PKG_DIR="$ROOT/packages/sdk-flutter/rovenue_flutter"
    local dd_out="$FLUTTER_PKG_DIR/doc/api"
    rm -rf "$dd_out"
    if [ ! -d "$FLUTTER_PKG_DIR/.dart_tool" ]; then
        if ! (cd "$FLUTTER_PKG_DIR" && dart pub get >/tmp/rovenue-dartdoc-pubget.log 2>&1); then
            echo "  ✗ dart pub get failed:" >&2
            tail -40 /tmp/rovenue-dartdoc-pubget.log >&2
            FAILED=$((FAILED + 1))
            return 1
        fi
    fi
    if ! (cd "$FLUTTER_PKG_DIR" && dart doc . >/tmp/rovenue-dartdoc.log 2>&1); then
        echo "  ✗ dart doc failed:" >&2
        tail -60 /tmp/rovenue-dartdoc.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "dartdoc" "$dd_out" "$MIN_FILES_DARTDOC"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

run_typedoc_web() {
    echo "→ TypeDoc (sdk-web)"
    if ! command -v node >/dev/null 2>&1; then
        echo "  ⊘ skipping: node not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    RAN=$((RAN + 1))
    local WEB_DIR="$ROOT/packages/sdk-web"
    local td_out="$WEB_DIR/docs/api"
    rm -rf "$td_out"
    if ! (cd "$WEB_DIR" && npx typedoc >/tmp/rovenue-typedoc-web.log 2>&1); then
        echo "  ✗ typedoc failed:" >&2
        tail -60 /tmp/rovenue-typedoc-web.log >&2
        FAILED=$((FAILED + 1))
        return 1
    fi
    if ! assert_min_files "TypeDoc (sdk-web)" "$td_out" "$MIN_FILES_TYPEDOC_WEB"; then
        FAILED=$((FAILED + 1))
        return 1
    fi
}

TARGETS=("$@")
if [ "${#TARGETS[@]}" -eq 0 ]; then
    TARGETS=(rustdoc docc dokka typedoc typedoc-web dartdoc)
fi

for t in "${TARGETS[@]}"; do
    case "$t" in
        rustdoc) run_rustdoc ;;
        docc) run_docc ;;
        dokka) run_dokka ;;
        typedoc) run_typedoc ;;
        typedoc-web) run_typedoc_web ;;
        dartdoc) run_dartdoc ;;
        *)
            echo "unknown target: $t (expected one of rustdoc docc dokka typedoc typedoc-web dartdoc)" >&2
            exit 2
            ;;
    esac
done

echo
echo "── summary ────────────────────────────────────────────────"
echo "ran: $RAN   skipped (no toolchain): $SKIPPED   failed: $FAILED"

if [ "$FAILED" -gt 0 ]; then
    echo "✗ one or more present toolchains failed to generate a usable reference" >&2
    exit 1
fi

echo "✓ done"
