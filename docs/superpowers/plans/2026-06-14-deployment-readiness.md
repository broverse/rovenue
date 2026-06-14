# Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four blockers that prevent a clean production deploy of Rovenue — the dashboard SPA has no production serving path, database migrations are not run on deploy, CI is disabled, and the single-outbox-dispatcher contract is not enforced in compose — plus wire the Apple-root-certs mount and write an operator runbook.

**Architecture:** Six independent tasks against the Docker Compose / Caddy / GitHub Actions deploy surface. **Task 1+2** add a self-contained dashboard image (Vite build → Caddy static server) and route it at `app.rovenue.app` through the existing edge Caddy. **Task 3** adds a one-shot `migrate` compose service that runs Drizzle + ClickHouse migrations and gates `api`/workers on its successful completion. **Task 4** re-enables the CI workflow. **Task 5** hardens the single-dispatcher contract by setting `OUTBOX_DISPATCHER_ENABLED=false` on every worker and adding a guard test. **Task 6** mounts the Apple root certs and writes the deploy runbook. Each task produces an independently shippable change; one commit per task.

**Tech Stack:** Docker Compose v2 (`depends_on` conditions, `service_completed_successfully`), multi-stage Dockerfiles (Node 20 Alpine + `caddy:2-alpine`), Caddy 2.x static `file_server` with SPA fallback, Vite 5 (build-time `VITE_API_URL` inlining), GitHub Actions, Vitest, `pnpm --filter` workspace scripts.

**Key constraints discovered during planning:**
- Vite inlines `import.meta.env.VITE_API_URL` **at build time** (dashboard reads it in `src/lib/api.ts:5`, `src/lib/auth.ts:4`, and 8 more places). So the dashboard image needs `VITE_API_URL` as a **build ARG**, not a runtime env var.
- The Caddyfile wildcard `rovenue.app, *.rovenue.app, edge.rovenue.app` currently proxies **everything** to `api:3000`. An explicit `app.rovenue.app` site block takes precedence over the wildcard in Caddy (most-specific-host wins), so the dashboard route must be a dedicated block — and `app.rovenue.app` must be added to `CANONICAL_HOSTS` so the api's `/internal/domains/check` ask-endpoint allows its cert.
- `OUTBOX_DISPATCHER_ENABLED` is read once in `apps/api/src/index.ts:255`. All five services (`api` + 4 workers) inherit it from `.env` via `env_file`. The contract (see `docs/architecture/outbox-dispatcher.md`) is **exactly one** dispatcher; workers must override it to `false` and `api` must stay `replicas: 1`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/dashboard/Dockerfile` | Build SPA, serve static via Caddy with SPA fallback | Create |
| `apps/dashboard/.dockerignore` | Keep `node_modules`/`dist` out of build context | Create |
| `deploy/caddy/Caddyfile.dashboard` | Static-server Caddyfile baked into the dashboard image | Create |
| `docker-compose.yml` | Add `dashboard` + `migrate` services; gate `api`/workers; pin dispatcher | Modify |
| `deploy/caddy/Caddyfile` | Add `app.rovenue.app` → `dashboard:80` site block | Modify |
| `.github/workflows/ci.yml` | Re-enable CI (rename from `.disabled`) | Create (rename) |
| `apps/api/src/lib/env.ts` | Already parses `OUTBOX_DISPATCHER_ENABLED` — add a guard test only | (test only) |
| `apps/api/src/workers/dispatcher-guard.test.ts` | Assert workers run with dispatcher disabled | Create |
| `docs/operations/deployment.md` | End-to-end operator runbook | Create |
| `.env.example` | Add `VITE_API_URL`, `APPLE_ROOT_CERTS_DIR`, `CANONICAL_HOSTS` with `app.` host | Modify |

---

# Task 1: Dashboard production image (build + static serve)

**Problem:** `apps/dashboard` has no `Dockerfile`, no compose service, and the api does not serve the built SPA (`serveStatic` = 0 hits). The React dashboard has no production serving path at all.

**Fix:** A multi-stage image: stage 1 builds the Vite SPA (`pnpm --filter @rovenue/dashboard build`) with `VITE_API_URL` injected as a build ARG; stage 2 is `caddy:2-alpine` serving `/srv` with a SPA `try_files` fallback.

**Files:**
- Create: `apps/dashboard/Dockerfile`
- Create: `apps/dashboard/.dockerignore`
- Create: `deploy/caddy/Caddyfile.dashboard`

- [ ] **Step 1: Write the static-server Caddyfile**

Create `deploy/caddy/Caddyfile.dashboard`:

```caddyfile
# Static file server for the built dashboard SPA. Baked into the
# dashboard image and run on :80 inside the docker network; the edge
# Caddy (deploy/caddy/Caddyfile) reverse-proxies app.rovenue.app here.
:80 {
	root * /srv
	encode zstd gzip
	# SPA fallback: serve index.html for any path that is not a real
	# file, so TanStack Router client routes resolve on hard refresh.
	try_files {path} /index.html
	file_server
	# Long-cache fingerprinted assets; never cache index.html.
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	header /index.html Cache-Control "no-cache"
}
```

- [ ] **Step 2: Write the dashboard Dockerfile**

Create `apps/dashboard/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# =============================================================
# Builder — install workspace deps, build the Vite SPA
# =============================================================
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# VITE_API_URL is inlined into the bundle at build time (Vite reads
# import.meta.env.* during `vite build`). Override per environment:
#   docker build --build-arg VITE_API_URL=https://rovenue.app ...
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

