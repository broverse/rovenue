#!/usr/bin/env bash
#
# deploy/backup/backup.sh — encrypted backup of Postgres, ClickHouse and the
# paywall-asset bucket.
#
# ClickHouse is backed up, not treated as derived data: outbox rows are
# deleted after dispatch, so the event history that produced the analytics
# tables no longer exists in Postgres once dispatch has happened. A lost
# ClickHouse means permanently lost analytics history, not a rebuild.
#
# Every artifact — Postgres, ClickHouse and the paywall-asset bucket — is
# age-encrypted by default. A Rovenue Postgres dump holds subscriber records,
# device identifiers, email addresses and purchase history, in a product that
# ships GDPR/KVKK export/anonymise tooling. Leaving an unencrypted copy of the
# entire subject database on a disk would undo that at the first step.
# --allow-plaintext exists because a local dump piped straight into a restore
# is a legitimate thing to do, but it is never the default.
#
# The `age` recipient (BACKUP_AGE_RECIPIENT) MUST be a different key from
# ENCRYPTION_KEY. ENCRYPTION_KEY is the application's data key (AES-256-GCM
# for stored store credentials) — reusing it as the backup key means a single
# compromised key loses both the live application data AND every backup ever
# taken with it. Generate a dedicated keypair for backups: `age-keygen`.
#
# The manifest records the SHA-256 FINGERPRINT of ENCRYPTION_KEY, never the
# key itself. That is what lets restore.sh (a later task) refuse to run
# against an environment whose ENCRYPTION_KEY does not match the one this
# backup was taken under — a restore with the WRONG key is worse than one
# with a lost key, because it succeeds, and the damage only surfaces the next
# time a receipt is verified.
#
# The paywall-asset bucket IS encrypted too, even though its objects are
# served publicly. deploy/minio/README.md documents why this matters: the
# bucket's anonymous policy is HAND-AUTHORED to grant s3:GetObject only,
# specifically because `mc anonymous set download` also grants
# s3:ListBucket — considered and rejected. An asset's security rests
# entirely on its unguessable cuid2 key; the live system deliberately
# refuses enumeration. A plaintext local mirror of the whole bucket hands
# over exactly the enumeration the running system refuses to give out, and
# a local file is far easier to leak (a support ticket, an off-site copy, a
# shared folder) than the encrypted database artifacts above. So `assets/`
# is tarred and age-encrypted as one `assets.tar.age`, the same as the
# other two artifacts — not per-object, which would multiply age
# invocations by the object count for no benefit.
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — every path fragment, filename, flag and manifest field name.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly ROOT_DIR
readonly PACKAGE_JSON_PATH="$ROOT_DIR/package.json"

# Backup layout — matches the contract restore.sh (next task) reads.
readonly MANIFEST_FILENAME="manifest.json"
readonly POSTGRES_DUMP_FILENAME="postgres.dump"
readonly CLICKHOUSE_OUT_SUBDIR="clickhouse"
readonly CLICKHOUSE_OUT_FILENAME="clickhouse.zip"
readonly ASSETS_ARCHIVE_FILENAME="assets.tar"
# Staging subdirectory (under STAGING_DIR, never under OUT_DIR) that `mc
# mirror` fills before it's tarred — never written to disk unencrypted at
# its final location.
readonly ASSETS_MIRROR_SUBDIR="assets-mirror"
# Per-object S3 metadata (Content-Type, Cache-Control, every x-amz-meta-*
# key — whatever AssetStore actually set at PutObject time, not a
# re-derivation of its policy) captured at backup time and re-applied at
# restore time via `mc cp --attr`. `mc mirror` moves object BYTES; it does
# not round-trip object metadata, so without this sidecar a restored asset
# silently loses its Cache-Control (and everything else) — see restore.sh's
# run_assets_restore for the read side of this contract. Named with a
# leading dot so it never collides with a real asset key (paywall asset
# keys are `<projectId>/<cuid2>.<ext>`, never dotfiles) and sorts first in
# a directory listing, which is irrelevant to correctness but makes it
# obvious in a manual `tar tf` inspection.
readonly ASSETS_METADATA_SIDECAR_FILENAME=".rovenue-asset-metadata.json"
readonly AGE_SUFFIX=".age"

