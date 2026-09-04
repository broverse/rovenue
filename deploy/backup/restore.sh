#!/usr/bin/env bash
#
# deploy/backup/restore.sh — restores a backup written by deploy/backup/backup.sh:
# Postgres, then the paywall-asset bucket, then ClickHouse.
#
# WHOLE DATABASE ONLY. There is no table selector and there never will be
# one: audit_logs is a per-project SHA-256 hash chain, so restoring some
# tables from one snapshot and others from another breaks the chain with no
# repair. Every artifact this script touches is restored in full or not at
# all.
#
# The fingerprint guard runs FIRST, before anything else is touched. A
# restore with the WRONG ENCRYPTION_KEY is worse than one with a lost key:
# it succeeds, and the damage only surfaces the next time a receipt is
# verified — a warning cannot fix that, because the person restoring at 3am
# is the person who skims warnings. So a fingerprint mismatch, or a missing
# ENCRYPTION_KEY in the environment being restored into, aborts before any
# service is stopped and before any database, bucket or ClickHouse table is
# touched.
#
# RUN THIS FROM INSIDE THE COMPOSE NETWORK, not from the host. Two
# reproducible traps documented in deploy/backup/backup.sh and CLAUDE.md
# apply here too:
#   - Reaching MinIO from the host over the Docker-Desktop-forwarded port
#     (127.0.0.1:9002) fails on `?location=` (GetBucketLocation) queries.
#   - ClickHouse reports a network allow-list rejection (the allow-list in
#     deploy/clickhouse/users.d/rovenue.xml only permits loopback +
#     172.16/12 + 10/8; Docker-Desktop host traffic arrives from
#     192.168.65.1) to the client as "password is incorrect" — check the
#     allow-list before assuming the credentials below are wrong.
# Run this from a container on the compose network (e.g. `docker compose
# run --rm migrate ...`), or bridge with a one-off socat forwarder the same
# way CLAUDE.md documents for ClickHouse.
#
# Order: Postgres, then object storage, then ClickHouse. Postgres is
# restored first because it is the only store the others are consistent
# AGAINST. ClickHouse is restored last, and its Kafka Engine tables and
# their materialised views are DETACHED immediately after RESTORE DATABASE
# completes, then re-ATTACHed right away: BACKUP DATABASE captures the
# Kafka Engine tables (and the MVs reading from them) along with the data
# tables, and RESTORE DATABASE attaches them as part of recreating them —
# their consumer thread starts immediately, at whatever offset the
# consumer group holds, before anything in this script can intervene. The
# detach/re-attach pair closes that window as fast as a script can; it
# does not extend it. Verification (below) runs only once the objects are
# back — db:verify:clickhouse checks live Kafka consumer state and needs
# them attached to see it. The api, dispatcher and every BullMQ worker are
# stopped before any of this starts and are never restarted by this
# script, so the outbox holds rather than the topic dropping work for the
# entire run, not just the ClickHouse step.
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants shared with backup.sh — SAME NAME, SAME VALUE, so the two
# scripts cannot drift apart on the layout one writes and the other reads.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly ROOT_DIR

readonly MANIFEST_FILENAME="manifest.json"
readonly POSTGRES_DUMP_FILENAME="postgres.dump"
readonly CLICKHOUSE_OUT_SUBDIR="clickhouse"
readonly CLICKHOUSE_OUT_FILENAME="clickhouse.zip"
readonly ASSETS_ARCHIVE_FILENAME="assets.tar"
readonly ASSETS_MIRROR_SUBDIR="assets-mirror"
readonly AGE_SUFFIX=".age"

readonly PG_DUMP_NO_OWNER_FLAG="--no-owner"