RUN pnpm --filter @rovenue/dashboard build

# =============================================================
# Runtime — Caddy serving the static build
# =============================================================
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.dashboard /etc/caddy/Caddyfile
COPY --from=builder /app/apps/dashboard/dist /srv
EXPOSE 80
```

- [ ] **Step 3: Write the .dockerignore**

Create `apps/dashboard/.dockerignore`:

```
node_modules
dist
.turbo
*.log
```

- [ ] **Step 4: Verify the image builds and serves the SPA**

Run:

```bash
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_API_URL=https://rovenue.app \
  -t rovenue-dashboard:test .
docker run -d --name dash-test -p 8088:80 rovenue-dashboard:test
sleep 2
curl -fsS http://localhost:8088/ | grep -q '<div id="root"' && echo "INDEX OK"
# SPA fallback: a client route must also return index.html (200, not 404)
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:8088/projects/abc/overview
docker rm -f dash-test
```

Expected: `INDEX OK` printed, and the second curl prints `200`.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/Dockerfile apps/dashboard/.dockerignore deploy/caddy/Caddyfile.dashboard
git commit -m "feat(deploy): production dashboard image (vite build + caddy static serve)"
```

---

# Task 2: Wire dashboard into compose + edge Caddy route

**Problem:** Even with an image, nothing runs the dashboard container or routes traffic to it.

**Fix:** Add a `dashboard` compose service built from Task 1, and an explicit `app.rovenue.app` site block in the edge Caddyfile that proxies to it. Add `app.rovenue.app` to `CANONICAL_HOSTS` so the ask-endpoint authorizes its cert.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `deploy/caddy/Caddyfile`
- Modify: `.env.example`

- [ ] **Step 1: Add the `dashboard` service to compose**

In `docker-compose.yml`, add this service immediately after the `caddy:` block (before `# --- Notification pipeline workers ---`):

```yaml
  # Dashboard SPA — built by apps/dashboard/Dockerfile, served as static
  # files by an in-image Caddy on :80. The edge Caddy proxies
  # app.rovenue.app here. VITE_API_URL is baked at build time and must
  # point at the PUBLIC api origin (not the docker-internal name).
  dashboard:
    build:
      context: .
      dockerfile: apps/dashboard/Dockerfile
      args:
        VITE_API_URL: ${VITE_API_URL:-http://localhost:3000}
    restart: unless-stopped
    # No published ports — only the edge Caddy reaches it on the
    # docker network. Exposed container port is 80.
    expose:
      - "80"
```

