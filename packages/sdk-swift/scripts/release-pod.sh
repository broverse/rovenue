#!/usr/bin/env bash
set -euo pipefail

# release-pod.sh — orchestrates a CocoaPods Trunk-ready release of the
# Rovenue pod. Does NOT execute `pod trunk push` — prints the command for
# the operator to run manually.
#
# Usage:
#   ./packages/sdk-swift/scripts/release-pod.sh [--dry-run] [--skip-upload]
#
# Flags:
#   --dry-run      build + zip + sha only; no upload, no patch, no lint, no echo
#   --skip-upload  build + zip + sha + patch + lint + echo; skip the GH upload
#                  (use when the release already exists from a prior partial run)

DRY_RUN=0
SKIP_UPLOAD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --skip-upload) SKIP_UPLOAD=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SWIFT_DIR="$ROOT/packages/sdk-swift"
PODSPEC="$SWIFT_DIR/Rovenue.podspec"
BUILD_DIR="$SWIFT_DIR/build"

# -------- Preflight --------
echo "→ preflight"

for tool in pod shasum zip; do
  command -v "$tool" >/dev/null 2>&1 \
    || { echo "✗ missing required tool: $tool" >&2; exit 1; }
done

if [ "$DRY_RUN" -eq 0 ] && [ "$SKIP_UPLOAD" -eq 0 ]; then
  command -v gh >/dev/null 2>&1 \
    || { echo "✗ missing gh CLI (required unless --dry-run or --skip-upload)" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 \
    || { echo "✗ gh CLI not authenticated — run 'gh auth login'" >&2; exit 1; }
fi

if [ "$DRY_RUN" -eq 0 ]; then
  # Working tree must be clean for an honest release.
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "✗ working tree not clean — commit or stash before releasing" >&2
    exit 1
  fi
  BRANCH=$(git -C "$ROOT" branch --show-current)
  if [ "$BRANCH" != "main" ]; then
    echo "⚠  on branch '$BRANCH' (expected 'main') — continuing anyway"
  fi
fi

# -------- Read version --------
VERSION=$(grep -E "^\s*s\.version\s+=" "$PODSPEC" \
  | sed -E "s/.*'([^']+)'.*/\1/" | head -n 1)
test -n "$VERSION" || { echo "✗ could not parse version from $PODSPEC" >&2; exit 1; }
echo "→ Rovenue.podspec version: $VERSION"

ZIP_NAME="Rovenue-$VERSION.zip"
STAGE_DIR="$BUILD_DIR/Rovenue-$VERSION"
ZIP_PATH="$BUILD_DIR/$ZIP_NAME"
RELEASE_TAG="sdk-swift-v$VERSION"

# -------- Build --------
echo "→ build host bindings (UniFFI sources)"
"$ROOT/packages/core-rs/scripts/build-bindings.sh" >/dev/null

echo "→ build iOS staticlib"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/Sources/Rovenue"
"$SWIFT_DIR/scripts/build-ios-static.sh" "$STAGE_DIR/Sources/Rovenue" >/dev/null

# -------- Stage --------
echo "→ stage Sources + podspec into $STAGE_DIR"
cp -R "$SWIFT_DIR/Sources/Rovenue/." "$STAGE_DIR/Sources/Rovenue/"
# The staticlib we just built goes alongside the Swift sources;
# `cp -R` above would have overwritten it with whatever's in the
# source tree (typically nothing). Re-place it.
"$SWIFT_DIR/scripts/build-ios-static.sh" "$STAGE_DIR/Sources/Rovenue" >/dev/null

cp "$PODSPEC" "$STAGE_DIR/Rovenue.podspec"

# -------- Zip --------
echo "→ zip → $ZIP_PATH"
rm -f "$ZIP_PATH"
( cd "$BUILD_DIR" && zip -rq "$ZIP_NAME" "Rovenue-$VERSION" )

# -------- SHA256 --------
SHA=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
echo "→ sha256: $SHA"

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "✓ DRY RUN complete. Artifacts in $BUILD_DIR/"
  echo "  zip:    $ZIP_PATH"
  echo "  sha256: $SHA"
  exit 0
fi

# -------- Upload --------
if [ "$SKIP_UPLOAD" -eq 0 ]; then
  echo "→ gh release create $RELEASE_TAG"
  if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
    echo "✗ release $RELEASE_TAG already exists — bump version in $PODSPEC or use --skip-upload" >&2
    exit 1
  fi
  gh release create "$RELEASE_TAG" "$ZIP_PATH" \
    --title "sdk-swift v$VERSION" \
    --notes "Rovenue Swift façade ($VERSION). See packages/sdk-swift/CHANGELOG.md (if present)."
else
  echo "→ --skip-upload: assume release $RELEASE_TAG already exists"
fi

# -------- Patch podspec --------
echo "→ patch sha256 into $PODSPEC"
# Replace the 64-char hex placeholder with the real sha. Use sed -i'' for
# portability (BSD sed on macOS requires the empty backup arg form).
sed -i'' -E "s/:sha256 => '[0-9a-fA-F]{64}'/:sha256 => '$SHA'/" "$PODSPEC"
git -C "$ROOT" add "$PODSPEC"
git -C "$ROOT" commit -m "chore(sdk-swift): pin Rovenue podspec sha256 for v$VERSION"

# -------- Lint --------
echo "→ pod spec lint"
if ! pod spec lint "$PODSPEC" --allow-warnings --skip-tests --platforms=ios; then
  echo "✗ lint failed — reverting sha pin commit"
  git -C "$ROOT" reset --hard HEAD~1
  exit 1
fi

# -------- Echo Trunk push --------
echo
echo "──────────────────────────────────────────────────────────────"
echo "✓ Release ready. To publish to CocoaPods Trunk, run:"
echo
echo "    pod trunk push $PODSPEC --allow-warnings"
echo
echo "Prereq: pod trunk register <your-email> '<your-name>' (one-time)"
echo "──────────────────────────────────────────────────────────────"