readonly CLICKHOUSE_DATABASE_DEFAULT="rovenue"
readonly CLICKHOUSE_BACKUP_USER="rovenue"
readonly CLICKHOUSE_BACKUP_DISK_NAME="backups"
readonly CLICKHOUSE_BACKUP_NAME_PREFIX="rovenue"
readonly CLICKHOUSE_ARCHIVE_EXTENSION=".zip"
readonly CLICKHOUSE_CONTAINER_BACKUP_DIR="/var/lib/clickhouse/backups"
readonly CLICKHOUSE_COMPOSE_SERVICE="clickhouse"

readonly MC_BIN="mc"
readonly DEFAULT_MC_ALIAS="rovenue-backup"

readonly AGE_BIN="age"

# ---------------------------------------------------------------------------
# Restore-only constants.
# ---------------------------------------------------------------------------
readonly PG_RESTORE_BIN="pg_restore"
readonly PSQL_BIN="psql"
# Whole-database restore only. --if-exists suppresses errors on objects
# that don't exist yet (the common case: restoring into an empty
# database), so both the guarded and --force paths use the same flags.
readonly PG_RESTORE_CLEAN_FLAG="--clean"
readonly PG_RESTORE_IF_EXISTS_FLAG="--if-exists"

# A single, unambiguous table whose presence means "this database already
# holds Rovenue data" — see check_existing_tables(). subscribers is created
# in migration 0000 and never dropped.
readonly EXISTING_DATA_PROBE_TABLE="public.subscribers"

# Row counts printed as part of verification (guard 5: verification is part
# of restore, not a separate step) — the core denormalized-read table, the
# append-only ledger, the append-only hash-chained audit log, the outbox
# (Kafka's only durable upstream), and the tenant root.
readonly ROW_COUNT_TABLES=(subscribers credit_ledger audit_logs outbox_events projects)

# Compose services stopped before anything is touched, and not restarted by
# this script — bringing traffic back is an operator decision made after
# reading the verification output below, not something restore.sh assumes.
readonly COMPOSE_SERVICES_TO_STOP=(api dispatcher notifier-worker digest-scheduler send-email-worker send-push-worker)

readonly PNPM_BIN="pnpm"
readonly DB_VERIFY_CLICKHOUSE_FILTER="@rovenue/db"
readonly DB_VERIFY_CLICKHOUSE_SCRIPT="db:verify:clickhouse"
readonly ASSET_HEADERS_VERIFY_FILTER="@rovenue/scripts"
readonly ASSET_HEADERS_VERIFY_SCRIPT="verify:asset-headers"

# ---------------------------------------------------------------------------
# Globals populated while the script runs.
# ---------------------------------------------------------------------------
FROM_DIR=""
FORCE=0
MC_ALIAS="$DEFAULT_MC_ALIAS"
STAGING_DIR=""

MANIFEST_PATH=""
MANIFEST_ENCRYPTION_KEY_FINGERPRINT=""
MANIFEST_POSTGRES_FILE=""
MANIFEST_POSTGRES_ENCRYPTED=""
MANIFEST_CLICKHOUSE_FILE=""
MANIFEST_CLICKHOUSE_ENCRYPTED=""
MANIFEST_CLICKHOUSE_DATABASE=""
MANIFEST_ASSETS_FILE=""
MANIFEST_ASSETS_ENCRYPTED=""

# Kafka objects detached mid-restore, tracked so re-attach can walk the
# same list without re-discovering it under a since-changed schema.
KAFKA_TABLES=()
KAFKA_VIEWS=()

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
fail() {
  echo "restore.sh: $1" >&2
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

# Extracts a scalar JSON field ("key": "value" | "key": true | "key": 123)
# from stdin. Tolerant of both backup.sh's pretty-printed manifest and a
# hand-written compact one (the guard probes below use the latter) — it
# matches the key anywhere on the line rather than anchoring at the start.
json_scalar() {
  local key="$1"
  sed -nE 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"?([^",}]*)"?.*/\1/p' | head -n1
}

