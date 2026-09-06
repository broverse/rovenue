# Rovenue

Open-source, self-hosted subscription & credit management for mobile and web
apps — a RevenueCat / Adapty alternative you run yourself, on your own
infrastructure, over your own data. AGPL-3.0.

Beyond the core "verify a receipt, track a subscription" job, Rovenue also
covers paywalls (a cross-platform builder with native SwiftUI/Android
renderers), A/B experiments, feature flags, audiences, leaderboards, and
GDPR/KVKK export & anonymize.

## What it does

- **Subscriptions & credits.** Apple App Store Server API v2 (JWS,
  chain-pinned to Apple's root CAs), Google Play Developer API, and Stripe
  webhooks feed one subscription state machine (`TRIAL → ACTIVE →
  GRACE_PERIOD → EXPIRED | PAUSED | REFUNDED`) and an append-only credit
  ledger. Entitlements are denormalized for fast reads.
- **Paywalls.** A platform-neutral builder whose output renders three ways —
  web (`packages/paywall-renderer`), native iOS (SwiftUI), and native Android
  (Views) — from the same component tree, with an offline fallback bundled
  on-device.
- **Experiments & feature flags.** Placement-driven A/B tests with
  deterministic client-side bucketing shared between the TypeScript backend
  and the Rust SDK core, plus a Bayesian decision engine for when to call a
  winner.
- **Analytics.** Revenue, credit flow, and product analytics served from
  ClickHouse, fed via an outbox → Kafka/Redpanda pipeline (no dual-writes,
  at-least-once delivery, idempotent at query time).
- **Audiences & leaderboards**, and **GDPR/KVKK data export & anonymize** for
  every subscriber.

## Stack, at a glance

| Layer | Technology |
|---|---|
| API | Hono + TypeScript (strict) |
| Dashboard | React (Vite) |
| Docs site | Fumadocs (`apps/docs`) |
| SDK core | Rust (`librovenue`), with Swift, Kotlin, React Native, Flutter and web façades |
| Database | PostgreSQL 16 + Drizzle ORM; hot tables range-partitioned via pg_partman |
| Analytics | ClickHouse, fed via Kafka/Redpanda + a transactional outbox |
| Cache/queue | Redis + BullMQ |
| Monorepo | Turborepo + pnpm |
| Deploy | Docker Compose, Coolify-ready |

## Repository layout

```
apps/
  api/         Hono API server
  dashboard/   React dashboard (Vite)
  docs/        Fumadocs SDK/API documentation site
  landing/     Marketing site (Astro)
packages/
  core-rs/            Rust SDK core (librovenue)
  sdk-swift/          iOS façade over core-rs
  sdk-kotlin/         Android façade over core-rs
  sdk-rn/             React Native façade (hosts the native paywall renderer)
  sdk-flutter/        Flutter façade (federated Pigeon plugin)
  sdk-web/            Web SDK
  paywall-renderer/   Web renderer for builder paywalls
  db/                 Drizzle schema + Postgres/ClickHouse migrations + seed
  email-templates/    Transactional email templates
  shared/             Types, constants, cross-package utilities
deploy/
  caddy · postgres · clickhouse · cloudflare · apple-certs · minio ·
  backup · grafana/prometheus/loki/alloy (observability profile)
docker-compose.yml    Root file — the full stack
```

## Self-host quickstart

Prerequisites: Docker + Compose v2, DNS pointed at your host.

```bash
git clone https://github.com/broverse/rovenue.git && cd rovenue
cp .env.example .env
# Fill in the prod-required keys — see docs/operations/deployment.md §1.

docker compose build
docker compose up -d db redis clickhouse redpanda
docker compose run --rm migrate
docker compose up -d
```

```bash
curl -fsS https://your-host/health   # expect 200
```

This is the short version. For the full first-install walkthrough (secrets,
Apple Pay setup, image verification, self-hosted asset storage) see
[`docs/operations/deployment.md`](docs/operations/deployment.md) — or the
broader Turkish guide, [`docs/operations/deployment-rehberi.md`](docs/operations/deployment-rehberi.md).
For everything after day one — scaling, monitoring, backups, disaster
recovery, key rotation — see the
**[self-host operator handbook](docs/operations/handbook.md)**.

## Documentation

- **SDK & API docs:** [`apps/docs`](apps/docs) — installation, core concepts,
  and platform guides for iOS, Android, React Native, Flutter and web.
- **Operator handbook:** [`docs/operations/handbook.md`](docs/operations/handbook.md)
  — scaling, monitoring & alerting, capacity planning, partition maintenance,
  connection pooling, disaster recovery, and secret rotation for a
  self-hosted install.
- **Architecture notes:** [`docs/architecture/`](docs/architecture) — e.g.
  [the outbox dispatcher's delivery semantics and scaling contract](docs/architecture/outbox-dispatcher.md).
- **Runbooks:** [`docs/runbooks/`](docs/runbooks) — on-call scenarios by
  subsystem.

## Development

```bash
pnpm install
pnpm dev      # turbo run dev, all apps
pnpm build
pnpm test     # turbo run test
```

Rust core: `cargo test --workspace --all-targets`. See
[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) for commit conventions
and the expand/contract schema-change policy.

## License

[AGPL-3.0](LICENSE). Self-host it, modify it, run it for your own product —
the copyleft terms apply if you distribute a modified version as a network
service to others.