# Postgres.
readonly PG_DUMP_BIN="pg_dump"
readonly PG_DUMP_FORMAT_FLAG="-Fc"
readonly PG_DUMP_NO_OWNER_FLAG="--no-owner"

# ClickHouse. CLICKHOUSE_BACKUP_USER is the schema-owner user — it must NOT
# be rovenue_reader, which runs under the readonly=2 profile
# (deploy/clickhouse/users.d/rovenue.xml) and cannot execute BACKUP at all.
readonly CLICKHOUSE_DATABASE_DEFAULT="rovenue"
readonly CLICKHOUSE_BACKUP_USER="rovenue"
readonly CLICKHOUSE_BACKUP_DISK_NAME="backups"
readonly CLICKHOUSE_BACKUP_NAME_PREFIX="rovenue"
readonly CLICKHOUSE_ARCHIVE_EXTENSION=".zip"
# Matches deploy/clickhouse/config.d/backup.xml's <backups> disk <path>. The
# disk lives inside the container's data volume (rovenue-clickhouse-data),
# not on the host, so the archive is `docker cp`'d out after BACKUP runs.
readonly CLICKHOUSE_CONTAINER_BACKUP_DIR="/var/lib/clickhouse/backups"
readonly CLICKHOUSE_COMPOSE_SERVICE="clickhouse"

# curl -w format for the BACKUP call below: appends a newline then the
# HTTP status code after the response body, so one request yields both.
# 2xx is the only success range — same convention
# verify-asset-headers.ts's REFUSAL_STATUS_MIN/MAX_EXCLUSIVE uses: name
# the bound rather than embed it in a regex.
readonly CURL_STATUS_SUFFIX_FORMAT='\n%{http_code}'
readonly HTTP_SUCCESS_STATUS_MIN=200
readonly HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE=300

# Object storage.
readonly MC_BIN="mc"
readonly JQ_BIN="jq"
readonly DEFAULT_MC_ALIAS="rovenue-backup"

# Encryption.
readonly AGE_BIN="age"

# What is deliberately not backed up, and why — printed AND recorded in the
# manifest's "skipped" field, not only documented.
readonly REDIS_SKIP_REASON="Redis (BullMQ queue state) is not backed up. Repeatable jobs re-arm themselves on worker start, but any DELAYED job pending at backup time is lost — reschedule it by hand after a restore if that matters."
readonly REDPANDA_SKIP_REASON="Redpanda (Kafka) is not backed up. Its topics hold in-flight events only: the durable record is the outbox_events row in Postgres before dispatch, and the ClickHouse tables it feeds after — both already covered above."

# ---------------------------------------------------------------------------
# Globals populated while the script runs.
# ---------------------------------------------------------------------------
OUT_DIR=""
ALLOW_PLAINTEXT=0
MC_ALIAS="$DEFAULT_MC_ALIAS"
STAGING_DIR=""
TIMESTAMP=""
ROVENUE_VERSION=""
ENCRYPTION_KEY_FINGERPRINT=""

POSTGRES_ARTIFACT=""
POSTGRES_ENCRYPTED="false"
POSTGRES_BYTES="0"

CLICKHOUSE_ARTIFACT=""
CLICKHOUSE_ENCRYPTED="false"
CLICKHOUSE_BYTES="0"

ASSETS_ARTIFACT=""
ASSETS_ENCRYPTED="false"
ASSETS_FILE_COUNT="0"
ASSETS_BYTES="0"

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
fail() {
  echo "backup.sh: $1" >&2
  exit 1
}

require_env() {
  local name="$1"
  local hint="$2"
  if [ -z "${!name:-}" ]; then
    fail "$name is required — $hint"
  fi
}

require_bin() {
  local bin="$1"
  local install_hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail "$bin is required and was not found on PATH. $install_hint"
  fi
}

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

human_size() {
  local bytes="$1"
  awk -v b="$bytes" 'BEGIN {
    split("B KB MB GB TB", u, " ")
    i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf "%.1f%s", b, u[i]
  }'
}

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

