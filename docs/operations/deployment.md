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
