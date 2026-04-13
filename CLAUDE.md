# Rovenue

Open-source subscription management platform for mobile & web apps. Self-host, own your data, no revenue share. RevenueCat/Adapty alternative.

## Tech Stack

- **Backend:** Hono + TypeScript
- **Auth:** Better Auth (GitHub + Google OAuth, session management)
- **Database:** PostgreSQL + Prisma ORM
- **Cache/Queue:** Redis + BullMQ
- **Dashboard:** React (Vite + TypeScript)
- **SDK:** React Native + TypeScript + Native Modules (StoreKit 2 / Play Billing 6)
- **Monorepo:** Turborepo + pnpm workspaces
- **Deploy:** Docker Compose (Coolify-ready)
- **License:** AGPLv3

## Project Structure

rovenue/
├── apps/
│   ├── api/             → Hono API server
│   ├── dashboard/       → React SPA
│   └── docs/            → Documentation site
├── packages/
│   ├── sdk-rn/          → React Native SDK
│   ├── db/              → Prisma schema + migrations + seed
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
  - Better Auth manages user, session, account tables automatically
  - `npx @better-auth/cli generate` generates Prisma schema for auth tables
  - Mount: `app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))`
- **SDK Auth:** Public API key (per-project) via Bearer token — no user auth needed
- **Server-to-Server Auth:** Secret API key (per-project) for webhook configuration
- Receipt verification: Apple App Store Server API v2 (JWS), Google Play Developer API, Stripe Webhooks
- Subscription state machine: TRIAL → ACTIVE → GRACE_PERIOD → EXPIRED | PAUSED | REFUNDED
- Webhook processing: Idempotent (store_event_id deduplication)
- Entitlements: Denormalized subscriber_entitlements table for fast reads
- Offline SDK: MMKV cache for last-known entitlement state

## Coding Conventions

- TypeScript strict mode everywhere
- Prisma for all DB access — no raw SQL unless absolutely necessary
- Zod for API input validation
- Hono middleware pattern for auth, rate limiting, error handling
- All API responses follow: { data: T } or { error: { code, message } }
- Use barrel exports (index.ts) in each package
- Tests: Vitest for unit, Supertest for API integration
- Commit messages: conventional commits (feat:, fix:, chore:, docs:)

## Database

- PostgreSQL 16
- Prisma ORM with prisma migrate
- **Auth tables (managed by Better Auth):** user, session, account (auto-generated)
- **App tables (simplified — Product = ne, ProductGroup = nasıl):**
  - project_members, api_keys, projects, subscribers
  - products (includes entitlementKeys[], creditAmount)
  - product_groups (includes products JSON array with order/promoted, metadata for UI config)
  - purchases, subscriber_access, credit_ledger
  - webhook_events, outgoing_webhooks, revenue_events
- All IDs are UUIDs (cuid2 generated)
- All timestamps are UTC with timezone
- Encrypted fields (store credentials) use AES-256-GCM
- CreditLedger is append-only (immutable log, never update/delete)

## Environment Variables

- DATABASE_URL — PostgreSQL connection string
- REDIS_URL — Redis connection string
- ENCRYPTION_KEY — 32-byte hex for credential encryption
- BETTER_AUTH_SECRET — Better Auth session encryption key
- BETTER_AUTH_URL — Backend URL (e.g. http://localhost:3000)
- GITHUB_CLIENT_ID — GitHub OAuth app client ID
- GITHUB_CLIENT_SECRET — GitHub OAuth app client secret
- GOOGLE_CLIENT_ID — Google OAuth client ID
- GOOGLE_CLIENT_SECRET — Google OAuth client secret
- PORT — API port (default 3000)

## Commands

- `pnpm dev` — Start all apps in dev mode
- `pnpm build` — Build all packages
- `pnpm db:migrate` — Run Prisma migrations
- `pnpm db:seed` — Seed development data
- `pnpm test` — Run all tests
- `docker compose up` — Start full stack