read_rovenue_version() {
  # rovenueVersion is decorative (informational manifest metadata, not a
  # correctness guard like encryptionKeyFingerprint) — it must never be able
  # to fail the whole backup. A no-match grep exits 1, which under
  # pipefail/set -e would otherwise abort the entire run over a missing
  # "version" line. The fallback below covers that the same way the
  # missing-file case already did.
  local version
  version="$( { [ -f "$PACKAGE_JSON_PATH" ] && grep -m1 '"version"' "$PACKAGE_JSON_PATH" | sed -E 's/.*"version": *"([^"]*)".*/\1/'; } || true )"
  printf '%s' "${version:-unknown}"
}

print_help() {
  cat <<EOF
Usage: deploy/backup/backup.sh --out <dir> [options]

Backs up Postgres (pg_dump -Fc --no-owner), ClickHouse (native BACKUP
DATABASE) and the paywall-asset bucket (mc mirror, tarred) into <dir>,
writing $MANIFEST_FILENAME alongside them. Redis and Redpanda are skipped
on purpose — see the reasons printed at run time.

Options:
  --out <dir>          Output directory for this backup. Required.
  --allow-plaintext     Write postgres.dump, $CLICKHOUSE_OUT_SUBDIR/$CLICKHOUSE_OUT_FILENAME and
                         $ASSETS_ARCHIVE_FILENAME UNENCRYPTED instead of age-encrypted. Costs
                         exactly what it sounds like: subscriber records,
                         device identifiers, email addresses, purchase
                         history AND every paywall asset key (which the
                         live bucket policy deliberately refuses to let
                         anyone enumerate) sitting in plaintext on whatever
                         disk <dir> is on. Legitimate for a local dump piped
                         straight into a restore; never the default. Off by
                         default.
  --mc-alias <alias>    mc alias to mirror assets from (default: $DEFAULT_MC_ALIAS).
                         Configure it first: mc alias set <alias> <endpoint> <key> <secret>
  -h, --help            Show this help and exit.

Required environment (no defaults are guessed):
  DATABASE_URL              Postgres connection string for pg_dump.
  ENCRYPTION_KEY             The application's data key. Only its SHA-256
                             fingerprint is written to the manifest — never
                             the key itself.
  CLICKHOUSE_URL              ClickHouse HTTP endpoint, e.g. http://localhost:8124
  CLICKHOUSE_WRITE_PASSWORD    Password for the '$CLICKHOUSE_BACKUP_USER' (schema-owner) user.
                             rovenue_reader cannot run BACKUP (readonly=2).
  ASSET_STORAGE_BUCKET         Bucket to mirror via mc.
  BACKUP_AGE_RECIPIENT          age recipient (age1...) backups are encrypted
                             to. Required unless --allow-plaintext is given.
                             MUST be a different key from ENCRYPTION_KEY —
                             reusing the application's data key as the
                             backup key means one compromise loses both.

Exit status is non-zero on any failure; no $MANIFEST_FILENAME is written
unless every step (Postgres, ClickHouse, object storage) succeeded.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --out)
        [ $# -ge 2 ] || fail "--out requires a directory argument"
        OUT_DIR="$2"
        shift 2
        ;;
      --allow-plaintext)
        ALLOW_PLAINTEXT=1
        shift
        ;;
      --mc-alias)
        [ $# -ge 2 ] || fail "--mc-alias requires an alias name"
        MC_ALIAS="$2"
        shift 2
        ;;
      -h|--help)
        print_help
        exit 0
        ;;
      *)
        fail "unknown argument: $1 (see --help)"
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Step gates, run in this order deliberately: the encryption default is
# refused before anything else runs; DATABASE_URL is the next thing checked
# so a misconfigured run fails "for want of a database" rather than for a
# tool it hasn't needed yet.
# ---------------------------------------------------------------------------
check_encryption_mode() {
  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    return 0
  fi
  if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
    fail "BACKUP_AGE_RECIPIENT is not set. Refusing to write an unencrypted backup by default — a Rovenue Postgres dump holds subscriber records, device identifiers, email addresses and purchase history. Set BACKUP_AGE_RECIPIENT to an age recipient (age1...; generate a DEDICATED backup keypair with 'age-keygen' — never reuse ENCRYPTION_KEY), or pass --allow-plaintext to proceed unencrypted (only legitimate for a local dump piped straight into a restore)."
  fi
}