# Slices out one top-level object ("section": { ... }) from the manifest so
# json_scalar can be applied within it without colliding with a same-named
# field in a different section ("file", "encrypted" and "bytes" each appear
# in postgres, clickhouse AND assets).
json_section() {
  local file="$1" section="$2"
  sed -n "/\"$section\": {/,/^  }/p" "$file"
}

# Sanity-checks a manifest-recorded filename against the name backup.sh
# would have written for that artifact and encryption state. This is a
# NOTE, never a guard: the artifact contract is read from the manifest
# (file/encrypted/bytes), never guessed from the filename — see the file
# header. A mismatch here just means the backup was produced by a
# differently-configured backup.sh; the manifest's own value is still what
# gets opened.
check_artifact_name() {
  local label="$1" actual="$2" expected_plain="$3" encrypted="$4"
  local expected="$expected_plain"
  [ "$encrypted" = "true" ] && expected="${expected_plain}${AGE_SUFFIX}"
  if [ "$actual" != "$expected" ]; then
    echo "    NOTE: manifest $label.file ('$actual') differs from the name backup.sh would write ('$expected') for encrypted=$encrypted — using the manifest's value."
  fi
}

print_help() {
  cat <<EOF
Usage: deploy/backup/restore.sh --from <dir> [options]

Restores a backup written by deploy/backup/backup.sh: Postgres, then the
paywall-asset bucket, then ClickHouse (Kafka Engine tables detached across
the restore, re-attached once verification passes). Whole database only —
there is no table selector.

Options:
  --from <dir>         Directory holding $MANIFEST_FILENAME and the artifacts
                        it names. Required.
  --force               Proceed even though the target Postgres database
                        already has Rovenue tables. Still whole-database —
                        this does not select tables, it only removes the
                        guard that refuses to run at all.
  --mc-alias <alias>    mc alias to mirror assets to (default: $DEFAULT_MC_ALIAS).
                        Configure it first: mc alias set <alias> <endpoint> <key> <secret>
  -h, --help            Show this help and exit.

Required environment (no defaults are guessed):
  ENCRYPTION_KEY             The application's data key for the environment
                              being restored INTO. Its SHA-256 fingerprint is
                              compared against the manifest's before anything
                              else runs. Missing or mismatched aborts.
  DATABASE_URL               Postgres connection string for pg_restore.
  BACKUP_AGE_IDENTITY         Path to the age private key that decrypts the
                              backup, if the manifest says it was encrypted.
  CLICKHOUSE_URL              ClickHouse HTTP endpoint, e.g. http://localhost:8124
  CLICKHOUSE_WRITE_PASSWORD    Password for the '$CLICKHOUSE_BACKUP_USER' (schema-owner) user.
  ASSET_STORAGE_BUCKET         Bucket to restore assets INTO (see .env.example).

Exit status is non-zero on any failure, including a failed verification
step — verification is part of the restore, not a separate step.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --from)
        [ $# -ge 2 ] || fail "--from requires a directory argument"
        FROM_DIR="$2"
        shift 2
        ;;
      --force)
        FORCE=1
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
# Manifest.
# ---------------------------------------------------------------------------
load_manifest() {
  [ -n "$FROM_DIR" ] || fail "--from <dir> is required (see --help)"
  [ -d "$FROM_DIR" ] || fail "--from directory does not exist: $FROM_DIR"
  MANIFEST_PATH="$FROM_DIR/$MANIFEST_FILENAME"
  [ -f "$MANIFEST_PATH" ] || fail "$MANIFEST_FILENAME not found in $FROM_DIR — is this a backup.sh output directory?"

  MANIFEST_ENCRYPTION_KEY_FINGERPRINT="$(json_scalar encryptionKeyFingerprint < "$MANIFEST_PATH")"
  [ -n "$MANIFEST_ENCRYPTION_KEY_FINGERPRINT" ] || fail "$MANIFEST_PATH has no encryptionKeyFingerprint field — refusing to restore a manifest that can't prove which key it was taken under."

  MANIFEST_POSTGRES_FILE="$(json_section "$MANIFEST_PATH" postgres | json_scalar file)"
  MANIFEST_POSTGRES_ENCRYPTED="$(json_section "$MANIFEST_PATH" postgres | json_scalar encrypted)"
  MANIFEST_CLICKHOUSE_FILE="$(json_section "$MANIFEST_PATH" clickhouse | json_scalar file)"
  MANIFEST_CLICKHOUSE_ENCRYPTED="$(json_section "$MANIFEST_PATH" clickhouse | json_scalar encrypted)"
  MANIFEST_CLICKHOUSE_DATABASE="$(json_section "$MANIFEST_PATH" clickhouse | json_scalar database)"
  MANIFEST_ASSETS_FILE="$(json_section "$MANIFEST_PATH" assets | json_scalar file)"
  MANIFEST_ASSETS_ENCRYPTED="$(json_section "$MANIFEST_PATH" assets | json_scalar encrypted)"

  check_artifact_name postgres "$MANIFEST_POSTGRES_FILE" "$POSTGRES_DUMP_FILENAME" "$MANIFEST_POSTGRES_ENCRYPTED"
  check_artifact_name clickhouse "$MANIFEST_CLICKHOUSE_FILE" "$CLICKHOUSE_OUT_SUBDIR/$CLICKHOUSE_OUT_FILENAME" "$MANIFEST_CLICKHOUSE_ENCRYPTED"
  check_artifact_name assets "$MANIFEST_ASSETS_FILE" "$ASSETS_ARCHIVE_FILENAME" "$MANIFEST_ASSETS_ENCRYPTED"
}

