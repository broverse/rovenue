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
# Postgres and ClickHouse artifacts are age-encrypted by default — a Rovenue
# Postgres dump holds subscriber records, device identifiers, email addresses
# and purchase history, in a product that ships GDPR/KVKK export/anonymise
# tooling. Leaving an unencrypted copy of the entire subject database on a
# disk would undo that at the first step. --allow-plaintext exists because a
# local dump piped straight into a restore is a legitimate thing to do, but
# it is never the default.
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
# The paywall-asset bucket (assets/) is mirrored PLAINTEXT, not encrypted —
# deliberately, not an oversight. Those objects are served with an anonymous
# s3:GetObject-only bucket policy (see deploy/minio's bucket setup and
# ASSET_PUBLIC_BASE_URL): they are already public on the internet, so
# encrypting a local mirror of them adds no confidentiality this backup can
# meaningfully claim, and it would prevent restore.sh from mirroring the
# directory straight back with `mc mirror`.
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
readonly ASSETS_OUT_SUBDIR="assets"
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

# Object storage.
readonly MC_BIN="mc"
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
  if [ ! -f "$PACKAGE_JSON_PATH" ]; then
    printf 'unknown'
    return 0
  fi
  grep -m1 '"version"' "$PACKAGE_JSON_PATH" | sed -E 's/.*"version": *"([^"]*)".*/\1/'
}

print_help() {
  cat <<EOF
Usage: deploy/backup/backup.sh --out <dir> [options]

Backs up Postgres (pg_dump -Fc --no-owner), ClickHouse (native BACKUP
DATABASE) and the paywall-asset bucket (mc mirror) into <dir>, writing
$MANIFEST_FILENAME alongside them. Redis and Redpanda are skipped on
purpose — see the reasons printed at run time.

Options:
  --out <dir>          Output directory for this backup. Required.
  --allow-plaintext     Write postgres.dump and $CLICKHOUSE_OUT_SUBDIR/$CLICKHOUSE_OUT_FILENAME
                         UNENCRYPTED instead of age-encrypted. Costs exactly
                         what it sounds like: subscriber records, device
                         identifiers, email addresses and purchase history
                         sitting in plaintext on whatever disk <dir> is on.
                         Legitimate for a local dump piped straight into a
                         restore; never the default. Off by default.
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
  local response
  response="$(curl -sf -u "${CLICKHOUSE_BACKUP_USER}:${CLICKHOUSE_WRITE_PASSWORD}" --data-binary "$query" "$CLICKHOUSE_URL/")" \
    || fail "ClickHouse BACKUP failed against $CLICKHOUSE_URL. If curl reported an auth failure ('password is incorrect'), check the IP allow-list in deploy/clickhouse/users.d/rovenue.xml before the credentials — see CLAUDE.md's ClickHouse note."
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
# Object storage. Deliberately plaintext even when the rest of the backup is
# encrypted — see the file header comment for why.
# ---------------------------------------------------------------------------
run_assets_backup() {
  require_bin "$MC_BIN" "mc (MinIO client) is required for the object-storage step and was not found on PATH. Install it — macOS: 'brew install minio/stable/mc'; see https://min.io/docs/minio/linux/reference/minio-mc.html#quickstart otherwise — then configure an alias pointing at your S3/MinIO/R2 endpoint: 'mc alias set $MC_ALIAS <endpoint> <access-key> <secret-key>' matching ASSET_STORAGE_* in your environment (pass a different alias name with --mc-alias)."
  require_env ASSET_STORAGE_BUCKET "the paywall-asset bucket to mirror (see .env.example)"

  echo "==> Object storage: mc mirror $MC_ALIAS/$ASSET_STORAGE_BUCKET"
  mkdir -p "$OUT_DIR/$ASSETS_OUT_SUBDIR"
  "$MC_BIN" mirror --quiet "$MC_ALIAS/$ASSET_STORAGE_BUCKET" "$OUT_DIR/$ASSETS_OUT_SUBDIR/"

  ASSETS_FILE_COUNT="$(find "$OUT_DIR/$ASSETS_OUT_SUBDIR" -type f | wc -l | tr -d ' ')"
  local kib
  kib="$(du -sk "$OUT_DIR/$ASSETS_OUT_SUBDIR" | cut -f1)"
  ASSETS_BYTES=$((kib * 1024))
  echo "    mirrored $ASSETS_FILE_COUNT files ($(human_size "$ASSETS_BYTES")) to $OUT_DIR/$ASSETS_OUT_SUBDIR/ — not encrypted: these objects are already served publicly (anonymous s3:GetObject bucket policy), so a plaintext local mirror adds no new exposure."
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
    printf '    "dir": "%s",\n' "$(json_str "$ASSETS_OUT_SUBDIR/")"
    printf '    "encrypted": false,\n'
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
  echo "  assets:     $ASSETS_OUT_SUBDIR/ ($ASSETS_FILE_COUNT files, $(human_size "$ASSETS_BYTES")), encrypted=false (public CDN content)"
  echo "  skipped:    redis    — $REDIS_SKIP_REASON"
  echo "              redpanda — $REDPANDA_SKIP_REASON"
  if [ "$ALLOW_PLAINTEXT" -eq 1 ]; then
    echo
    echo "WARNING: --allow-plaintext was set. $POSTGRES_ARTIFACT and $CLICKHOUSE_ARTIFACT in $OUT_DIR are UNENCRYPTED and contain subscriber PII. Do not leave them on a disk you do not fully control."
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