compute_fingerprint() {
  require_env ENCRYPTION_KEY "its SHA-256 fingerprint (never the key itself) is written to $MANIFEST_FILENAME so a future restore can refuse to run against the wrong environment"
  ENCRYPTION_KEY_FINGERPRINT="$(printf '%s' "$ENCRYPTION_KEY" | sha256_hex)"
}

# ---------------------------------------------------------------------------
# Postgres.
# ---------------------------------------------------------------------------
run_postgres_backup() {
  require_bin "$PG_DUMP_BIN" "Install PostgreSQL client tools (macOS: 'brew install postgresql@16'; Debian/Ubuntu: 'apt-get install postgresql-client')."

  echo "==> Postgres: $PG_DUMP_BIN $PG_DUMP_FORMAT_FLAG $PG_DUMP_NO_OWNER_FLAG"
  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    POSTGRES_ARTIFACT="$POSTGRES_DUMP_FILENAME"
    "$PG_DUMP_BIN" -d "$DATABASE_URL" "$PG_DUMP_FORMAT_FLAG" "$PG_DUMP_NO_OWNER_FLAG" -f "$OUT_DIR/$POSTGRES_ARTIFACT"
    POSTGRES_ENCRYPTED="false"
  else
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to encrypt backup artifacts, or pass --allow-plaintext."
    POSTGRES_ARTIFACT="${POSTGRES_DUMP_FILENAME}${AGE_SUFFIX}"
    "$PG_DUMP_BIN" -d "$DATABASE_URL" "$PG_DUMP_FORMAT_FLAG" "$PG_DUMP_NO_OWNER_FLAG" \
      | "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$OUT_DIR/$POSTGRES_ARTIFACT"
    POSTGRES_ENCRYPTED="true"
  fi
  POSTGRES_BYTES="$(wc -c < "$OUT_DIR/$POSTGRES_ARTIFACT" | tr -d ' ')"
  echo "    wrote $OUT_DIR/$POSTGRES_ARTIFACT ($(human_size "$POSTGRES_BYTES"))"
}