- [ ] **Step 2: Make the edge Caddy depend on the dashboard**

In `docker-compose.yml`, in the `caddy:` service `depends_on:` block, add the dashboard so Caddy starts after it:

```yaml
    depends_on:
      api:
        condition: service_started
      dashboard:
        condition: service_started
```

(Replace the existing `caddy` `depends_on:` block — which currently lists only `api` — with the two-entry block above.)

- [ ] **Step 3: Add the dashboard site block to the edge Caddyfile**

In `deploy/caddy/Caddyfile`, add this block **immediately before** the canonical `rovenue.app, *.rovenue.app, edge.rovenue.app {` block. A specific host wins over the wildcard, so this must be its own block:

```caddyfile
# -------------------------------------------------------------
# Dashboard SPA — explicit host, proxied to the static-serving
# dashboard container. Must precede the *.rovenue.app wildcard
# (which targets the api); most-specific host wins in Caddy.
# -------------------------------------------------------------
app.rovenue.app {
	encode zstd gzip
	reverse_proxy dashboard:80
}
```

- [ ] **Step 4: Authorize the dashboard host for cert issuance**

In `docker-compose.yml`, update the `api` service `CANONICAL_HOSTS` default so the `/internal/domains/check` ask-endpoint allows `app.rovenue.app`:

```yaml
      CANONICAL_HOSTS: ${CANONICAL_HOSTS:-rovenue.app,edge.rovenue.app,app.rovenue.app}
```

- [ ] **Step 5: Document the new env vars**

In `.env.example`, add below the `DASHBOARD_URL=` line (line 52):

```bash
# Public origin the dashboard SPA calls (baked into the bundle at
# docker build time). In production this is the api's public URL.
VITE_API_URL=http://localhost:3000
```

And update the `DASHBOARD_URL` line's comment context — set the production example to the dashboard host:

```bash
DASHBOARD_URL=http://localhost:5173
# Production: DASHBOARD_URL=https://app.rovenue.app
```

- [ ] **Step 6: Verify compose config resolves**

Run:

```bash
docker compose config >/dev/null && echo "COMPOSE CONFIG VALID"
docker compose config | grep -A2 'app.rovenue.app' || true
docker compose config | grep -q 'rovenue-dashboard\|dashboard:' && echo "DASHBOARD SERVICE PRESENT"
```

Expected: `COMPOSE CONFIG VALID` and `DASHBOARD SERVICE PRESENT` both print; no YAML errors.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml deploy/caddy/Caddyfile .env.example
git commit -m "feat(deploy): serve dashboard at app.rovenue.app via edge caddy"
```

---

# Task 3: Run migrations on deploy (one-shot migrate service)

**Problem:** Nothing runs `db:migrate` or `db:clickhouse:migrate` on deploy. The api boots against an un-migrated database.

**Fix:** A one-shot `migrate` service built from the api image that runs both migration scripts then exits. `api` and all four workers gain `depends_on: migrate: condition: service_completed_successfully` so they never start against an un-migrated DB.

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the one-shot `migrate` service**

In `docker-compose.yml`, add this service immediately before the `api:` service block:

```yaml
  # One-shot migration runner. Applies Drizzle (Postgres) then
  # ClickHouse migrations, then exits 0. api + workers gate on its
  # successful completion so nothing serves an un-migrated schema.
  migrate:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-rovenue}:${POSTGRES_PASSWORD:-rovenue}@db:5432/${POSTGRES_DB:-rovenue}
      CLICKHOUSE_URL: http://clickhouse:8123
    command:
      - sh
      - -c
      - >
        pnpm --filter @rovenue/db db:migrate &&
        pnpm --filter @rovenue/db db:clickhouse:migrate
    depends_on:
      db:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
    restart: "no"
