# syntax=docker/dockerfile:1

# =============================================================
# Base — Node 20 Alpine with pnpm via corepack
# =============================================================
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# =============================================================
# Deps — install all workspace dependencies
# =============================================================
FROM base AS deps

# Copy root manifests + workspace package manifests for layer caching
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* .npmrc* ./
COPY apps/api/package.json ./apps/api/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/docs/package.json ./apps/docs/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk-rn/package.json ./packages/sdk-rn/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install

# =============================================================
# Builder — copy sources
# =============================================================
FROM deps AS builder

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# =============================================================
# Runtime — slim image running the api via tsx
# =============================================================
FROM base AS runtime

RUN addgroup -S rovenue && adduser -S rovenue -G rovenue

COPY --from=builder --chown=rovenue:rovenue /app /app

USER rovenue

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["pnpm", "--filter", "@rovenue/api", "exec", "tsx", "src/index.ts"]