# ---------------------------------------------------------------------------
# ClickHouse.
# ---------------------------------------------------------------------------
run_clickhouse_backup() {
  require_env CLICKHOUSE_URL "the ClickHouse HTTP endpoint, e.g. http://localhost:8124 (see .env.example). NOTE: ClickHouse reports a network allow-list rejection to the client as 'password is incorrect' — check deploy/clickhouse/users.d/rovenue.xml's <networks> allow-list before assuming the credentials below are wrong."
  require_env CLICKHOUSE_WRITE_PASSWORD "the password for the '$CLICKHOUSE_BACKUP_USER' (schema-owner) user — rovenue_reader runs under readonly=2 and cannot execute BACKUP"
  require_bin curl "curl is required to issue the ClickHouse BACKUP statement over HTTP."
  require_bin docker "Docker (with the compose plugin) is required to copy the ClickHouse backup archive out of the clickhouse container — the backups disk lives inside the container's data volume, not on the host filesystem."

  local database="${CLICKHOUSE_DATABASE:-$CLICKHOUSE_DATABASE_DEFAULT}"
  local archive_name="${CLICKHOUSE_BACKUP_NAME_PREFIX}-${TIMESTAMP}${CLICKHOUSE_ARCHIVE_EXTENSION}"
  local query="BACKUP DATABASE ${database} TO Disk('${CLICKHOUSE_BACKUP_DISK_NAME}', '${archive_name}')"

  echo "==> ClickHouse: BACKUP DATABASE $database TO Disk('$CLICKHOUSE_BACKUP_DISK_NAME', '$archive_name')"
  # Unlike `curl -sf`, this surfaces ClickHouse's own error text on an HTTP
  # failure — `-f` makes curl exit nonzero on 4xx/5xx with NO body
  # captured, so the only diagnostic ever shown was this script's
  # hardcoded allow-list/credentials hint below, even when the real cause
  # was something curl actually reported (e.g. "Disk 'backups' is not
  # allowed for backups", "Database rovenue already exists", disk full)
  # and the hint was wrong.
  local raw http_code response
  raw="$(curl -s -w "$CURL_STATUS_SUFFIX_FORMAT" -u "${CLICKHOUSE_BACKUP_USER}:${CLICKHOUSE_WRITE_PASSWORD}" --data-binary "$query" "$CLICKHOUSE_URL/")"
  http_code="${raw##*$'\n'}"
  response="${raw%$'\n'*}"
  if ! [ "$http_code" -ge "$HTTP_SUCCESS_STATUS_MIN" ] 2>/dev/null || ! [ "$http_code" -lt "$HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE" ] 2>/dev/null; then
    fail "ClickHouse BACKUP failed against $CLICKHOUSE_URL (HTTP ${http_code:-(no response)}): $response. If curl reported an auth failure ('password is incorrect'), check the IP allow-list in deploy/clickhouse/users.d/rovenue.xml before the credentials — see CLAUDE.md's ClickHouse note."
  fi
  echo "    $response"

  local container_id
  container_id="$(docker compose --project-directory "$ROOT_DIR" ps -q "$CLICKHOUSE_COMPOSE_SERVICE")"
  [ -n "$container_id" ] || fail "clickhouse container not found (docker compose ps -q $CLICKHOUSE_COMPOSE_SERVICE returned nothing). Is the stack up? Try: docker compose up -d $CLICKHOUSE_COMPOSE_SERVICE"

  mkdir -p "$OUT_DIR/$CLICKHOUSE_OUT_SUBDIR"
  local staged="$STAGING_DIR/$archive_name"
  docker cp "${container_id}:${CLICKHOUSE_CONTAINER_BACKUP_DIR}/${archive_name}" "$staged"
  docker exec "$container_id" rm -f "${CLICKHOUSE_CONTAINER_BACKUP_DIR}/${archive_name}"

  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    CLICKHOUSE_ARTIFACT="$CLICKHOUSE_OUT_SUBDIR/$CLICKHOUSE_OUT_FILENAME"
    mv "$staged" "$OUT_DIR/$CLICKHOUSE_ARTIFACT"
    CLICKHOUSE_ENCRYPTED="false"
  else
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to encrypt backup artifacts, or pass --allow-plaintext."
    CLICKHOUSE_ARTIFACT="$CLICKHOUSE_OUT_SUBDIR/${CLICKHOUSE_OUT_FILENAME}${AGE_SUFFIX}"
    "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$OUT_DIR/$CLICKHOUSE_ARTIFACT" "$staged"
    rm -f "$staged"
    CLICKHOUSE_ENCRYPTED="true"
  fi
  CLICKHOUSE_BYTES="$(wc -c < "$OUT_DIR/$CLICKHOUSE_ARTIFACT" | tr -d ' ')"
  echo "    wrote $OUT_DIR/$CLICKHOUSE_ARTIFACT ($(human_size "$CLICKHOUSE_BYTES"))"
}

# ---------------------------------------------------------------------------
# Object storage. Mirrored to a staging directory, tarred, then encrypted
# the same as the database artifacts — see the file header comment for why
# the bucket's public-read policy does NOT make this step exempt.
# ---------------------------------------------------------------------------
# `mc mirror` moves object BYTES only — it does not round-trip S3 object
# metadata (Content-Type, Cache-Control, x-amz-meta-* — verified directly
# against a throwaway MinIO container: a mirror-down/tar/mirror-up round
# trip drops Cache-Control entirely even though the bytes and the
# extension-inferred Content-Type survive). Rather than have restore.sh
# re-derive Cache-Control/Content-Type from the key's extension — which
# would only be correct by coincidence with AssetStore's current policy,
# and silently drift the moment that policy changes without this file
# being touched — this captures the ACTUAL metadata `mc stat` reports for
# every mirrored object into a JSON sidecar inside the archive, keyed by
# the object's relative path. restore.sh reads it back and re-applies it
# per object via `mc cp --attr`.
capture_assets_metadata() {
  local mirror_dir="$1"
  local metadata_file="$2"

  printf '{}' > "$metadata_file"

  local abs_path rel_path stat_json obj_metadata
  while IFS= read -r abs_path; do
    [ -n "$abs_path" ] || continue
    rel_path="${abs_path#"$mirror_dir"/}"
    stat_json="$("$MC_BIN" stat --json "$MC_ALIAS/$ASSET_STORAGE_BUCKET/$rel_path")" \
      || fail "mc stat failed for $MC_ALIAS/$ASSET_STORAGE_BUCKET/$rel_path while capturing asset metadata for backup"
    obj_metadata="$(printf '%s' "$stat_json" | "$JQ_BIN" -c '.metadata // {}')"
    # shellcheck disable=SC2016 # single-quoted jq filter — $k/$v are jq's own --arg/--argjson bindings, not shell variables.
    "$JQ_BIN" --arg k "$rel_path" --argjson v "$obj_metadata" '.[$k] = $v' "$metadata_file" > "${metadata_file}.tmp"
    mv "${metadata_file}.tmp" "$metadata_file"
  done < <(find "$mirror_dir" -type f)
}