# ---------------------------------------------------------------------------
# Guard 1: fingerprint, first — before anything is touched.
# ---------------------------------------------------------------------------
check_fingerprint() {
  if [ -z "${ENCRYPTION_KEY:-}" ]; then
    fail "ENCRYPTION_KEY is not set in the environment being restored into. Refusing to proceed: a restore with the WRONG key is worse than one with a lost key — it succeeds, and the damage only surfaces the next time a receipt is verified. Set ENCRYPTION_KEY to the value that matches this backup (fingerprint $MANIFEST_ENCRYPTION_KEY_FINGERPRINT) and re-run."
  fi

  local current_fingerprint
  current_fingerprint="$(printf '%s' "$ENCRYPTION_KEY" | sha256_hex)"

  if [ "$current_fingerprint" != "$MANIFEST_ENCRYPTION_KEY_FINGERPRINT" ]; then
    fail "ENCRYPTION_KEY fingerprint mismatch. manifest=$MANIFEST_ENCRYPTION_KEY_FINGERPRINT current=$current_fingerprint. This backup was taken under a different ENCRYPTION_KEY than the one set in this environment. Restoring anyway would silently corrupt every AES-256-GCM-encrypted store credential — the failure would only surface the next time a receipt is verified. Set ENCRYPTION_KEY to the matching value before retrying."
  fi

  echo "==> Fingerprint guard OK ($current_fingerprint)"
}

# ---------------------------------------------------------------------------
# Guard 2: stop api, dispatcher and workers before touching anything.
# ---------------------------------------------------------------------------
stop_services() {
  echo "==> Stopping services: ${COMPOSE_SERVICES_TO_STOP[*]}"
  docker compose --project-directory "$ROOT_DIR" stop "${COMPOSE_SERVICES_TO_STOP[@]}"
}