```

- [ ] **Step 2: Gate `api` on migration completion**

In `docker-compose.yml`, in the `api` service `depends_on:` block, add the migrate gate as the first entry:

```yaml
    depends_on:
      migrate:
        condition: service_completed_successfully
      db:
        condition: service_healthy
      redis:
        condition: service_started
      clickhouse:
        condition: service_healthy
      redpanda:
        condition: service_healthy
```

- [ ] **Step 3: Gate the four workers on migration completion**

For each of `notifier-worker`, `digest-scheduler`, `send-email-worker`, `send-push-worker` in `docker-compose.yml`, ensure each has a `depends_on:` with:

```yaml
    depends_on:
      migrate:
        condition: service_completed_successfully
```

(Merge with any existing `depends_on` entries on those services; add the `migrate` condition without removing existing ones.)

- [ ] **Step 4: Verify the gate is wired and migrate runs to completion**

Run:

```bash
docker compose config >/dev/null && echo "COMPOSE CONFIG VALID"
# Bring up only the data plane + migrate; assert migrate exits 0.
docker compose up -d db clickhouse
docker compose run --rm migrate && echo "MIGRATE EXIT OK"
docker compose down
```

Expected: `COMPOSE CONFIG VALID`, the migrate command logs Drizzle + ClickHouse migrations applied, and `MIGRATE EXIT OK` prints (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(deploy): one-shot migrate service gates api + workers on schema migration"
```

---

# Task 4: Re-enable CI

> **DEFERRED (2026-06-14):** A naive rename makes CI red. `pnpm build` runs `tsc` in three packages that have **~31 pre-existing type errors** (`@rovenue/dashboard` 12, `@rovenue/db` 10, `@rovenue/api` 9 — only ~4 are trivial unused-import `TS6133`; the rest are real type mismatches: `TS2740/2345/7053/2367/...`). CI was almost certainly disabled for this reason. Re-enabling it requires either fixing those errors first or scoping CI to a green subset — a separate effort tracked outside this plan. Tasks 1–3, 5, 6 shipped without it.

**Problem:** `.github/workflows/ci.yml.disabled` means no automated build/test gate runs on push or PR.

**Fix:** Restore the workflow file. Keep the existing `install → build → test` job; the `*.integration.test.ts` suites use testcontainers, which work on `ubuntu-latest` (Docker preinstalled).

**Files:**
- Create (rename): `.github/workflows/ci.yml`

- [ ] **Step 1: Rename the disabled workflow back into place**

Run:

```bash
git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml
```

- [ ] **Step 2: Verify the workflow is valid YAML and picked up**

Run:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('CI YAML VALID')"
test -f .github/workflows/ci.yml && echo "CI ENABLED"
```

Expected: `CI YAML VALID` and `CI ENABLED` both print.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: re-enable build + test workflow on push and PR"
```

---

# Task 5: Enforce the single-outbox-dispatcher contract

**Problem:** `OUTBOX_DISPATCHER_ENABLED` is inherited from `.env` by all five services. If two processes enable it, ClickHouse revenue aggregates double-count (see `docs/architecture/outbox-dispatcher.md`). The four workers must never dispatch; only `api` (pinned to one replica) may.

**Fix:** Set `OUTBOX_DISPATCHER_ENABLED: "false"` explicitly on every worker (overrides `.env`), and pin `api` to `replicas: 1` with a comment. Add a guard test asserting worker processes start with the dispatcher disabled.

**Files:**
- Modify: `docker-compose.yml`
- Create: `apps/api/src/workers/dispatcher-guard.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `apps/api/src/workers/dispatcher-guard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The single-dispatcher contract: exactly one process may run the
// outbox dispatcher. In compose, every worker MUST override
// OUTBOX_DISPATCHER_ENABLED to "false" so it can never double-dispatch.
const WORKERS = [
  "notifier-worker",
  "digest-scheduler",
  "send-email-worker",
  "send-push-worker",
];