run_assets_backup() {
  require_bin "$MC_BIN" "mc (MinIO client) is required for the object-storage step and was not found on PATH. Install it — macOS: 'brew install minio/stable/mc'; see https://min.io/docs/minio/linux/reference/minio-mc.html#quickstart otherwise — then configure an alias pointing at your S3/MinIO/R2 endpoint: 'mc alias set $MC_ALIAS <endpoint> <access-key> <secret-key>' matching ASSET_STORAGE_* in your environment (pass a different alias name with --mc-alias)."
  require_bin "$JQ_BIN" "jq is required to build the per-object metadata sidecar (Content-Type/Cache-Control/x-amz-meta-* survive the backup/restore round trip through it) — macOS: 'brew install jq'; Debian/Ubuntu: 'apt-get install jq'."
  require_env ASSET_STORAGE_BUCKET "the paywall-asset bucket to mirror (see .env.example)"

  echo "==> Object storage: mc mirror $MC_ALIAS/$ASSET_STORAGE_BUCKET"
  local mirror_dir="$STAGING_DIR/$ASSETS_MIRROR_SUBDIR"
  mkdir -p "$mirror_dir"
  "$MC_BIN" mirror --quiet "$MC_ALIAS/$ASSET_STORAGE_BUCKET" "$mirror_dir/"

  ASSETS_FILE_COUNT="$(find "$mirror_dir" -type f | wc -l | tr -d ' ')"

  # Captured into $STAGING_DIR, NOT $mirror_dir, and moved into place only
  # after every real object has been stat'd — building it in place would
  # make find(1) walk into its own half-written sidecar file as though it
  # were an asset to capture metadata for.
  echo "==> Object storage: capturing per-object metadata (Content-Type/Cache-Control/x-amz-meta-*)"
  local metadata_staging="$STAGING_DIR/$ASSETS_METADATA_SIDECAR_FILENAME"
  capture_assets_metadata "$mirror_dir" "$metadata_staging"
  mv "$metadata_staging" "$mirror_dir/$ASSETS_METADATA_SIDECAR_FILENAME"

  local tar_path="$STAGING_DIR/$ASSETS_ARCHIVE_FILENAME"
  tar -C "$mirror_dir" -cf "$tar_path" .

  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    ASSETS_ARTIFACT="$ASSETS_ARCHIVE_FILENAME"
    mv "$tar_path" "$OUT_DIR/$ASSETS_ARTIFACT"
    ASSETS_ENCRYPTED="false"
  else
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to encrypt backup artifacts, or pass --allow-plaintext."
    ASSETS_ARTIFACT="${ASSETS_ARCHIVE_FILENAME}${AGE_SUFFIX}"
    "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$OUT_DIR/$ASSETS_ARTIFACT" "$tar_path"
    rm -f "$tar_path"
    ASSETS_ENCRYPTED="true"
  fi
  rm -rf "$mirror_dir"

  ASSETS_BYTES="$(wc -c < "$OUT_DIR/$ASSETS_ARTIFACT" | tr -d ' ')"
  echo "    wrote $OUT_DIR/$ASSETS_ARTIFACT ($(human_size "$ASSETS_BYTES")), $ASSETS_FILE_COUNT files mirrored"
}

