#!/bin/sh
# =============================================================
# Dashboard container entrypoint
# =============================================================
#
# Caddy serves /config.js by substituting {$ROVENUE_*} into a JS literal
# (deploy/caddy/Caddyfile.dashboard). That substitution is TEXTUAL — Caddy
# does no JSON escaping — so a value containing a quote would emit a broken
# config.js and the dashboard would fail to boot with a syntax error and no
# explanation of where it came from.
#
# Validating here converts that into a container that refuses to start and
# names the offending variable.
set -eu

HOST_MODE_VALUES="self cloud"
BOOL_VALUES="true false"

fail() {
	echo "dashboard entrypoint: $1" >&2
	exit 1
}

# Rejects the characters that would break out of the JS string literal, plus
# anything non-printable. Applied to every value regardless of its own rule.
check_safe() {
	name="$1"
	value="$2"
	case "$value" in
	*'"'* | *'\'* | *'`'* | *'$'*) fail "$name contains a character that cannot be embedded in config.js" ;;
	*[![:print:]]*) fail "$name contains a non-printable character" ;;
	esac
}

check_absolute_url() {
	name="$1"
	value="$2"
	[ -z "$value" ] && return 0
	check_safe "$name" "$value"
	case "$value" in
	http://* | https://*) return 0 ;;
	*) fail "$name must be an absolute http(s) URL, got: $value" ;;
	esac
}

check_enum() {
	name="$1"
	value="$2"
	allowed="$3"
	[ -z "$value" ] && return 0
	check_safe "$name" "$value"
	for candidate in $allowed; do
		[ "$value" = "$candidate" ] && return 0
	done
	fail "$name must be one of: $allowed — got: $value"
}

check_absolute_url ROVENUE_API_URL "${ROVENUE_API_URL:-}"
check_absolute_url ROVENUE_DASHBOARD_HOST "${ROVENUE_DASHBOARD_HOST:-}"
check_enum ROVENUE_HOST_MODE "${ROVENUE_HOST_MODE:-}" "$HOST_MODE_VALUES"
check_enum ROVENUE_ALLOW_REGISTRATION "${ROVENUE_ALLOW_REGISTRATION:-}" "$BOOL_VALUES"

# Exercised by apps/dashboard/tests/entrypoint.test.ts.
if [ -n "${VALIDATE_ONLY:-}" ]; then
	echo "ok"
	exit 0
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
