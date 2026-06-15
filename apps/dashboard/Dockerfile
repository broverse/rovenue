# syntax=docker/dockerfile:1

# =============================================================
# Builder — install workspace deps, build the Vite SPA
# =============================================================
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# VITE_API_URL is inlined into the bundle at build time (Vite reads
# import.meta.env.* during `vite build`). Override per environment:
#   docker build --build-arg VITE_API_URL=https://rovenue.io ...
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}

# Manifests first for layer caching.
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* .npmrc* ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/api/package.json ./apps/api/
COPY apps/docs/package.json ./apps/docs/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk-rn/package.json ./packages/sdk-rn/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard

RUN pnpm --filter @rovenue/dashboard exec vite build

# =============================================================
# Runtime — Caddy serving the static build
# =============================================================
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.dashboard /etc/caddy/Caddyfile
COPY --from=builder /app/apps/dashboard/dist /srv
EXPOSE 80