describe("single-dispatcher contract (compose)", () => {
  const compose = readFileSync(
    join(__dirname, "../../../../docker-compose.yml"),
    "utf8",
  );

  it.each(WORKERS)(
    "%s declares OUTBOX_DISPATCHER_ENABLED: \"false\"",
    (worker) => {
      // Slice the service block from its header to the next top-level
      // service (two-space-indented `name:`), then assert the override.
      const start = compose.indexOf(`\n  ${worker}:`);
      expect(start, `${worker} service missing`).toBeGreaterThan(-1);
      const rest = compose.slice(start + 1);
      const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
      const block = next === -1 ? rest : rest.slice(0, next);
      expect(block).toMatch(/OUTBOX_DISPATCHER_ENABLED:\s*["']?false["']?/);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/dispatcher-guard.test.ts`
Expected: FAIL — workers do not yet declare `OUTBOX_DISPATCHER_ENABLED: "false"`.

- [ ] **Step 3: Add the override to every worker**

In `docker-compose.yml`, in the `environment:` block of each of `notifier-worker`, `digest-scheduler`, `send-email-worker`, `send-push-worker`, add:

```yaml
      # Single-dispatcher contract: only `api` runs the outbox
      # dispatcher. Workers MUST keep this false or CH aggregates
      # double-count. See docs/architecture/outbox-dispatcher.md.
      OUTBOX_DISPATCHER_ENABLED: "false"
```

- [ ] **Step 4: Pin the api to one replica with a contract comment**

In `docker-compose.yml`, in the `api` service, add below `restart: unless-stopped`:

```yaml
    # The outbox dispatcher runs in-process here (OUTBOX_DISPATCHER_ENABLED
    # from .env). It MUST be a single instance — do not raise replicas
    # without first moving the dispatcher to a dedicated 1-replica worker.
    deploy:
      replicas: 1
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/dispatcher-guard.test.ts`
Expected: PASS — all four workers matched.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml apps/api/src/workers/dispatcher-guard.test.ts
git commit -m "fix(deploy): enforce single outbox dispatcher (workers disabled, api pinned to 1)"
```

---

# Task 6: Apple root certs mount + deployment runbook

**Problem:** `APPLE_ROOT_CERTS_DIR` is required in production (the StoreKit JWS verifier fails closed without it), but nothing mounts the `.cer` files into the api/migrate/worker containers. And there is no end-to-end deploy runbook.

**Fix:** Mount a host certs directory read-only into the api and worker services and point `APPLE_ROOT_CERTS_DIR` at it. Write `docs/operations/deployment.md` capturing the full first-deploy sequence.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Create: `docs/operations/deployment.md`

- [ ] **Step 1: Mount the certs dir into api + workers**

In `docker-compose.yml`, add to the `api` service (and each worker that verifies receipts — at minimum `api`) a volume mount and env var. Add to the `api` `environment:` block:

```yaml
      APPLE_ROOT_CERTS_DIR: /etc/rovenue/apple-certs
```

And add a `volumes:` block to the `api` service:

```yaml
    volumes:
      - ${APPLE_ROOT_CERTS_HOST_DIR:-./deploy/apple-certs}:/etc/rovenue/apple-certs:ro
```

- [ ] **Step 2: Document the certs env in .env.example**

In `.env.example`, update the `APPLE_ROOT_CERTS_DIR` area (or add if absent):

```bash
# Host directory holding Apple Root CA .cer files (Apple Root CA G3 +
# Apple Inc Root). Mounted read-only into the api at
# /etc/rovenue/apple-certs. REQUIRED in production — the StoreKit JWS
# verifier fails closed when missing.
APPLE_ROOT_CERTS_HOST_DIR=./deploy/apple-certs
APPLE_ROOT_CERTS_DIR=/etc/rovenue/apple-certs
```

- [ ] **Step 3: Write the deployment runbook**

Create `docs/operations/deployment.md`:

```markdown
# Rovenue Deployment Runbook

Production deploy via Docker Compose (Coolify-ready). All commands run
from the repo root on the host.

## 0. Prerequisites
- Docker + Compose v2.
- DNS A records for `rovenue.app`, `edge.rovenue.app`, `app.rovenue.app`
  pointing at the host. CNAMEs for any custom domains pointing the same.
- Apple Root CA `.cer` files placed in `./deploy/apple-certs/`
  (Apple Root CA G3 + Apple Inc Root).

## 1. Secrets
Copy `.env.example` to `.env` and fill, at minimum, the prod-required keys
(enforced by `apps/api/src/lib/env.ts`):
`DATABASE_URL`, `ENCRYPTION_KEY` (32-byte hex), `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `DASHBOARD_URL=https://app.rovenue.app`,
`VITE_API_URL=https://rovenue.app`, `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`, `CLICKHOUSE_*`, `KAFKA_BROKERS`,
`TLS_EMAIL`, `CANONICAL_HOSTS=rovenue.app,edge.rovenue.app,app.rovenue.app`,
`OUTBOX_DISPATCHER_ENABLED=true`.

## 2. Build
    docker compose build

## 3. Data plane + migrations
The `migrate` service runs automatically before `api`/workers, but you can
run it explicitly the first time:
    docker compose up -d db redis clickhouse redpanda
    docker compose run --rm migrate

## 4. Start everything
    docker compose up -d
`api` and the four workers wait for `migrate` to exit 0.

## 5. (Optional) Seed dev data
    docker compose run --rm migrate pnpm --filter @rovenue/db seed

## 6. Smoke test
    curl -fsS https://rovenue.app/health
    curl -fsS -o /dev/null -w '%{http_code}\n' https://app.rovenue.app/
Expected: health 200, dashboard 200.

## Invariants
- **Single dispatcher:** only `api` has `OUTBOX_DISPATCHER_ENABLED=true`
  and stays `replicas: 1`. Workers force it `false`. Two dispatchers
  double-count ClickHouse revenue aggregates.
  See `docs/architecture/outbox-dispatcher.md`.
- **Persist `caddy-data`:** losing it re-issues every TLS cert and risks
  Let's Encrypt rate limits.
- **`VITE_API_URL` is build-time:** changing the api origin requires
  rebuilding the `dashboard` image (`docker compose build dashboard`).

## Rollback
    docker compose down       # keeps named volumes (data safe)
    git checkout <prev-tag> && docker compose up -d --build
Migrations are forward-only; roll back code, not schema.
```

- [ ] **Step 4: Verify compose still resolves and the runbook exists**

Run:

```bash
docker compose config >/dev/null && echo "COMPOSE CONFIG VALID"
test -f docs/operations/deployment.md && echo "RUNBOOK PRESENT"
```

Expected: both lines print.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example docs/operations/deployment.md
git commit -m "feat(deploy): mount apple root certs + add deployment runbook"
```

---

## Self-Review Notes

- **Blocker coverage:** dashboard serving (Tasks 1–2), migration automation (Task 3), CI (Task 4), single-dispatcher (Task 5), Apple certs + runbook (Task 6). All four original blockers + two hardening items covered.
- **Build-time vs runtime env:** `VITE_API_URL` is a build ARG in Task 1 and a compose `build.args` value in Task 2 — consistent. The runbook (Task 6) re-states it is build-time.
- **Caddy precedence:** Task 2 places `app.rovenue.app` before the wildcard and adds it to `CANONICAL_HOSTS` (Task 2 Step 4) so the ask-endpoint authorizes its cert — consistent across both edits.
- **Out of scope (note for operator):** compiling the api to JS instead of running `tsx src/index.ts` in prod, and adding a `deploy/coolify/` descriptor, are deferred; they are optimizations, not deploy blockers.
```