# ---------------------------------------------------------------------------
# Guard 3: refuse to run against a database with existing Rovenue tables,
# unless --force. Whole-database only — this is a go/no-go gate, never a
# table selector.
# ---------------------------------------------------------------------------
check_existing_tables() {
  require_bin "$PSQL_BIN" "Install PostgreSQL client tools (macOS: 'brew install postgresql@16'; Debian/Ubuntu: 'apt-get install postgresql-client')."

  local probe
  probe="$("$PSQL_BIN" -d "$DATABASE_URL" -tAc "SELECT to_regclass('$EXISTING_DATA_PROBE_TABLE')")"

  if [ -n "$probe" ] && [ "$FORCE" -ne 1 ]; then
    fail "target database already has Rovenue tables ($EXISTING_DATA_PROBE_TABLE exists). Refusing to restore over live data without --force. There is no table selector: audit_logs is a per-project SHA-256 hash chain, and restoring some tables from one snapshot while leaving others as-is breaks the chain with no repair. Point DATABASE_URL at an empty database, or pass --force if you have already confirmed this is safe to overwrite."
  fi

  if [ -n "$probe" ]; then
    echo "==> --force set: proceeding against a database that already has Rovenue tables ($EXISTING_DATA_PROBE_TABLE exists)"
  fi
}

# ---------------------------------------------------------------------------
# Postgres.
# ---------------------------------------------------------------------------
run_postgres_restore() {
  require_bin "$PG_RESTORE_BIN" "Install PostgreSQL client tools (macOS: 'brew install postgresql@16'; Debian/Ubuntu: 'apt-get install postgresql-client')."
  [ -n "$MANIFEST_POSTGRES_FILE" ] || fail "$MANIFEST_PATH has no postgres.file field"

  local src="$FROM_DIR/$MANIFEST_POSTGRES_FILE"
  [ -f "$src" ] || fail "postgres artifact named in the manifest not found: $src"

  echo "==> Postgres: $PG_RESTORE_BIN <- $src (encrypted=$MANIFEST_POSTGRES_ENCRYPTED)"
  if [ "$MANIFEST_POSTGRES_ENCRYPTED" = "true" ]; then
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to decrypt this backup."
    require_env BACKUP_AGE_IDENTITY "the path to the age private key that decrypts this backup"
    [ -f "$BACKUP_AGE_IDENTITY" ] || fail "BACKUP_AGE_IDENTITY does not point to a file: $BACKUP_AGE_IDENTITY"
    "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY" "$src" \
      | "$PG_RESTORE_BIN" -d "$DATABASE_URL" "$PG_DUMP_NO_OWNER_FLAG" "$PG_RESTORE_CLEAN_FLAG" "$PG_RESTORE_IF_EXISTS_FLAG"
  else
    "$PG_RESTORE_BIN" -d "$DATABASE_URL" "$PG_DUMP_NO_OWNER_FLAG" "$PG_RESTORE_CLEAN_FLAG" "$PG_RESTORE_IF_EXISTS_FLAG" "$src"
  fi
  echo "    Postgres restore complete"
}

# ---------------------------------------------------------------------------
# Object storage.
# ---------------------------------------------------------------------------
run_assets_restore() {
  require_bin "$MC_BIN" "mc (MinIO client) is required for the object-storage step and was not found on PATH. Install it — macOS: 'brew install minio/stable/mc'."
  require_env ASSET_STORAGE_BUCKET "the paywall-asset bucket to restore INTO (see .env.example)"
  [ -n "$MANIFEST_ASSETS_FILE" ] || fail "$MANIFEST_PATH has no assets.file field"

  local src="$FROM_DIR/$MANIFEST_ASSETS_FILE"
  [ -f "$src" ] || fail "assets artifact named in the manifest not found: $src"

  echo "==> Object storage: $src -> $MC_ALIAS/$ASSET_STORAGE_BUCKET (encrypted=$MANIFEST_ASSETS_ENCRYPTED)"
  local mirror_dir="$STAGING_DIR/$ASSETS_MIRROR_SUBDIR"
  mkdir -p "$mirror_dir"

  if [ "$MANIFEST_ASSETS_ENCRYPTED" = "true" ]; then
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to decrypt this backup."
    require_env BACKUP_AGE_IDENTITY "the path to the age private key that decrypts this backup"
    [ -f "$BACKUP_AGE_IDENTITY" ] || fail "BACKUP_AGE_IDENTITY does not point to a file: $BACKUP_AGE_IDENTITY"
    "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY" "$src" | tar -x -C "$mirror_dir"
  else
    tar -x -C "$mirror_dir" -f "$src"
  fi

  local file_count
  file_count="$(find "$mirror_dir" -type f | wc -l | tr -d ' ')"
  "$MC_BIN" mirror --quiet "$mirror_dir/" "$MC_ALIAS/$ASSET_STORAGE_BUCKET"
  rm -rf "$mirror_dir"
  echo "    Object storage restore complete ($file_count files)"
}

