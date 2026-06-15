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

RUN pnpm --filter @rovenue/docs build

# =============================================================
# Runtime — Caddy serving the prerendered static site
# =============================================================
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.docs /etc/caddy/Caddyfile
COPY --from=builder /app/apps/docs/build/client /srv
EXPOSE 80
