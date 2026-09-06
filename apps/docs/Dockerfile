# syntax=docker/dockerfile:1

# =============================================================
# Builder — install workspace deps, build the docs site
# =============================================================
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# No build-time env vars needed — docs has no VITE_API_URL equivalent.

# Manifests first for layer caching.
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* .npmrc* ./
COPY apps/docs/package.json ./apps/docs/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk-rn/package.json ./packages/sdk-rn/

# fumadocs-mdx postinstall resolves source.config.ts at install time;
# copy it before pnpm install so the hook doesn't fail on a missing file.
COPY apps/docs/source.config.ts ./apps/docs/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/docs ./apps/docs

# The API explorer (apps/docs/app/components/api-explorer.tsx) fetches a
# static copy of apps/api/openapi/openapi.json at runtime, refreshed at
# build time by `pnpm --filter @rovenue/docs generate:openapi` (part of the
# `build` script below) — see scripts/copy-openapi.mjs. apps/api's own
# package.json was already copied above (for `pnpm install`'s workspace
# resolution), but not its source, so the openapi/ directory has to be
# copied explicitly here or the docs build fails loudly with a missing-file
# error rather than silently shipping a stale or absent spec.
COPY apps/api/openapi ./apps/api/openapi

# The six SDK API references (rustdoc/DocC/Dokka/TypeDoc x2/dartdoc) can't be
# generated here — DocC needs macOS+Xcode, Dokka needs a JVM, none of which
# exist in this Linux builder stage. They're generated per-SDK on a runner
# that can build each toolchain (.github/workflows/sdk-docs.yml) and must be
# placed under apps/docs/public/api/<sdk>/ in the build context, by whoever
# invokes `docker build`, BEFORE this stage runs — `public/` is copied
# verbatim (not prerendered) by the `COPY apps/docs ./apps/docs` above, so by
# this point the six directories are either already here or they never will
# be. Fail loudly and by name rather than silently shipping a docs site that
# 404s (or worse, silently serves the SPA shell) under /api/<sdk>/.
RUN set -eu; \
    missing=""; \
    for sdk in core-rs sdk-swift sdk-kotlin sdk-rn sdk-web sdk-flutter; do \
      if [ ! -f "apps/docs/public/api/$sdk/index.html" ]; then \
        missing="$missing $sdk"; \
      fi; \
    done; \
    if [ -n "$missing" ]; then \
      echo "ERROR: missing generated SDK reference(s):$missing" >&2; \
      echo "Expected apps/docs/public/api/<sdk>/index.html for each of: core-rs sdk-swift sdk-kotlin sdk-rn sdk-web sdk-flutter" >&2; \
      echo "Run 'pnpm docs:sdk-ref' (or download the sdk-docs.yml CI artifacts) and place the" >&2; \
      echo "output under apps/docs/public/api/<sdk>/ before building this image." >&2; \
      exit 1; \
    fi

RUN pnpm --filter @rovenue/docs build

# =============================================================
# Runtime — Caddy serving the prerendered static site
# =============================================================
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.docs /etc/caddy/Caddyfile
COPY --from=builder /app/apps/docs/build/client /srv
EXPOSE 80
