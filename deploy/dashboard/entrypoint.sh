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
#
# No `pipefail`: this is POSIX sh (not bash), where `pipefail` does not
# exist, and the script has no pipelines for it to guard anyway.
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
	# shellcheck disable=SC1003  # *'\'* is a literal backslash pattern, not an escape mistake
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

# ROVENUE_DASHBOARD_HOST is consumed by apps/dashboard/src/lib/custom-host.ts,
# which normalises with `host.split(":")[0]` — a bare hostname, not a URL
# (see .env.example's VITE_DASHBOARD_HOST=app.rovenue.io and
# custom-host.test.ts). A scheme prefix would normalise to "https" and could
# never match window.location.hostname, silently disabling canonical-host
# detection, so it is rejected here rather than accepted and misread later.
check_host() {
	name="$1"
	value="$2"
	[ -z "$value" ] && return 0
	check_safe "$name" "$value"
	case "$value" in
	*'://'*) fail "$name must be a bare hostname (optionally with :port), not a URL — got: $value" ;;
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
check_host ROVENUE_DASHBOARD_HOST "${ROVENUE_DASHBOARD_HOST:-}"
check_enum ROVENUE_HOST_MODE "${ROVENUE_HOST_MODE:-}" "$HOST_MODE_VALUES"
check_enum ROVENUE_ALLOW_REGISTRATION "${ROVENUE_ALLOW_REGISTRATION:-}" "$BOOL_VALUES"

# apps/dashboard/Dockerfile bakes ARG VITE_API_URL=http://localhost:3000 into
# every image as the from-source-build default, and runtime-config.ts falls
# back to it when /config.js resolves to "". That fallback is correct for a
# from-source build, but a PUBLISHED image that boots with ROVENUE_API_URL
# unset would start cleanly and silently talk to localhost — the exact
# silent first-paint failure this container's validation exists to prevent.
# ROVENUE_REQUIRE_RUNTIME_CONFIG=1 is baked in at build time (release images
# only, see .github/workflows/release-images.yml) to turn that into a
# refuse-to-start instead.
if [ -n "${ROVENUE_REQUIRE_RUNTIME_CONFIG:-}" ] && [ -z "${ROVENUE_API_URL:-}" ]; then
	fail "ROVENUE_API_URL is required (this image was built with ROVENUE_REQUIRE_RUNTIME_CONFIG)"
fi

# Exercised by apps/dashboard/tests/entrypoint.test.ts.
if [ -n "${VALIDATE_ONLY:-}" ]; then
	echo "ok"
	exit 0
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