# ---------------------------------------------------------------------------
# ClickHouse. curl issues raw SQL over the HTTP interface, same as
# backup.sh. discover_kafka_objects runs AFTER RESTORE DATABASE (the target
# database is empty before that per the whole-database contract, so there
# is nothing to discover beforehand) and detaches what it finds as the very
# next statements — no other work happens between RESTORE completing and
# the detach calls.
# ---------------------------------------------------------------------------
ch_query() {
  local query="$1"
  curl -sf -u "${CLICKHOUSE_BACKUP_USER}:${CLICKHOUSE_WRITE_PASSWORD}" --data-binary "$query" "$CLICKHOUSE_URL/"
}

discover_kafka_objects() {
  local database="$1"
  local tables
  tables="$(ch_query "SELECT name FROM system.tables WHERE database = '${database}' AND engine = 'Kafka' FORMAT TSV")"

  KAFKA_TABLES=()
  KAFKA_VIEWS=()
  [ -n "$tables" ] || return 0

  local t view_names v
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    KAFKA_TABLES+=("$t")
    # Materialized views are discovered by their create_table_query
    # referencing this Kafka table's fully-qualified name — the naming
    # convention (mv_<x>_to_raw reading FROM <x>_queue) is consistent
    # across every Kafka pipeline in packages/db/clickhouse/migrations,
    # but querying the dependency instead of the name pattern means a
    # future pipeline that doesn't follow the convention is still found.
    view_names="$(ch_query "SELECT name FROM system.tables WHERE database = '${database}' AND engine = 'MaterializedView' AND positionCaseInsensitive(create_table_query, '${database}.${t}') > 0 FORMAT TSV")"
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      KAFKA_VIEWS+=("$v")
    done <<< "$view_names"
  done <<< "$tables"
}

detach_kafka_objects() {
  local database="$1"
  local name
  # Source first: DETACH TABLE on the Kafka engine table stops its
  # background consumer thread immediately, so no further rows reach the
  # materialized view at all. The views are then detached too, for a full
  # stop rather than an idle-but-still-attached one.
  for name in "${KAFKA_TABLES[@]}"; do
    echo "    DETACH TABLE ${database}.${name}"
    ch_query "DETACH TABLE ${database}.${name}" >/dev/null
  done
  for name in "${KAFKA_VIEWS[@]}"; do
    echo "    DETACH TABLE ${database}.${name}"
    ch_query "DETACH TABLE ${database}.${name}" >/dev/null
  done
}

attach_kafka_objects() {
  local database="$1"
  local name
  # Reverse of detach: the view (sink) is attached before the Kafka table
  # (source) resumes consuming, so there is never a moment where the
  # source is running with nowhere for its rows to land.
  for name in "${KAFKA_VIEWS[@]}"; do
    echo "    ATTACH TABLE ${database}.${name}"
    ch_query "ATTACH TABLE ${database}.${name}" >/dev/null
  done
  for name in "${KAFKA_TABLES[@]}"; do
    echo "    ATTACH TABLE ${database}.${name}"
    ch_query "ATTACH TABLE ${database}.${name}" >/dev/null
  done
}

