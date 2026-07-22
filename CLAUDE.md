# Rovenue

Open-source, self-hosted subscription/credit management for mobile & web apps (RevenueCat/Adapty alternative). AGPL-3.0. Also covers experiments, feature flags, audiences, leaderboards, and GDPR/KVKK export/anonymize.

## Stack

- **API:** Hono + TypeScript (strict). **Dashboard:** React (Vite). **Docs:** Fumadocs (apps/docs).
- **SDK:** Rust core crate (`librovenue`) + Swift / Kotlin / React Native façades.
- **DB:** PostgreSQL 16 + Drizzle ORM; hot tables are range-partitioned (pg_partman). **Analytics:** ClickHouse fed via Kafka/Redpanda + the transactional outbox (no dual-writes).
- **Cache/Queue:** Redis + BullMQ. **Monorepo:** Turborepo + pnpm. **Deploy:** Docker Compose (Coolify-ready).

## Layout

```
apps/        api · dashboard · docs
packages/    sdk-rn · sdk-swift · sdk-kotlin · core-rs (Rust) · db (Drizzle + ClickHouse migrations + seed) · shared
deploy/      caddy · postgres · clickhouse · cloudflare · apple-certs · grafana/prometheus/loki/alloy (observability profile)
docker-compose.yml   root file — full stack; COMPOSE_PROFILES=observability for Grafana/Prometheus/Loki
```

## Architecture (the non-obvious bits)

- **Dashboard auth:** Better Auth, GitHub + Google OAuth only (manages user/session/account/verification tables). **SDK auth:** per-project public API key (Bearer). **S2S:** per-project secret key.
- **Receipts:** Apple App Store Server API v2 (JWS, chain-pinned to Apple Root CAs — verifier fails closed if `APPLE_ROOT_CERTS_DIR` missing in prod), Google Play Developer API, Stripe webhooks. Webhook processing is idempotent (`store_event_id` dedup).
- **Subscription state:** TRIAL → ACTIVE → GRACE_PERIOD → EXPIRED | PAUSED | REFUNDED. Entitlements denormalized into `subscriber_access` for fast reads.
- **Placements:** `GET /v1/placements/:identifier` walks a placement's ordered audience rows → remote-config paywall or type=PAYWALL experiment; variant draw is client-side deterministic (shared bucketing, `bucketing-vectors.json` is the TS↔Rust contract); unknown placement returns an empty envelope, never 404. Builder paywalls = platform-neutral component tree (`@rovenue/shared/paywall`) rendered on web by `packages/paywall-renderer` AND natively (SwiftUI `RovenuePaywallView` in sdk-swift, Android Views in sdk-kotlin `paywallui`) — `render-fixtures.json` is the 3-platform decoder contract; RN gets parsed `builderConfig` only (presentation bridge pending). Offline fallback file (`GET /dashboard/projects/:projectId/paywalls/fallback-export`) is bundled on-device; node-level conditional overrides (introEligible/selected) and cellTemplate rendering apply on all platforms; paywall events (`paywall_view`, `paywall_close`) run on a durable at-least-once queue (survive process kill).
- **Outbox is the only path to Kafka:** never write a domain table and Kafka in the same code path — emit an `outbox_events` row in the same tx; the dispatcher publishes. Outbox is at-least-once, so ClickHouse revenue rollups use query-time idempotent views (not SummingMergeTree) to avoid double-counting on replay.
- **Audit log:** append-only, per-project SHA-256 hash chain; `audit()` runs inside the caller's Drizzle tx.
- **Append-only tables:** `credit_ledger`, `audit_logs`.
- **Offline SDK:** MMKV / SQLite cache for last-known entitlements.

## Conventions

- TypeScript strict everywhere; Zod for API input; all responses are `{ data: T }` or `{ error: { code, message } }`.
- Postgres access via Drizzle only — repositories under `packages/db/src/drizzle/repositories`; raw SQL only via `sql` template when truly necessary. In `sql`, qualify columns (`"subscribers"."id"`) — bare `${table.col}` renders unqualified and breaks correlated subqueries.
- Barrel exports (`index.ts`) per package. Conventional commits.
- Tests: Vitest (unit + integration); `*.integration.test.ts` use testcontainers (real Postgres/ClickHouse/Kafka). Rust core: `cargo test`; verify sdk-kotlin with `testDebugUnitTest`.
- All IDs are cuid2 UUIDs; timestamps UTC. Store credentials encrypted with AES-256-GCM. Refund `amountUsd` stored POSITIVE.

## Commands

- `pnpm dev` / `pnpm build` / `pnpm test`
- `pnpm db:migrate` · `pnpm db:migrate:generate` · `pnpm db:seed`
- `pnpm --filter @rovenue/db db:clickhouse:migrate` · `db:verify:clickhouse`
- `docker compose up` — full stack; prefix `COMPOSE_PROFILES=observability` for Grafana/Prometheus/Loki (Grafana on :3300)

## Env

See `.env.example` for the canonical list. Required in prod: `DATABASE_URL`, `REDIS_URL`, `CLICKHOUSE_URL`, `KAFKA_BROKERS`, `ENCRYPTION_KEY` (32-byte hex), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DASHBOARD_URL`, OAuth client id/secret pairs, `APPLE_ROOT_CERTS_DIR`. Local dev degrades gracefully when ClickHouse is blank.
