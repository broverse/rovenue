# syntax=docker/dockerfile:1

# =============================================================
# Builder — install workspace deps, build the Vite SPA
# =============================================================
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Vite inlines import.meta.env.VITE_* at build time (during `vite build`),
# NOT at runtime — so these MUST be passed as build args. A runtime env_file
# (as the API uses) does nothing for a static client bundle. Override per
# environment, e.g.:
#   docker build --build-arg VITE_API_URL=https://rovenue.io \
#                --build-arg VITE_HOST_MODE=cloud ...
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}

# Deployment mode flags, mirrored from the API's HOST_MODE/ALLOW_REGISTRATION.
# Self-host leaves the default (self); Rovenue Cloud builds with cloud.
# Without these the bundle falls back to "self" and a cloud dashboard would
# hide all billing/upgrade UI and wrongly expose BYOK.
ARG VITE_HOST_MODE=self
ENV VITE_HOST_MODE=${VITE_HOST_MODE}
ARG VITE_ALLOW_REGISTRATION
ENV VITE_ALLOW_REGISTRATION=${VITE_ALLOW_REGISTRATION}

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