# ---------------------------------------------------------------------------
# Manifest + summary.
# ---------------------------------------------------------------------------
write_manifest() {
  local manifest_path="$OUT_DIR/$MANIFEST_FILENAME"
  local created_at
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local database="${CLICKHOUSE_DATABASE:-$CLICKHOUSE_DATABASE_DEFAULT}"

  {
    printf '{\n'
    printf '  "createdAt": "%s",\n' "$(json_str "$created_at")"
    printf '  "rovenueVersion": "%s",\n' "$(json_str "$ROVENUE_VERSION")"
    printf '  "encryptionKeyFingerprint": "%s",\n' "$(json_str "$ENCRYPTION_KEY_FINGERPRINT")"
    printf '  "postgres": {\n'
    printf '    "file": "%s",\n' "$(json_str "$POSTGRES_ARTIFACT")"
    printf '    "encrypted": %s,\n' "$POSTGRES_ENCRYPTED"
    printf '    "bytes": %s\n' "$POSTGRES_BYTES"
    printf '  },\n'
    printf '  "clickhouse": {\n'
    printf '    "database": "%s",\n' "$(json_str "$database")"
    printf '    "file": "%s",\n' "$(json_str "$CLICKHOUSE_ARTIFACT")"
    printf '    "encrypted": %s,\n' "$CLICKHOUSE_ENCRYPTED"
    printf '    "bytes": %s\n' "$CLICKHOUSE_BYTES"
    printf '  },\n'
    printf '  "assets": {\n'
    printf '    "bucket": "%s",\n' "$(json_str "$ASSET_STORAGE_BUCKET")"
    printf '    "file": "%s",\n' "$(json_str "$ASSETS_ARTIFACT")"
    printf '    "encrypted": %s,\n' "$ASSETS_ENCRYPTED"
    printf '    "fileCount": %s,\n' "$ASSETS_FILE_COUNT"
    printf '    "bytes": %s\n' "$ASSETS_BYTES"
    printf '  },\n'
    printf '  "skipped": {\n'
    printf '    "redis": "%s",\n' "$(json_str "$REDIS_SKIP_REASON")"
    printf '    "redpanda": "%s"\n' "$(json_str "$REDPANDA_SKIP_REASON")"
    printf '  }\n'
    printf '}\n'
  } > "$manifest_path"

  echo "==> Wrote $manifest_path"
}

print_summary() {
  echo
  echo "Backup complete: $OUT_DIR"
  echo "  postgres:   $POSTGRES_ARTIFACT ($(human_size "$POSTGRES_BYTES")), encrypted=$POSTGRES_ENCRYPTED"
  echo "  clickhouse: $CLICKHOUSE_ARTIFACT ($(human_size "$CLICKHOUSE_BYTES")), encrypted=$CLICKHOUSE_ENCRYPTED"
  echo "  assets:     $ASSETS_ARTIFACT ($ASSETS_FILE_COUNT files, $(human_size "$ASSETS_BYTES")), encrypted=$ASSETS_ENCRYPTED"
  echo "  skipped:    redis    — $REDIS_SKIP_REASON"
  echo "              redpanda — $REDPANDA_SKIP_REASON"
  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    echo
    echo "WARNING: --allow-plaintext was set. $POSTGRES_ARTIFACT, $CLICKHOUSE_ARTIFACT and $ASSETS_ARTIFACT in $OUT_DIR are UNENCRYPTED. The first two contain subscriber PII; $ASSETS_ARTIFACT contains the full paywall-asset key listing the live bucket policy deliberately refuses to enumerate. Do not leave them on a disk you do not fully control."
  fi
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  [ -n "$OUT_DIR" ] || fail "--out <dir> is required (see --help)"

  check_encryption_mode
  require_env DATABASE_URL "pg_dump needs it to connect to Postgres (see .env.example)"
  compute_fingerprint

  TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ROVENUE_VERSION="$(read_rovenue_version)"
  STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rovenue-backup.XXXXXX")"
  trap 'rm -rf "$STAGING_DIR"' EXIT

  mkdir -p "$OUT_DIR"

  echo "Rovenue backup -> $OUT_DIR"
  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    echo "  encryption: DISABLED (--allow-plaintext)"
  else
    echo "  encryption: age, recipient $BACKUP_AGE_RECIPIENT"
  fi
  echo "  redis:      SKIPPED — $REDIS_SKIP_REASON"
  echo "  redpanda:   SKIPPED — $REDPANDA_SKIP_REASON"
  echo

  run_postgres_backup
  run_clickhouse_backup
  run_assets_backup

  write_manifest
  print_summary
}

main "$@"
