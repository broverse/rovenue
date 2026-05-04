# Rovenue

Open-source subscription management platform for mobile & web apps. Self-host, own your data, no revenue share. RevenueCat/Adapty alternative.

## Tech Stack

- **Backend:** Hono + TypeScript
- **Auth:** Better Auth (GitHub + Google OAuth, session management)
- **Database:** PostgreSQL 16 + Drizzle ORM (declarative range partitions managed by pg_partman for hot tables)
- **Analytics:** ClickHouse (read replica fed via Kafka Engine + materialized views)
- **Streaming:** Kafka / Redpanda + transactional outbox pattern (no dual-writes)
- **Cache/Queue:** Redis + BullMQ
- **Dashboard:** React (Vite + TypeScript)
- **SDK:** React Native + TypeScript + Native Modules (StoreKit 2 / Play Billing 6)
- **Monorepo:** Turborepo + pnpm workspaces
- **Deploy:** Docker Compose (Coolify-ready)
- **License:** AGPLv3

Beyond core subscription/credit management the platform also covers experiments, feature flags, audiences, leaderboards, and GDPR/KVKK anonymize/export.

## Project Structure

rovenue/
├── apps/
│   ├── api/             → Hono API server
│   ├── dashboard/       → React SPA
│   └── docs/            → Documentation site
├── packages/
│   ├── sdk-rn/          → React Native SDK
│   ├── db/              → Drizzle schema + drizzle-kit migrations + ClickHouse migrations + seed
│   └── shared/          → Types, constants, utils
├── deploy/
│   ├── docker-compose.yml
│   └── coolify/
├── .github/
│   ├── workflows/
│   └── CONTRIBUTING.md
├── CLAUDE.md
├── LICENSE              → AGPL-3.0
└── turbo.json

## Architecture Decisions

- **Dashboard Auth:** Better Auth with GitHub + Google OAuth only (no email/password)
  - Better Auth manages user, session, account, verification tables automatically
  - Mount: `app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))`
- **SDK Auth:** Public API key (per-project) via Bearer token — no user auth needed
- **Server-to-Server Auth:** Secret API key (per-project) for webhook configuration
- Receipt verification: Apple App Store Server API v2 (JWS, chain-pinned via Apple Root CA G3 + Apple Inc Root), Google Play Developer API, Stripe Webhooks
- Subscription state machine: TRIAL → ACTIVE → GRACE_PERIOD → EXPIRED | PAUSED | REFUNDED
- Webhook processing: Idempotent (store_event_id deduplication)
- Entitlements: Denormalized subscriber_access table for fast reads
- Analytics path: Postgres → outbox → Kafka/Redpanda → ClickHouse Kafka Engine + materialized views (no dual-writes; outbox dispatcher is the single source of truth for downstream events)
- Audit log: per-project SHA-256 hash chain with `pg_advisory_xact_lock` serialisation; `audit()` runs inside the caller's Drizzle tx so the audit row commits/rolls back atomically with the domain write
- Offline SDK: MMKV cache for last-known entitlement state

## Coding Conventions

- TypeScript strict mode everywhere
- Drizzle for all Postgres access — repositories live under `packages/db/src/drizzle/repositories`; raw SQL only via `drizzle-orm`'s `sql` template when truly necessary
- Zod for API input validation
- Hono middleware pattern for auth, rate limiting, error handling
- All API responses follow: { data: T } or { error: { code, message } }
- Use barrel exports (index.ts) in each package
- Tests: Vitest for unit + integration; testcontainers for the `*.integration.test.ts` suites that hit a real Postgres / ClickHouse / Kafka
- Commit messages: conventional commits (feat:, fix:, chore:, docs:)

## Database

- PostgreSQL 16, Drizzle ORM, drizzle-kit migrations under `packages/db/drizzle/migrations`
- Hot tables (`revenue_events`, `credit_ledger`, `outgoing_webhooks`) are declarative range partitions; `pg_partman` manages premake/retention for the first two, the partition-maintenance worker handles `outgoing_webhooks`
- ClickHouse mirrors Postgres via Kafka Engine + materialized views (`packages/db/clickhouse/migrations/`) for MRR / credit balance / consumption / leaderboards
- **Auth tables (managed by Better Auth):** user, session, account, verification
- **App tables:** projects, project_members, api_keys, subscribers, products, product_groups, purchases, subscriber_access, credit_ledger, webhook_events, outgoing_webhooks, revenue_events, audiences, experiments, experiment_assignments, feature_flags, audit_logs, outbox_events
- All IDs are UUIDs (cuid2 generated); all timestamps UTC with timezone
- Encrypted store credentials use AES-256-GCM
- `credit_ledger` is append-only; `audit_logs` are append-only with a per-project SHA-256 hash chain
- `outbox_events` drives Kafka publishing — never write to a domain table and Kafka in the same code path; produce an outbox row inside the same tx and let the dispatcher emit

## Environment Variables

See `.env.example` for the canonical list. Highlights:

- DATABASE_URL — PostgreSQL connection string
- REDIS_URL — Redis connection string
- CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD — analytics replica (required in production; local dev degrades gracefully when blank)
- KAFKA_BROKERS — comma-separated host:port list for Redpanda/Kafka
- ENCRYPTION_KEY — 32-byte hex for AES-256-GCM credential encryption
- BETTER_AUTH_SECRET — Better Auth session encryption key
- BETTER_AUTH_URL — Backend URL (e.g. http://localhost:3000)
- DASHBOARD_URL — Dashboard origin (e.g. http://localhost:5173)
- GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET — GitHub OAuth credentials
- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — Google OAuth credentials
- APPLE_ROOT_CERTS_DIR — directory of Apple Root CA `.cer` files; required in production for chain-validated StoreKit JWS verification (the verifier fails closed when missing)
- PORT — API port (default 3000)
- NODE_ENV / LOG_LEVEL — runtime tuning

## Commands

- `pnpm dev` — Start all apps in dev mode
- `pnpm build` — Build all packages
- `pnpm db:migrate` — Run Drizzle migrations against Postgres
- `pnpm db:migrate:generate` — Generate a new Drizzle migration from schema
- `pnpm db:seed` — Seed development data
- `pnpm --filter @rovenue/db db:clickhouse:migrate` — Apply ClickHouse migrations
- `pnpm --filter @rovenue/db db:verify:clickhouse` — Verify ClickHouse mirror parity
- `pnpm test` — Run all tests
- `docker compose up` — Start full stack (Postgres, Redis, ClickHouse, Redpanda, api, dashboard)