run_clickhouse_restore() {
  require_env CLICKHOUSE_URL "the ClickHouse HTTP endpoint, e.g. http://localhost:8124 (see .env.example). NOTE: ClickHouse reports a network allow-list rejection to the client as 'password is incorrect' — check deploy/clickhouse/users.d/rovenue.xml's <networks> allow-list before assuming the credentials below are wrong."
  require_env CLICKHOUSE_WRITE_PASSWORD "the password for the '$CLICKHOUSE_BACKUP_USER' (schema-owner) user"
  require_bin curl "curl is required to issue ClickHouse statements over HTTP."
  require_bin docker "Docker (with the compose plugin) is required to copy the ClickHouse backup archive into the clickhouse container."
  [ -n "$MANIFEST_CLICKHOUSE_FILE" ] || fail "$MANIFEST_PATH has no clickhouse.file field"

  # Restored INTO the environment's own configured database (same
  # env-override pattern as backup.sh), not necessarily the name the
  # manifest recorded the backup under.
  local database="${CLICKHOUSE_DATABASE:-$CLICKHOUSE_DATABASE_DEFAULT}"
  if [ -n "$MANIFEST_CLICKHOUSE_DATABASE" ] && [ "$MANIFEST_CLICKHOUSE_DATABASE" != "$database" ]; then
    echo "    NOTE: manifest recorded database '$MANIFEST_CLICKHOUSE_DATABASE'; restoring into '$database' per this environment's CLICKHOUSE_DATABASE"
  fi

  local src="$FROM_DIR/$MANIFEST_CLICKHOUSE_FILE"
  [ -f "$src" ] || fail "clickhouse artifact named in the manifest not found: $src"

  local restore_timestamp
  restore_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local archive_name="${CLICKHOUSE_BACKUP_NAME_PREFIX}-restore-${restore_timestamp}${CLICKHOUSE_ARCHIVE_EXTENSION}"
  local staged="$STAGING_DIR/$archive_name"

  echo "==> ClickHouse: staging $src (encrypted=$MANIFEST_CLICKHOUSE_ENCRYPTED)"
  if [ "$MANIFEST_CLICKHOUSE_ENCRYPTED" = "true" ]; then
    require_bin "$AGE_BIN" "Install age (macOS: 'brew install age') to decrypt this backup."
    require_env BACKUP_AGE_IDENTITY "the path to the age private key that decrypts this backup"
    [ -f "$BACKUP_AGE_IDENTITY" ] || fail "BACKUP_AGE_IDENTITY does not point to a file: $BACKUP_AGE_IDENTITY"
    "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY" -o "$staged" "$src"
  else
    cp "$src" "$staged"
  fi

  local container_id
  container_id="$(docker compose --project-directory "$ROOT_DIR" ps -q "$CLICKHOUSE_COMPOSE_SERVICE")"
  [ -n "$container_id" ] || fail "clickhouse container not found (docker compose ps -q $CLICKHOUSE_COMPOSE_SERVICE returned nothing). Is the stack up? Try: docker compose up -d $CLICKHOUSE_COMPOSE_SERVICE"

  docker cp "$staged" "${container_id}:${CLICKHOUSE_CONTAINER_BACKUP_DIR}/${archive_name}"
  rm -f "$staged"

  echo "==> ClickHouse: RESTORE DATABASE $database FROM Disk('$CLICKHOUSE_BACKUP_DISK_NAME', '$archive_name')"
  local response
  response="$(ch_query "RESTORE DATABASE ${database} FROM Disk('${CLICKHOUSE_BACKUP_DISK_NAME}', '${archive_name}')")" \
    || fail "ClickHouse RESTORE failed against $CLICKHOUSE_URL. If curl reported an auth failure ('password is incorrect'), check the IP allow-list in deploy/clickhouse/users.d/rovenue.xml before the credentials. If it reported the database already has objects, this is whole-database restore only — point CLICKHOUSE_URL/CLICKHOUSE_DATABASE at an empty database."
  echo "    $response"

  docker exec "$container_id" rm -f "${CLICKHOUSE_CONTAINER_BACKUP_DIR}/${archive_name}"

  echo "==> ClickHouse: detaching Kafka-facing objects (the dispatcher stays stopped through this whole step)"
  discover_kafka_objects "$database"
  detach_kafka_objects "$database"
  echo "    detached ${#KAFKA_TABLES[@]} Kafka table(s), ${#KAFKA_VIEWS[@]} materialized view(s)"

  # Re-attach immediately: the risk this guards against is the replay
  # window at RESTORE time (the moment the Kafka tables are created, their
  # consumer thread starts before anything can detach it) — that window is
  # already closed by the time detach above returns. Holding them detached
  # any longer only delays db:verify:clickhouse below, which checks Kafka
  # consumer state (last_poll_time, num_messages_read) and needs them
  # attached to see it. The dispatcher — the outbox's only publisher —
  # stays stopped for the rest of this script regardless, so nothing new
  # reaches the topic while verification runs.
  echo "==> ClickHouse: re-attaching Kafka-facing objects"
  attach_kafka_objects "$database"

  echo "==> ClickHouse restore complete"
}

