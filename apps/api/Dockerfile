# syntax=docker/dockerfile:1

# =============================================================
# Base — Node 22 Alpine with pnpm via corepack
# =============================================================
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# =============================================================
# Deps — install ALL workspace dependencies (dev + prod).
# Layer-cached on manifest + lockfile changes only.
# --ignore-scripts prevents workspace postinstalls (fumadocs-mdx
# etc.) that need source files not present in this stage.
# =============================================================
FROM base AS deps

COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* .npmrc* ./
COPY apps/api/package.json ./apps/api/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/docs/package.json ./apps/docs/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk-rn/package.json ./packages/sdk-rn/
COPY packages/email-templates/package.json ./packages/email-templates/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# =============================================================
# Builder — compile TypeScript to dist/ for api + all workspace
# packages imported at runtime (db, shared, email-templates).
# After building, patch workspace package.json files so that
# `pnpm deploy` (below) creates a runtime-loadable output:
# workspace packages point main/exports to dist/ (compiled JS)
# rather than src/ (TypeScript source, which node cannot load).
# =============================================================
FROM deps AS builder

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# Build workspace packages first so dist/ is ready for deploy
RUN pnpm --filter @rovenue/shared build && \
    pnpm --filter @rovenue/db build && \
    pnpm --filter @rovenue/email-templates build && \
    pnpm --filter @rovenue/api build

# Patch workspace package.json files: redirect main + exports to
# dist/ so node can load them without tsx. The changes are
# local to this build stage and do not affect source files.
RUN node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';
const pkgMap = {
  '@rovenue/db':              '/app/packages/db',
  '@rovenue/shared':          '/app/packages/shared',
  '@rovenue/email-templates': '/app/packages/email-templates',
};
for (const [name, dir] of Object.entries(pkgMap)) {
  const pkgPath = dir + '/package.json';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.main = './dist/index.js';
  if (pkg.types) pkg.types = './dist/index.d.ts';
  if (pkg.exports) {
    for (const [, val] of Object.entries(pkg.exports)) {
      if (typeof val === 'object') {
        for (const cond of Object.keys(val)) {
          const p = val[cond];
          if (typeof p === 'string' && p.startsWith('./src/')) {
            val[cond] = p.replace('./src/', './dist/').replace(/\.ts$/, '.js');
          }
        }
      }
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  process.stdout.write('Patched ' + name + ' -> main: ' + pkg.main + '\n');
}
EOF

# Create a self-contained production deployment directory.
# pnpm deploy copies the api package + its production
# node_modules (no devDependencies) into /app/prod.
# Workspace packages (@rovenue/*) are copied as real directories
# (not symlinks) with their dist/ output and patched package.json.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @rovenue/api deploy --prod --ignore-scripts /app/prod && \
    # Remove vitest — included only because better-auth declares it as an
    # optional peer dep; the API never imports vitest at runtime.
    rm -rf /app/prod/node_modules/vitest \
            /app/prod/node_modules/.bin/vitest \
            /app/prod/node_modules/.bin/vite \
            /app/prod/node_modules/.pnpm/vitest@* 2>/dev/null || true

# =============================================================
# Runtime — minimal image: prod node_modules + compiled JS only.
# tsx / vitest / testcontainers are NOT present (F12).
# =============================================================
FROM base AS runtime

RUN addgroup -S rovenue && adduser -S rovenue -G rovenue

COPY --from=builder --chown=rovenue:rovenue /app/prod /app
# email-templates locales are loaded at runtime via readdirSync relative to the
# bundle location: join(fileURLToPath(new URL('.', import.meta.url)), '..', 'locales')
# = join('/app/dist', '..', 'locales') = /app/locales — copy them explicitly.
COPY --from=builder --chown=rovenue:rovenue /app/packages/email-templates/locales /app/locales

USER rovenue

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# pnpm deploy flattens the package into /app (the api package root).
# dist/index.js is the compiled API entry point.
CMD ["node", "/app/dist/index.js"]