# ---------------------------------------------------------------------------
# Guard 4: verification is part of restore, not a separate step. Row
# counts, the ClickHouse schema-drift verifier, and the asset-header check.
# ---------------------------------------------------------------------------
verify_restore() {
  require_bin "$PSQL_BIN" "Install PostgreSQL client tools."

  echo "==> Verification: row counts"
  local t count
  for t in "${ROW_COUNT_TABLES[@]}"; do
    count="$("$PSQL_BIN" -d "$DATABASE_URL" -tAc "SELECT count(*) FROM \"$t\"")"
    echo "    $t: $count"
  done

  echo "==> Verification: $DB_VERIFY_CLICKHOUSE_FILTER $DB_VERIFY_CLICKHOUSE_SCRIPT"
  CLICKHOUSE_USER="$CLICKHOUSE_BACKUP_USER" CLICKHOUSE_PASSWORD="$CLICKHOUSE_WRITE_PASSWORD" \
    "$PNPM_BIN" --filter "$DB_VERIFY_CLICKHOUSE_FILTER" "$DB_VERIFY_CLICKHOUSE_SCRIPT"

  echo "==> Verification: $ASSET_HEADERS_VERIFY_FILTER $ASSET_HEADERS_VERIFY_SCRIPT"
  "$PNPM_BIN" --filter "$ASSET_HEADERS_VERIFY_FILTER" "$ASSET_HEADERS_VERIFY_SCRIPT"
}

print_summary() {
  echo
  echo "Restore complete from: $FROM_DIR"
  echo "  postgres:   restored, $PG_RESTORE_CLEAN_FLAG $PG_RESTORE_IF_EXISTS_FLAG"
  echo "  assets:     restored into $MC_ALIAS/$ASSET_STORAGE_BUCKET"
  echo "  clickhouse: restored, Kafka objects re-attached (${#KAFKA_TABLES[@]} table(s), ${#KAFKA_VIEWS[@]} view(s))"
  echo
  echo "${COMPOSE_SERVICES_TO_STOP[*]} remain stopped. Review the verification output above,"
  echo "then bring the stack back with: docker compose --project-directory \"$ROOT_DIR\" start ${COMPOSE_SERVICES_TO_STOP[*]}"
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  load_manifest

  # Guard 1 — first, before anything is touched.
  check_fingerprint

  require_env DATABASE_URL "pg_restore needs it to connect to Postgres (see .env.example)"

  STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rovenue-restore.XXXXXX")"
  trap 'rm -rf "$STAGING_DIR"' EXIT

  # Guard 2 — stop api, dispatcher and workers before touching anything.
  stop_services

  # Guard 3 — refuse to run against a database with existing Rovenue
  # tables, unless --force. Whole-database only.
  check_existing_tables

  run_postgres_restore
  run_assets_restore
  run_clickhouse_restore

  # Guard 4 — verification is part of restore, not a separate step.
  verify_restore

  print_summary
}

main "$@"
