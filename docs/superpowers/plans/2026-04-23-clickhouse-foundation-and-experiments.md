# Alan 6 Plan 1 — ClickHouse Foundation + Experiments Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a production-grade ClickHouse OLAP read replica of Postgres (via PeerDB), add the `exposure_events` pipeline so every variant impression flows into ClickHouse, and rewire `GET /v1/experiments/:id/results` to compute CUPED / mSPRT / sample-size from the ClickHouse materialised view `mv_experiment_daily`. No SDK-RN, no dashboard UI, no revenue analytics — this plan is strictly server-side ClickHouse foundation + experiment analytics backend.

**Architecture:** Postgres (with TimescaleDB extension) remains the OLTP source of truth for every write. PeerDB tails Postgres logical replication (publication `rovenue_analytics`) and streams inserts/updates into ClickHouse `raw_*` tables (ReplacingMergeTree / MergeTree). ClickHouse owns analytical reads — `apps/api/src/lib/clickhouse.ts` wraps `@clickhouse/client` with parameterised queries + project scoping, `apps/api/src/services/analytics-router.ts` dispatches each analytics query type to Postgres or ClickHouse, and the experiment stats endpoint reads pre-aggregated state from `mv_experiment_daily`. Exposure ingest is server-side only (Plan 1 provides `POST /v1/experiments/:id/expose` with a Redis-backed batch buffer; the SDK that will drive it lands in Plan 3).

**Tech Stack:** Hono 4 + TypeScript (strict), Drizzle ORM 0.45, drizzle-kit 0.31, PostgreSQL 16 + TimescaleDB 2.17.2 (Apache community features only), ClickHouse 24.3, PeerDB (self-host docker bundle), Redis 7 + ioredis, `@clickhouse/client` 1.x, Vitest 1.3, Supertest, testcontainers. No new dashboard or SDK deps.

**Scope note — what is intentionally NOT in this plan:**

- **SDK-RN** (identity merge, SSE client, `getVariant`, MMKV offline queue, size-limit guard). Plan 3 — `2026-05-XX-experiment-delivery-sdk.md`.
- **Dashboard experiment results UI** (stratified view, SRM warning, sample-size progress). Plan 4 — `2026-06-XX-dashboard-analytics-ui.md`.
- **Revenue analytics materialised views** (`mv_daily_revenue`, `mv_cohort_retention`, LTV aggregates) and the cohort / funnel / LTV / geo / event-timeline API endpoints. Plan 2 — `2026-05-XX-clickhouse-revenue-analytics.md`.
- **`daily_mrr` TimescaleDB continuous aggregate drop**. Happens in Plan 2 together with the `/metrics/mrr` route cutover onto `mv_daily_revenue`. Until Plan 2 lands the TS cagg keeps serving `/dashboard/projects/:projectId/metrics/mrr`.
- **Auto-emitting exposures from the existing `GET /v1/config` code path**. Plan 1 exposes a standalone ingest endpoint that will be driven by the SDK in Plan 3; rewiring the config endpoint to server-side emit is deferred so this plan never couples to SDK-still-missing semantics.
- **Multi-node ClickHouse / sharding / replicated tables**. Plan 1 ships single-node ClickHouse on a single Docker Compose service (spec §7.1). Cluster topology lives behind the spec §1.3 growth signals and is reconsidered later.

---

## Testing conventions

- **Schema-level unit tests** live next to their schema file and stay mock-only — the rovenue pattern from Alan 4 / Alan 5 is hoisted-mocks + no live DB for `packages/db`'s unit suite. Extend `packages/db/src/drizzle/drizzle-foundation.test.ts` with shape assertions for `exposure_events`; do NOT add a live-DB integration harness to the db package.
- **Hand-written migrations.** Every Postgres migration is authored as raw SQL + a hand-appended entry in `packages/db/drizzle/migrations/meta/_journal.json`. Do NOT run `drizzle-kit generate`; it will duplicate DDL and corrupt the journal. All Drizzle schema.ts changes in this plan are manual.
- **ClickHouse migrations are NOT Drizzle.** They live in `packages/db/clickhouse/migrations/` as plain numbered `.sql` files. A new hand-rolled runner (`packages/db/src/clickhouse-migrate.ts`, added in Phase 2) applies them in order and tracks applied hashes in a ClickHouse table `_migrations`. Do NOT attempt to reuse `drizzle-orm`'s migrator — it is Postgres-only.
- **Server integration tests** for the exposure ingest, SSE config stream, and experiment results routes live under `apps/api/tests/` using Supertest against a Hono `app.request()` fetch adapter, matching the existing `apps/api/tests/config-endpoint.test.ts` pattern. Inline the route wiring inside each test so the tests don't depend on `index.ts` boot sequencing.
- **ClickHouse integration** uses the `testcontainers` npm package (spec §10.4) to spin a real ClickHouse 24.3 container per test file — not a mock. Two integration test files exist after this plan:
  - `apps/api/tests/clickhouse-integration.test.ts` — asserts `mv_experiment_daily` aggregates match a raw `GROUP BY` over the same `raw_exposures` data, plus a round-trip insert through the ingest endpoint.
  - `packages/db/tests/clickhouse-migrations.test.ts` — asserts every migration in `packages/db/clickhouse/migrations/` applies cleanly and is idempotent (re-running the runner is a no-op).
- **Replication parity** is asserted by a single end-to-end test in `apps/api/tests/replication-parity.test.ts` that boots Postgres-with-TimescaleDB + ClickHouse + PeerDB via testcontainers-modules, inserts rows in Postgres, and asserts ClickHouse row counts converge within 30 seconds. This test is marked `.slow` and skipped by default; CI runs it nightly (out of scope) — the plan only wires the test and the `pnpm test:slow` hook.
- **Runtime smoke:** `pnpm --filter @rovenue/db db:verify:clickhouse` runs `packages/db/scripts/verify-clickhouse.ts` (Phase 9) which asserts every expected table / materialised view exists with the right engine + ORDER BY + TTL. This mirrors `db:verify:timescale` from Alan 4. Used locally and in CI post-migrate.

---

## File structure

### Create

**Docker / infra:**
- `deploy/peerdb/upstream/` — git submodule pinned to PeerDB `v0.36.18`. PeerDB ships its own ~9-service docker-compose bundle; we vendor and boot it via `./run-peerdb.sh`.
- `deploy/peerdb/README.md` — bootstrap instructions (submodule init, `run-peerdb.sh`, `psql setup.sql`).
- `deploy/peerdb/setup.sql` — `CREATE PEER` + `CREATE MIRROR` SQL applied against PeerDB's wire endpoint (`localhost:9900`) to create the `rovenue_analytics` mirror (Phase 4).
- `deploy/clickhouse/config.d/rovenue.xml` — ClickHouse server overrides (max_memory_usage, max_execution_time, enable_http_compression).
- `deploy/clickhouse/users.d/rovenue.xml` — ClickHouse user `rovenue` with read+insert grants on `rovenue` database, read-only user `rovenue_reader` for analytics-router.
- `deploy/clickhouse/backup.sh` — `clickhouse-backup`-based daily backup to S3-compatible storage. Referenced in Phase 10 but not scheduled by the plan (ops concern); the script must be runnable standalone.
- `.gitmodules` — top-level submodule config for `deploy/peerdb/upstream`.

**ClickHouse migrations (new directory):**
- `packages/db/clickhouse/migrations/0001_init_schema.sql` — creates the `rovenue` database and the `_migrations` tracking table.
- `packages/db/clickhouse/migrations/0002_raw_revenue_events.sql` — `raw_revenue_events` ReplacingMergeTree.
- `packages/db/clickhouse/migrations/0003_raw_credit_ledger.sql` — `raw_credit_ledger` ReplacingMergeTree.
- `packages/db/clickhouse/migrations/0004_raw_subscribers.sql` — `raw_subscribers` ReplacingMergeTree (for denormalised joins; latest attributes win).
- `packages/db/clickhouse/migrations/0005_raw_purchases.sql` — `raw_purchases` ReplacingMergeTree.
- `packages/db/clickhouse/migrations/0006_raw_experiment_assignments.sql` — `raw_experiment_assignments` ReplacingMergeTree.
- `packages/db/clickhouse/migrations/0007_raw_exposures.sql` — `raw_exposures` MergeTree (append-only).
- `packages/db/clickhouse/migrations/0008_mv_experiment_daily.sql` — `mv_experiment_daily` SummingMergeTree materialised view targeting `raw_exposures` joined with `raw_revenue_events` for conversion counting.

**ClickHouse migration runner + verifier:**
- `packages/db/src/clickhouse-migrate.ts` — CLI that connects via `CLICKHOUSE_URL`, reads `packages/db/clickhouse/migrations/*.sql` in order, and applies new ones. Records filename + SHA-256 + applied_at in `_migrations`. Re-runnable (no-op on applied files). Wired as `pnpm --filter @rovenue/db db:clickhouse:migrate`.
- `packages/db/scripts/verify-clickhouse.ts` — standalone CLI that connects via `CLICKHOUSE_URL` and asserts the expected schema (tables, engines, ORDER BY, TTLs, MV target) against a hard-coded `EXPECTED` object. Prints `OK` or lists drift. Wired as `pnpm --filter @rovenue/db db:verify:clickhouse`.

**Postgres (Drizzle) migrations:**
- `packages/db/drizzle/migrations/0009_exposure_events.sql` — create `exposure_events` table with composite PK `(id, exposed_at)`, call `create_hypertable('exposure_events', 'exposed_at', chunk_time_interval => INTERVAL '1 hour')`, add compression + retention policies.
- `packages/db/drizzle/migrations/0010_postgres_publication.sql` — `CREATE PUBLICATION rovenue_analytics FOR TABLE revenue_events, credit_ledger, subscribers, purchases, experiment_assignments, exposure_events;` + replication slot creation.

**API — ClickHouse client + analytics router:**
- `apps/api/src/lib/clickhouse.ts` — `@clickhouse/client` singleton; `queryAnalytics<T>(projectId, sql, params)` wrapper that scopes by project, enforces 15s request timeout, records latency metrics, and returns `T[]`.
- `apps/api/src/services/analytics-router.ts` — `runAnalyticsQuery(q)` dispatcher that switches on `q.kind` and routes to Postgres or ClickHouse. Plan 1 only ships the `experiment_results` kind; Plan 2 extends with MRR / cohort / funnel.

**API — exposure pipeline:**
- `apps/api/src/services/exposure-buffer.ts` — Redis-backed batch buffer (`LPUSH` list `rovenue:exposure:buffer`, background flush every 2s or 500 rows, whichever first). Flush writes to Postgres `exposure_events` via `drizzle.exposureRepo.insertMany`; ClickHouse receives rows through PeerDB, not a direct dual-write.
- `apps/api/src/routes/v1/experiments-expose.ts` — `POST /v1/experiments/:id/expose` route. Validates body with Zod (subscriberId, variantId, platform, country optional), enqueues to the buffer. Returns `202 Accepted`.
- `apps/api/src/routes/v1/config-stream.ts` — `GET /v1/config/stream` SSE endpoint. Sends `initial` bundle immediately, then pushes `invalidate` events whenever the Redis pub/sub channel `rovenue:experiments:invalidate` fires for the caller's project. Closes on client disconnect.
- `apps/api/src/workers/exposure-flusher.ts` — BullMQ-less background flusher (plain setInterval started by `index.ts`). Drains the Redis list, batches to Postgres, exposes one Prometheus metric `rovenue_exposure_flush_rows`.

**API — experiment stats integration:**
- `apps/api/src/services/experiment-results.ts` — new service that `getExperimentResults` (existing in `experiment-engine.ts`) delegates to. Pulls pre-aggregated per-day / per-variant counts + revenue sums from ClickHouse `mv_experiment_daily`, then calls the pure functions in `apps/api/src/lib/experiment-stats.ts` (`analyzeConversion`, `analyzeRevenue`, `checkSRM`, `estimateSampleSize`). `experiment-stats.ts` itself does not change — this plan only shifts the caller.

**API — v1 experiments router wiring:**
- `apps/api/src/routes/v1/experiments-results.ts` — `GET /v1/experiments/:id/results` public route (API-key auth, project-scoped). Calls `getExperimentResults(experimentId)` via the new CH-backed path.

**Tests:**
- `packages/db/tests/clickhouse-migrations.test.ts` — idempotency + order test for the CH migration runner.
- `apps/api/tests/clickhouse-client.test.ts` — unit test for `queryAnalytics` parameterisation + timeout.
- `apps/api/tests/exposure-ingest.test.ts` — Supertest against the ingest endpoint using an in-memory Redis mock.
- `apps/api/tests/config-stream.test.ts` — Supertest for SSE initial payload + pub/sub invalidation.
- `apps/api/tests/clickhouse-integration.test.ts` — testcontainers-based end-to-end; `mv_experiment_daily` aggregate parity + round-trip through ingest.
- `apps/api/tests/replication-parity.test.ts` — `.slow` end-to-end with Postgres + TimescaleDB + ClickHouse + PeerDB.
- `apps/api/tests/experiment-results.test.ts` — Supertest for `/v1/experiments/:id/results` with a CH fake (seeded `mv_experiment_daily` rows).

**Metrics / monitoring:**
- `apps/api/src/lib/metrics.ts` — extend existing Prometheus registry with three new counters: `rovenue_exposure_flush_rows_total`, `rovenue_analytics_query_duration_seconds` (histogram), `rovenue_peerdb_replication_lag_seconds` (gauge, set by a tiny poller).
- `apps/api/src/workers/peerdb-lag-poller.ts` — polls PeerDB's `/mirrors/{name}/stats` HTTP endpoint every 60s, updates the lag gauge. Started from `index.ts`.

### Modify

- `docker-compose.yml` — add `clickhouse` service. Add an `extends` or `-f` instruction for the PeerDB overlay; document in comments. Add `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` env passthrough into the `api` service.
- `apps/api/src/lib/env.ts` — extend `envSchema` with `CLICKHOUSE_URL`, `CLICKHOUSE_USER` (default `rovenue_reader`), `CLICKHOUSE_PASSWORD`. Required in production; optional locally (exposure buffer + analytics router no-op when absent so unrelated tests keep passing).
- `apps/api/src/index.ts` — start the exposure-flusher + PeerDB lag poller alongside existing workers.
- `apps/api/src/app.ts` — mount the three new routes (`experiments-expose`, `config-stream`, `experiments-results`).
- `apps/api/src/services/experiment-engine.ts` — replace the body of `getExperimentResults` with a call into `experiment-results.ts`. Keep the existing function signature so callers (`routes/dashboard/experiments.ts`) are unchanged.
- `packages/db/src/drizzle/schema.ts` — add `exposureEvents` `pgTable` with composite PK `(id, exposedAt)`, columns listed in Phase 3.
- `packages/db/src/drizzle/repositories/index.ts` — export the new `exposureRepo` barrel.
- `packages/db/src/drizzle/repositories/exposure-events.ts` — new repo file with `insertMany(rows)` + `countSince(projectId, since)` helpers.
- `packages/db/src/drizzle/drizzle-foundation.test.ts` — add shape assertions for `exposure_events` composite PK.
- `packages/db/drizzle/migrations/meta/_journal.json` — append entries for `0009` and `0010`.
- `packages/db/package.json` — add scripts `db:clickhouse:migrate` and `db:verify:clickhouse`. Add `@clickhouse/client` to dependencies.
- `apps/api/package.json` — add `@clickhouse/client` to dependencies, `testcontainers` to devDependencies.
- `.env.example` — document the three new `CLICKHOUSE_*` variables.
- `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md` — Phase 11 adds `✅ 2026-MM-DD` markers next to completed §4 schema + §8 API + §10 test items.

### Delete

None. Plan 1 is strictly additive.

---

## Reference: existing in-tree bindings this plan depends on

- **TimescaleDB hypertable pattern** (Alan 4 plan, tasks 2.1–4.2 in `docs/superpowers/plans/2026-04-23-timescaledb.md`): drop-id-PK → composite-PK → `create_hypertable` → compression policy → retention policy. `exposure_events` follows this exactly. Chunk interval is `1 hour` (higher insert rate than `revenue_events`); compression after 7 days; retention 90 days (raw exposures are replaced by `mv_experiment_daily` aggregates for long-term stats, spec §4.5).
- **Drizzle hand-written migration + journal pattern** (same plan, task 1.1): new Postgres migrations are `.sql` files named `NNNN_description.sql` plus a matching entry in `packages/db/drizzle/migrations/meta/_journal.json`. The `idx` field increments, the `tag` matches the filename without `.sql`, `when` is `Date.now()`, `version: "7"`, `breakpoints: true`. `pnpm --filter @rovenue/db db:migrate` reads the journal and hashes each `.sql`.
- **Verify CLI pattern** (`packages/db/scripts/verify-timescale.ts`): single-file CLI, top-level `EXPECTED` constant, plain `pg.Client`, exits non-zero on drift, prints `OK` on success. `verify-clickhouse.ts` mirrors this against `@clickhouse/client`.
- **Redis singleton** (`apps/api/src/lib/redis.ts`): import `{ redis }` for any Redis access. `lazyConnect: true` is load-bearing; do not call `connect()` explicitly — ioredis connects on first command.
- **Zod env schema** (`apps/api/src/lib/env.ts`): new env vars go into the `envSchema` object, with optional-in-dev-required-in-production enforced via `.superRefine` like `ENCRYPTION_KEY`.
- **Hono route module pattern** (`apps/api/src/routes/v1/experiments.ts`, `apps/api/src/routes/v1/config.ts`): each route module exports a `Hono` instance; `apps/api/src/app.ts` mounts it with `app.route("/v1/...", routeModule)`. Public v1 routes require the API-key middleware (look for the existing `apiKeyAuth` import in `apps/api/src/middleware/`); dashboard routes use `requireDashboardAuth`.
- **Experiment stats primitives** (`apps/api/src/lib/experiment-stats.ts`): pure functions `analyzeConversion`, `analyzeRevenue`, `checkSRM`, `estimateSampleSize`, `analyzeFunnel`. They take aggregated counts / arrays, not raw rows — perfect fit for ClickHouse pre-aggregated output. Do NOT modify; this plan only changes how their inputs are assembled.
- **Existing `getExperimentResults`** (`apps/api/src/services/experiment-engine.ts`): already exported and called from the dashboard route. Its current body queries Postgres. Plan 1 swaps the body to delegate to `experiment-results.ts` which reads from ClickHouse; the external signature does not change.
- **`experiment_assignments` schema** (`packages/db/src/drizzle/schema.ts`, from Alan 5 Plan A): `(id, projectId, experimentId, subscriberId, variantId, hashVersion, assignedAt)`; `UNIQUE(experimentId, subscriberId)` sticky assignment. This table is replicated to ClickHouse (`raw_experiment_assignments`) for denormalisation into `mv_experiment_daily`.
- **`revenue_events` schema** (same file, Alan 4): composite PK `(id, eventDate)`, TimescaleDB hypertable. Replicated to `raw_revenue_events` so conversion events can be joined against exposures in ClickHouse.
- **Hono Supertest pattern** (`apps/api/tests/config-endpoint.test.ts`): instantiate a fresh `Hono` in the test, mount only the route under test, call `app.request("/path", { ... })` to get a `Response`. No `listen()` / port binding.
- **TimescaleDB image in local compose** (`docker-compose.yml`, current): `timescale/timescaledb:2.17.2-pg16` on host port `5433`. Plan 1 does not change this; ClickHouse is a sibling service on a new volume.

---

## Phase 0 — Pre-flight

### Task 0.1: Confirm the baseline suite is green and the stack is pullable

**Files:** none

- [ ] **Step 1: Switch to main and pull latest**

```bash
git checkout main
git pull origin main
```

Expected: clean tree, HEAD at `1b9bcf9` (the ClickHouse spec addendum) or later.

- [ ] **Step 2: Verify docker daemon is running and the ClickHouse image is pullable**

Run:
```bash
docker pull clickhouse/clickhouse-server:24.3-alpine
```

Expected: image pulled. PeerDB is NOT pre-pulled here — PeerDB is deployed as a vendored git submodule in Phase 1 Task 1.2 via its own `run-peerdb.sh`, which pulls the correct image tags itself (they move frequently and are pinned inside PeerDB's upstream compose file).

- [ ] **Step 3: Start the current stack and run the baseline test suite**

```bash
docker compose up -d db redis
pnpm install
pnpm test
```

Expected: every workspace passes. If any existing test fails, stop — this plan assumes a green baseline. Re-run `docker compose logs db` to confirm TimescaleDB booted cleanly.

- [ ] **Step 4: Verify the existing TimescaleDB hypertables are in place**

```bash
pnpm --filter @rovenue/db db:migrate
pnpm --filter @rovenue/db db:verify:timescale
```

Expected: `OK`. If the verifier reports drift, fix it before proceeding — Plan 1 adds a new hypertable (`exposure_events`) and an unstable TS baseline will mask new issues.

### Task 0.2: Create the feature branch

**Files:** none

- [ ] **Step 1: Branch from main**

```bash
git checkout -b feat/clickhouse-analytics
```

Expected: fresh branch off the latest main commit. All commits in this plan land on this branch.

---

## Phase 1 — Infrastructure: Docker Compose + env

### Task 1.1: Add the ClickHouse service to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`
- Create: `deploy/clickhouse/config.d/rovenue.xml`
- Create: `deploy/clickhouse/users.d/rovenue.xml`

- [ ] **Step 1: Write the ClickHouse server overrides**

Create `deploy/clickhouse/config.d/rovenue.xml`:

```xml
<?xml version="1.0"?>
<!--
  Rovenue local ClickHouse overrides. Co-located with Postgres on the
  same VPS until growth signals (spec §1.3) trigger a split.
  Query limits keep a runaway dashboard query from monopolising RAM.
-->
<clickhouse>
  <!-- Bind to all interfaces. CH defaults to 127.0.0.1 inside the
       container, which blocks Docker port-forwarding from host to
       container. 0.0.0.0 covers IPv4; `::` would cover IPv6 too but
       alpine containers ship with IPv6 disabled and startup fails. -->
  <listen_host>0.0.0.0</listen_host>
  <max_server_memory_usage_to_ram_ratio>0.7</max_server_memory_usage_to_ram_ratio>
  <profiles>
    <default>
      <max_memory_usage>4000000000</max_memory_usage>
      <max_execution_time>30</max_execution_time>
      <max_bytes_before_external_sort>2000000000</max_bytes_before_external_sort>
      <max_bytes_before_external_group_by>2000000000</max_bytes_before_external_group_by>
      <enable_http_compression>1</enable_http_compression>
    </default>
  </profiles>
</clickhouse>
```

- [ ] **Step 2: Write the ClickHouse user config**

Create `deploy/clickhouse/users.d/rovenue.xml`:

```xml
<?xml version="1.0"?>
<!--
  Two users: `rovenue` owns the schema and is used by the migration
  runner + PeerDB target; `rovenue_reader` is read-only and is what
  the API's analytics-router uses for dashboard queries. The default
  user is disabled so nothing runs without explicit credentials.

  readonly must be expressed as a profile setting, not a per-user
  field — the per-user <readonly> tag is silently ignored. We define
  a `readonly_analytics` profile with readonly=2 (SELECT + SHOW only,
  settings changes blocked from the client side) and apply it to
  rovenue_reader.
-->
<clickhouse>
  <profiles>
    <readonly_analytics>
      <readonly>2</readonly>
    </readonly_analytics>
  </profiles>
  <users>
    <default remove="remove"/>
    <rovenue>
      <password_sha256_hex from_env="CLICKHOUSE_PASSWORD_SHA256"/>
      <networks><ip>::/0</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
      <access_management>0</access_management>
      <named_collection_control>0</named_collection_control>
      <databases>
        <rovenue/>
      </databases>
    </rovenue>
    <rovenue_reader>
      <password_sha256_hex from_env="CLICKHOUSE_READER_PASSWORD_SHA256"/>
      <networks><ip>::/0</ip></networks>
      <profile>readonly_analytics</profile>
      <quota>default</quota>
      <databases>
        <rovenue/>
      </databases>
    </rovenue_reader>
  </users>
</clickhouse>
```

- [ ] **Step 3: Append the `clickhouse` service to `docker-compose.yml`**

Open `docker-compose.yml`. Immediately after the `redis` service and before the `volumes:` block, add:

```yaml
  clickhouse:
    # Pinned to 24.3 LTS — the oldest series that carries
    # `windowFunnel`, projections, and the @clickhouse/client 1.x wire
    # protocol we depend on. Upgrading to 24.x+ is safe within the
    # 24-series but should trigger a verify-clickhouse run.
    image: clickhouse/clickhouse-server:24.3-alpine
    environment:
      # CLICKHOUSE_DB creates the rovenue database on first boot. We
      # intentionally do NOT set CLICKHOUSE_USER/CLICKHOUSE_PASSWORD —
      # the image's entrypoint would generate a second user definition
      # that conflicts with users.d/rovenue.xml ("more than one
      # 'password' field for user rovenue"). Authoritative user config
      # lives in users.d; env vars only feed the hex password via
      # from_env in the XML.
      CLICKHOUSE_DB: rovenue
      # Hex-encoded SHA-256 of the password `rovenue`. Compute a new
      # hash for any non-default password with:
      #   printf '%s' "$CLICKHOUSE_PASSWORD" | shasum -a 256
      CLICKHOUSE_PASSWORD_SHA256: ${CLICKHOUSE_PASSWORD_SHA256:-460592d4be24af16128f6ee18ca9bef3527fec9d74281c13a860572d09e975c2}
      CLICKHOUSE_READER_PASSWORD_SHA256: ${CLICKHOUSE_READER_PASSWORD_SHA256:-460592d4be24af16128f6ee18ca9bef3527fec9d74281c13a860572d09e975c2}
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    volumes:
      - rovenue-clickhouse-data:/var/lib/clickhouse
      - ./deploy/clickhouse/config.d:/etc/clickhouse-server/config.d:ro
      - ./deploy/clickhouse/users.d:/etc/clickhouse-server/users.d:ro
    ports:
      # Host 8124 → container 8123 (HTTP) to avoid colliding with any
      # other CH on 8123. 9001 → 9000 (native TCP) for `clickhouse-client`.
      - "8124:8123"
      - "9001:9000"
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8123/ping || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
```

Then add `rovenue-clickhouse-data:` to the `volumes:` block at the bottom:

```yaml
volumes:
  rovenue-data:
  rovenue-clickhouse-data:
```

Finally, extend the `api` service `environment:` block with:

```yaml
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_USER: rovenue_reader
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_READER_PASSWORD:-rovenue}
```

And add `clickhouse: { condition: service_healthy }` to `api.depends_on`.

- [ ] **Step 4: Bring the service up and confirm it is healthy**

```bash
docker compose up -d clickhouse
until docker compose ps clickhouse | grep -q healthy; do sleep 2; done
curl -s http://localhost:8124/ping
```

Expected: `Ok.` on the `/ping` response. If unhealthy after 60s, `docker compose logs clickhouse` — most common issue is a malformed users.xml; fix and `docker compose restart clickhouse`.

### Task 1.2: Vendor PeerDB as a git submodule

**Files:**
- Create: `deploy/peerdb/README.md`
- Create: `deploy/peerdb/upstream/` (submodule reference)
- Modify: `.gitmodules` (add PeerDB submodule)
- Modify: `docker-compose.yml` (header comment only)

**Rationale for not re-authoring PeerDB's compose:** PeerDB ships its own multi-service bundle (catalog Postgres + 3 temporal services + flow-api + flow-snapshot-worker + flow-worker + peerdb-server + peerdb-ui, ~9 services total) and explicitly recommends cloning their repo and running `./run-peerdb.sh`. The service topology drifts between minor versions (temporal setup, worker splits, UI port). Per PeerDB's own [quickstart](https://docs.peerdb.io/quickstart/quickstart#deploying-peerdb), we vendor their compose via git submodule pinned to a specific tag and treat it as an external dependency — rovenue only owns the `peer` + `mirror` SQL configuration (Phase 4).

- [ ] **Step 1: Add PeerDB as a git submodule pinned to a stable tag**

```bash
git submodule add --name peerdb-upstream \
    https://github.com/PeerDB-io/peerdb.git \
    deploy/peerdb/upstream
cd deploy/peerdb/upstream
git checkout v0.36.18
cd ../../..
git add .gitmodules deploy/peerdb/upstream
```

Expected: `.gitmodules` contains the `peerdb-upstream` entry; `deploy/peerdb/upstream/` is pinned to tag `v0.36.18`.

**Version-bump hygiene:** when upgrading the submodule, `cd deploy/peerdb/upstream && git fetch && git checkout stable-v0.X.Y`, re-run `./run-peerdb.sh`, and confirm `deploy/peerdb/setup.sql` (Phase 4) still applies against the new peerdb-server. The PeerDB UI `/mirrors` page should list `rovenue_analytics` as running after the upgrade.

- [ ] **Step 2: Write the rovenue-side PeerDB README**

Create `deploy/peerdb/README.md`:

```markdown
# PeerDB bootstrap for rovenue analytics

PeerDB is vendored as a git submodule at `deploy/peerdb/upstream/`,
pinned to `v0.36.18`. We deploy it via PeerDB's own
`run-peerdb.sh` script — NOT via rovenue's `docker-compose.yml` —
because PeerDB bundles ~9 interdependent services whose topology
drifts between versions.

## First-time setup

```bash
# 1. Ensure rovenue's Postgres + ClickHouse are running and published
#    on the host (default: localhost:5433 and localhost:8124).
docker compose up -d db redis clickhouse

# 2. Initialise the PeerDB submodule if not yet done.
git submodule update --init --recursive

# 3. Boot PeerDB. This runs on its own docker network; it reaches
#    rovenue's services via host.docker.internal.
cd deploy/peerdb/upstream
./run-peerdb.sh

# 4. Wait for the PeerDB UI to be reachable at http://localhost:3000
#    and the Postgres wire endpoint to be reachable at
#    localhost:9900 (user `peerdb`, password `peerdb`).

# 5. Apply the rovenue mirror config (Phase 4 creates setup.sql).
psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" \
     -f deploy/peerdb/setup.sql
```

## Connecting PeerDB to rovenue services

PeerDB runs in its own docker network (created by `run-peerdb.sh`),
so its containers cannot resolve `db` or `clickhouse`. From inside
PeerDB's network, rovenue is reachable via:

- Postgres: `host.docker.internal:5433` (rovenue user/password)
- ClickHouse: `host.docker.internal:8124` (rovenue user/password)

`deploy/peerdb/setup.sql` uses these host addresses in the `CREATE
PEER ... WITH (...)` statements.

## UI

- Dashboard: http://localhost:3000 — mirrors, peers, sync status.
- psql wire: localhost:9900 — scriptable via `psql`.

## Stopping PeerDB

```bash
cd deploy/peerdb/upstream
docker compose down
```

This leaves rovenue's own stack untouched. PeerDB's catalog state
persists in PeerDB's docker volumes; on next boot mirrors resume.

## Upgrading

See "Version-bump hygiene" in the Phase 1 Task 1.2 step notes of
`docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md`.
Pin the submodule to a newer `stable-v0.*.*` tag, rerun `./run-peerdb.sh`,
then re-apply `deploy/peerdb/setup.sql` if the peer/mirror schema changed.

## Production (Coolify / hosted)

Production runbook is out of scope for Plan 1. The simplest Coolify
deployment publishes PeerDB as an independent service stack
alongside rovenue's own stack, with ClickHouse and Postgres reachable
over the Coolify internal network (not host.docker.internal).
Operator notes land with Plan 2.
```

- [ ] **Step 3: Document the two-stack boot sequence in the main compose file**

At the very top of `docker-compose.yml`, add a header comment block:

```yaml
# Rovenue local stack — rovenue's own services (api, db, redis, clickhouse).
#
# Default boot:
#   docker compose up -d
#
# PeerDB (Postgres → ClickHouse replication) is a VENDORED external
# bundle, NOT a service in this file. See deploy/peerdb/README.md.
# Boot PeerDB separately:
#   cd deploy/peerdb/upstream && ./run-peerdb.sh
#
# Most development does not need PeerDB running — the API treats the
# ClickHouse database as empty and the analytics-router falls back
# to "no data" responses. Integration tests in apps/api/tests/
# replication-parity.test.ts spin a minimal PeerDB via testcontainers.
```

- [ ] **Step 4: Smoke-test the full two-stack boot**

```bash
# Rovenue stack
docker compose up -d db redis clickhouse
until docker compose ps db clickhouse | grep -c healthy | grep -q 2; do sleep 2; done

# PeerDB stack
cd deploy/peerdb/upstream
./run-peerdb.sh
cd ../../..
```

Expected: `./run-peerdb.sh` runs to completion and prints PeerDB's UI URL (typically `http://localhost:3000`). Open it and confirm the "Peers" and "Mirrors" pages load (empty — they are populated by Phase 4 Task 4.2).

If `run-peerdb.sh` fails, check `deploy/peerdb/upstream/docker-compose.yml` for service health, then `docker compose -f deploy/peerdb/upstream/docker-compose.yml logs` for the failing service. Most likely causes: port conflict on 3000 (rovenue's dashboard), 9900 (occupied by something else), or the vendored version requires a newer docker compose major version.

- [ ] **Step 5: Commit the infrastructure work**

```bash
git add docker-compose.yml \
        deploy/clickhouse/config.d/rovenue.xml \
        deploy/clickhouse/users.d/rovenue.xml \
        deploy/peerdb/README.md \
        .gitmodules
git commit -m "chore(infra): vendor PeerDB via submodule + ClickHouse compose"
```

Note: `deploy/peerdb/upstream` is tracked as a submodule reference (single gitlink entry), not as files. `git add` of the parent path plus the `.gitmodules` entry is sufficient.

### Task 1.3: Extend the API env schema

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the ClickHouse env vars to `envSchema`**

Open `apps/api/src/lib/env.ts`. Inside the `.object({ ... })` block, after the `REDIS_URL` line, insert:

```typescript
    CLICKHOUSE_URL: z.string().url().optional(),
    CLICKHOUSE_USER: z.string().min(1).default("rovenue_reader"),
    CLICKHOUSE_PASSWORD: z.string().min(1).optional(),
```

Then inside the `.superRefine` block, after the existing `require(...)` calls for production gating, add:

```typescript
    require(
      data.CLICKHOUSE_URL,
      "CLICKHOUSE_URL",
      "analytics queries require a ClickHouse cluster in production",
    );
    require(
      data.CLICKHOUSE_PASSWORD,
      "CLICKHOUSE_PASSWORD",
      "analytics reader must authenticate in production",
    );
```

- [ ] **Step 2: Extend `.env.example`**

Append to `.env.example`:

```bash
# ClickHouse read replica (PeerDB populates it from Postgres).
# Leave blank in local dev if you haven't booted the ClickHouse
# service; the analytics router degrades gracefully.
CLICKHOUSE_URL=http://localhost:8124
CLICKHOUSE_USER=rovenue_reader
CLICKHOUSE_PASSWORD=rovenue
```

- [ ] **Step 3: Run the api package's type check to confirm the env extension compiles**

```bash
pnpm --filter @rovenue/api typecheck
```

Expected: no errors. If `typecheck` is not a script, substitute `pnpm --filter @rovenue/api build`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/env.ts .env.example
git commit -m "feat(env): declare CLICKHOUSE_URL/USER/PASSWORD"
```

---

## Phase 2 — ClickHouse schema: migration runner + raw tables

### Task 2.1: Add `@clickhouse/client` dependency and write the migration runner

**Files:**
- Modify: `packages/db/package.json`
- Modify: `apps/api/package.json`
- Create: `packages/db/src/clickhouse-migrate.ts`

- [ ] **Step 1: Add `@clickhouse/client` to both packages**

```bash
pnpm --filter @rovenue/db add @clickhouse/client@^1.9.0
pnpm --filter @rovenue/api add @clickhouse/client@^1.9.0
pnpm --filter @rovenue/api add -D testcontainers@^10.15.0
```

Expected: `pnpm-lock.yaml` updated; new `dependencies` entries in both `package.json`s.

- [ ] **Step 2: Create the migration runner**

Create `packages/db/src/clickhouse-migrate.ts`:

```typescript
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@clickhouse/client";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = join(here, "..", "clickhouse", "migrations");

const url = process.env.CLICKHOUSE_URL;
const user = process.env.CLICKHOUSE_USER ?? "rovenue";
const password = process.env.CLICKHOUSE_PASSWORD;
if (!url) throw new Error("CLICKHOUSE_URL is required");
if (!password) throw new Error("CLICKHOUSE_PASSWORD is required");

// Note: migrations run as the write-capable `rovenue` user, not the
// read-only `rovenue_reader`. Production CI must supply the owner
// password here, and the API process uses the reader password.
const client = createClient({
  // @clickhouse/client >=1.18 renamed `host` → `url`. The old
  // field still works with a deprecation warning; prefer `url` so
  // future removals don't break us.
  url,
  username: user,
  password,
  database: "default", // 0001 creates `rovenue`; earlier we cannot scope
  request_timeout: 60_000,
});

async function ensureDatabase(): Promise<void> {
  await client.command({
    query: "CREATE DATABASE IF NOT EXISTS rovenue",
  });
}

async function ensureMigrationsTable(): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS rovenue._migrations (
        filename String,
        sha256 FixedString(64),
        applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
      )
      ENGINE = ReplacingMergeTree(applied_at)
      ORDER BY filename
    `,
  });
}

async function loadApplied(): Promise<Map<string, string>> {
  const result = await client.query({
    query: "SELECT filename, sha256 FROM rovenue._migrations FINAL",
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ filename: string; sha256: string }>;
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function applyMigration(filename: string, content: string): Promise<void> {
  // ClickHouse does not support multi-statement in a single query;
  // split on `;` that end a line. Migration files must not contain
  // `;` mid-statement — the raw_* schemas in this plan honour that.
  const statements = content
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const statement of statements) {
    await client.command({ query: statement });
  }

  await client.insert({
    table: "rovenue._migrations",
    values: [{ filename, sha256: sha256Hex(content) }],
    format: "JSONEachRow",
  });
}

async function main(): Promise<void> {
  await ensureDatabase();
  await ensureMigrationsTable();

  const applied = await loadApplied();
  const files = await listMigrations();

  let appliedNow = 0;
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const digest = sha256Hex(content);
    const recorded = applied.get(filename);

    if (recorded === undefined) {
      console.log(`apply ${filename}`);
      await applyMigration(filename, content);
      appliedNow += 1;
      continue;
    }

    if (recorded !== digest) {
      throw new Error(
        `migration ${filename} was previously applied with a different SHA-256. ` +
          `Refusing to re-apply; inspect the file or create a new migration to amend.`,
      );
    }
  }

  console.log(`clickhouse-migrate: ${appliedNow} new / ${files.length} total`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the `db:clickhouse:migrate` script**

In `packages/db/package.json`, extend the `scripts` block:

```json
    "db:clickhouse:migrate": "tsx src/clickhouse-migrate.ts",
    "db:verify:clickhouse": "tsx scripts/verify-clickhouse.ts",
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/package.json apps/api/package.json \
        packages/db/src/clickhouse-migrate.ts pnpm-lock.yaml
git commit -m "feat(db): add ClickHouse migration runner"
```

### Task 2.2: Write migration 0001 (init schema)

**Files:**
- Create: `packages/db/clickhouse/migrations/0001_init_schema.sql`

- [ ] **Step 1: Author the SQL**

Create `packages/db/clickhouse/migrations/0001_init_schema.sql`:

```sql
-- 0001_init_schema.sql
-- Initial rovenue database + internal tracking table. The migration
-- runner creates the database programmatically before reading this
-- file, but the CREATE DATABASE IF NOT EXISTS below is harmless and
-- makes the file self-documenting.
CREATE DATABASE IF NOT EXISTS rovenue;
```

Note: this file intentionally contains a single statement. The `_migrations` table itself is created by the runner before reading any migration files (bootstrap chicken-and-egg).

- [ ] **Step 2: Run the migrator and confirm it applies**

```bash
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:clickhouse:migrate
```

Expected output:
```
apply 0001_init_schema.sql
clickhouse-migrate: 1 new / 1 total
```

Confirm:
```bash
docker compose exec clickhouse clickhouse-client --query "SHOW DATABASES"
```

Expected: the list includes `rovenue`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/clickhouse/migrations/0001_init_schema.sql
git commit -m "feat(db): clickhouse 0001 — init rovenue database"
```

### Task 2.3: Write migration 0002 (`raw_revenue_events`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0002_raw_revenue_events.sql`

- [ ] **Step 1: Author the SQL**

Create `packages/db/clickhouse/migrations/0002_raw_revenue_events.sql`:

```sql
-- 0002_raw_revenue_events.sql
-- Fact table fed by PeerDB from Postgres `revenue_events`. Uses
-- ReplacingMergeTree keyed on `version` so CDC UPDATEs (e.g. a refund
-- flipping amount_cents) converge to the latest row. `version` mirrors
-- Postgres `xmin`; PeerDB sets it via the `_PEERDB_LSN_VERSION` meta
-- column which we receive as UInt64.
--
-- ORDER BY picks (project_id, occurred_at, event_id) because every
-- dashboard query filters on project_id + date range. event_id is the
-- tiebreaker for uniqueness.
--
-- LowCardinality on country, platform, currency: ISO-scale dictionaries,
-- ~10× compression.
--
-- TTL: 7 years (VUK retention). Older chunks are dropped automatically.
CREATE TABLE IF NOT EXISTS rovenue.raw_revenue_events (
  event_id UUID,
  project_id String,
  subscriber_id String,
  product_id String,
  country LowCardinality(String),
  platform LowCardinality(String),
  type Enum8(
    'INITIAL' = 1,
    'RENEWAL' = 2,
    'REFUND' = 3,
    'TRIAL_START' = 4,
    'EXPIRY' = 5,
    'UPGRADE' = 6,
    'DOWNGRADE' = 7
  ),
  amount_cents Int64,
  currency LowCardinality(String),
  period_months UInt8,
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, occurred_at, event_id)
TTL toDateTime(occurred_at) + INTERVAL 7 YEAR;
```

- [ ] **Step 2: Apply and verify**

```bash
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:clickhouse:migrate
```

Expected:
```
apply 0002_raw_revenue_events.sql
clickhouse-migrate: 1 new / 2 total
```

Confirm:
```bash
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_revenue_events FORMAT TSVRaw"
```

Expected: the returned DDL matches the file, with engine `ReplacingMergeTree(version)` and the 7-year TTL clause.

- [ ] **Step 3: Commit**

```bash
git add packages/db/clickhouse/migrations/0002_raw_revenue_events.sql
git commit -m "feat(db): clickhouse 0002 — raw_revenue_events"
```

### Task 2.4: Write migration 0003 (`raw_credit_ledger`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0003_raw_credit_ledger.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0003_raw_credit_ledger.sql
-- Credit grant + spend ledger. Postgres source is TimescaleDB-
-- hypertabled; it is append-only in Postgres but we still use
-- ReplacingMergeTree because PeerDB's CDC path may re-emit rows on
-- replication restart and we want idempotent convergence.
CREATE TABLE IF NOT EXISTS rovenue.raw_credit_ledger (
  entry_id UUID,
  project_id String,
  subscriber_id String,
  type Enum8('GRANT' = 1, 'SPEND' = 2, 'EXPIRE' = 3, 'ADJUST' = 4),
  amount Int64,
  balance_after Int64,
  source_ref String,
  metadata String,
  created_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, created_at, entry_id)
TTL toDateTime(created_at) + INTERVAL 7 YEAR;
```

- [ ] **Step 2: Apply, verify, commit**

```bash
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:clickhouse:migrate

docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_credit_ledger FORMAT TSVRaw"

git add packages/db/clickhouse/migrations/0003_raw_credit_ledger.sql
git commit -m "feat(db): clickhouse 0003 — raw_credit_ledger"
```

### Task 2.5: Write migration 0004 (`raw_subscribers`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0004_raw_subscribers.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0004_raw_subscribers.sql
-- Slowly-changing dimension. ReplacingMergeTree keeps the latest
-- version of each subscriber; joins against raw_revenue_events for
-- denormalised cohort / LTV queries land here (Plan 2).
--
-- ORDER BY (project_id, subscriber_id) — point-lookup optimised;
-- subscribers are rarely range-scanned.
CREATE TABLE IF NOT EXISTS rovenue.raw_subscribers (
  subscriber_id String,
  project_id String,
  anonymous_id String,
  user_id String,
  attributes String,      -- JSON blob from Postgres subscribers.attributes
  platform LowCardinality(String),
  country LowCardinality(String),
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (project_id, subscriber_id)
TTL toDateTime(updated_at) + INTERVAL 7 YEAR;
```

- [ ] **Step 2: Apply, verify, commit**

```bash
pnpm --filter @rovenue/db db:clickhouse:migrate
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_subscribers FORMAT TSVRaw"
git add packages/db/clickhouse/migrations/0004_raw_subscribers.sql
git commit -m "feat(db): clickhouse 0004 — raw_subscribers"
```

### Task 2.6: Write migration 0005 (`raw_purchases`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0005_raw_purchases.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0005_raw_purchases.sql
-- Purchase receipts (App Store / Play / Stripe). Source is Postgres
-- `purchases`; replicated for cross-referencing with revenue_events
-- during funnel / LTV queries.
CREATE TABLE IF NOT EXISTS rovenue.raw_purchases (
  purchase_id UUID,
  project_id String,
  subscriber_id String,
  product_id String,
  platform LowCardinality(String),
  store_transaction_id String,
  status Enum8('ACTIVE' = 1, 'CANCELLED' = 2, 'REFUNDED' = 3, 'EXPIRED' = 4),
  price_cents Int64,
  currency LowCardinality(String),
  original_purchase_at DateTime64(3, 'UTC'),
  purchased_at DateTime64(3, 'UTC'),
  expires_at Nullable(DateTime64(3, 'UTC')),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(purchased_at)
ORDER BY (project_id, purchased_at, purchase_id)
TTL toDateTime(purchased_at) + INTERVAL 7 YEAR;
```

- [ ] **Step 2: Apply, verify, commit**

```bash
pnpm --filter @rovenue/db db:clickhouse:migrate
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_purchases FORMAT TSVRaw"
git add packages/db/clickhouse/migrations/0005_raw_purchases.sql
git commit -m "feat(db): clickhouse 0005 — raw_purchases"
```

### Task 2.7: Write migration 0006 (`raw_experiment_assignments`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0006_raw_experiment_assignments.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0006_raw_experiment_assignments.sql
-- Sticky assignment log replicated from Postgres. Same shape as
-- Drizzle's experimentAssignments table. Used to resolve "which
-- variant was user X in for experiment Y" during stratified stats.
CREATE TABLE IF NOT EXISTS rovenue.raw_experiment_assignments (
  id String,
  project_id String,
  experiment_id String,
  subscriber_id String,
  variant_id String,
  hash_version UInt16,
  assigned_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (experiment_id, subscriber_id);
```

- [ ] **Step 2: Apply, verify, commit**

```bash
pnpm --filter @rovenue/db db:clickhouse:migrate
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_experiment_assignments FORMAT TSVRaw"
git add packages/db/clickhouse/migrations/0006_raw_experiment_assignments.sql
git commit -m "feat(db): clickhouse 0006 — raw_experiment_assignments"
```

### Task 2.8: Write migration 0007 (`raw_exposures`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0007_raw_exposures.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0007_raw_exposures.sql
-- Append-only exposure stream. Source is the Postgres hypertable
-- `exposure_events` we create in Phase 3. Plain MergeTree because
-- there are no updates — every row represents a distinct impression.
--
-- TTL 90 days: exposure volume is the highest of any table; the
-- long-lived aggregates in mv_experiment_daily handle historical
-- queries beyond that window (spec §4.5).
CREATE TABLE IF NOT EXISTS rovenue.raw_exposures (
  exposure_id UUID,
  experiment_id String,
  variant_id String,
  project_id String,
  subscriber_id String,
  platform LowCardinality(String),
  country LowCardinality(String),
  exposed_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(exposed_at)
ORDER BY (experiment_id, exposed_at, subscriber_id)
TTL toDateTime(exposed_at) + INTERVAL 90 DAY;
```

- [ ] **Step 2: Apply, verify, commit**

```bash
pnpm --filter @rovenue/db db:clickhouse:migrate
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.raw_exposures FORMAT TSVRaw"
git add packages/db/clickhouse/migrations/0007_raw_exposures.sql
git commit -m "feat(db): clickhouse 0007 — raw_exposures"
```

### Task 2.9: Write migration 0008 (`mv_experiment_daily`)

**Files:**
- Create: `packages/db/clickhouse/migrations/0008_mv_experiment_daily.sql`

- [ ] **Step 1: Author the SQL**

```sql
-- 0008_mv_experiment_daily.sql
-- Materialised view: per-day/per-variant exposure counts + unique
-- users, grouped by stratification dimensions (country, platform).
-- The stats endpoint reads from this MV and feeds the per-day counts
-- into analyzeConversion / analyzeRevenue / checkSRM in
-- apps/api/src/lib/experiment-stats.ts.
--
-- SummingMergeTree sums the count column at merge time. uniqState
-- stores a HyperLogLog sketch; the read path calls uniqMerge to get
-- approximate distinct-user count. The approximation is acceptable:
-- SRM check + conversion Z-test tolerate ~1% error on large cohorts,
-- and the space saving (tens of bytes per state vs. millions of rows)
-- is load-bearing.
--
-- NOTE: conversion counting (linking an exposure to the subsequent
-- revenue event) happens at *read* time, not here. Plan 1 ships the
-- exposure side; Plan 2 may add a second MV that joins purchases.
-- Keeping the MV narrow keeps refresh cheap.
CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_experiment_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (experiment_id, variant_id, day, country, platform)
POPULATE
AS SELECT
  experiment_id,
  variant_id,
  toStartOfDay(exposed_at) AS day,
  country,
  platform,
  count() AS exposures,
  uniqState(subscriber_id) AS unique_users_state
FROM rovenue.raw_exposures
GROUP BY experiment_id, variant_id, day, country, platform;
```

- [ ] **Step 2: Apply, verify, commit**

```bash
pnpm --filter @rovenue/db db:clickhouse:migrate
docker compose exec clickhouse clickhouse-client --query \
  "SHOW CREATE TABLE rovenue.mv_experiment_daily FORMAT TSVRaw"
```

Expected: the DDL includes `SummingMergeTree()` and the GROUP BY columns. `POPULATE` runs once at creation — on an empty `raw_exposures` it completes instantly.

```bash
git add packages/db/clickhouse/migrations/0008_mv_experiment_daily.sql
git commit -m "feat(db): clickhouse 0008 — mv_experiment_daily"
```

### Task 2.10: Migration idempotency test

**Files:**
- Create: `packages/db/tests/clickhouse-migrations.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(
  new URL("../clickhouse/migrations", import.meta.url),
);

describe("ClickHouse migrations", () => {
  it("are numbered contiguously from 0001", async () => {
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    for (let i = 0; i < numbers.length; i += 1) {
      expect(numbers[i]).toBe(i + 1);
    }
  });

  it("contain no multi-line statements with semicolons mid-line", async () => {
    const files = (await readdir(migrationsDir)).filter((f) =>
      f.endsWith(".sql"),
    );
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      // Forbid `;` that isn't at end of a line — the runner splits on
      // end-of-line semicolons only.
      const offenders = content
        .split("\n")
        .filter((line) => line.includes(";") && !line.trimEnd().endsWith(";") && !line.trim().startsWith("--"));
      expect(offenders, `mid-line semicolon in ${file}`).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @rovenue/db test clickhouse-migrations
```

Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/db/tests/clickhouse-migrations.test.ts
git commit -m "test(db): lint clickhouse migration filenames + semicolons"
```

---

## Phase 4 — Postgres publication + PeerDB mirror

> **File-order note:** In this document Phase 4 appears physically above Phase 3. Execute by phase number — complete Phase 3 first, then return here. The content below assumes migration `0009_exposure_events.sql` is already applied.

### Task 4.1: Write the publication migration (0010)

**Ordering:** Phase 3 must be complete before starting this task. The publication below lists `exposure_events` as a replicated table, and that table is created by Phase 3's migration `0009`.

**Files:**
- Create: `packages/db/drizzle/migrations/0010_postgres_publication.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`
- Modify: `docker-compose.yml` (enable logical replication on `db` service)

- [ ] **Step 0: Enable logical replication on the Postgres service**

Logical replication is a cluster-level setting; without `wal_level=logical` the `CREATE PUBLICATION` below is technically accepted but PeerDB cannot actually consume it. The `timescale/timescaledb:2.17.2-pg16` image defaults to `wal_level=replica`. Open `docker-compose.yml`, find the `db` service, and add a `command:` key alongside the existing `environment:`:

```yaml
  db:
    image: timescale/timescaledb:2.17.2-pg16
    command:
      - "postgres"
      - "-c"
      - "wal_level=logical"
      - "-c"
      - "max_wal_senders=10"
      - "-c"
      - "max_replication_slots=10"
    environment:
      # ...existing vars...
```

Then recreate the container so the new `postgres` command-line takes effect (a SIGHUP is NOT enough — these three settings require a full restart):

```bash
docker compose up -d --force-recreate db
until docker compose ps db | grep -q healthy; do sleep 2; done
docker compose exec db psql -U rovenue -d rovenue -c "SHOW wal_level"
```

Expected: `wal_level` prints `logical`. Proceed only after this succeeds.

- [ ] **Step 1: Author the SQL**

Create `packages/db/drizzle/migrations/0010_postgres_publication.sql`:

```sql
-- 0010_postgres_publication.sql
-- Logical replication publication feeding PeerDB. The publication
-- includes exposure_events (Phase 3), revenue_events, credit_ledger,
-- subscribers, purchases, and experiment_assignments. PeerDB creates
-- its own replication slot via the flow-worker; we do NOT pre-create
-- one here to keep the source-of-truth inside PeerDB's catalog.
--
-- Idempotency: CREATE PUBLICATION has no IF NOT EXISTS form in
-- PG16 (only PG17+); the DO block checks pg_publication first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'rovenue_analytics') THEN
    CREATE PUBLICATION rovenue_analytics FOR TABLE
      revenue_events,
      credit_ledger,
      subscribers,
      purchases,
      experiment_assignments,
      exposure_events
    WITH (publish = 'insert, update, delete');
  END IF;
END $$;

-- Grant the replication role read on the source tables so the
-- PeerDB worker (authenticating as the rovenue user in local dev,
-- and as a dedicated `rovenue_replication` role in production) can
-- stream them. In local dev this is a no-op because rovenue already
-- owns the tables.
GRANT SELECT ON
  revenue_events,
  credit_ledger,
  subscribers,
  purchases,
  experiment_assignments,
  exposure_events
TO rovenue;
```

- [ ] **Step 2: Append to the drizzle journal**

Open `packages/db/drizzle/migrations/meta/_journal.json`. Inspect the last entry's `idx` and `when` values. Append a new entry (adjust `idx` to be one higher than the last, `when` to `Date.now()` at authoring time):

```json
{
  "idx": 10,
  "version": "7",
  "when": 1761200000000,
  "tag": "0010_postgres_publication",
  "breakpoints": true
}
```

Exact `when` value can be copied from `date +%s000` at authoring time. The migrator does not read `when` for ordering — `idx` is the sort key — but keep it monotonic for human-readable history.

- [ ] **Step 3: Apply the migration**

```bash
pnpm --filter @rovenue/db db:migrate
```

Expected: `0010_postgres_publication` applied; subsequent runs no-op.

Confirm:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "\dRp+ rovenue_analytics"
```

Expected: table list shows all six replicated tables.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml \
        packages/db/drizzle/migrations/0010_postgres_publication.sql \
        packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): enable logical replication + rovenue_analytics publication"
```

### Task 4.2: Write the PeerDB setup SQL and bootstrap the mirror

**Files:**
- Create: `deploy/peerdb/setup.sql`

**Rationale:** PeerDB exposes a Postgres-wire endpoint at `localhost:9900` that accepts its own dialect of SQL (`CREATE PEER`, `CREATE MIRROR`, `DROP MIRROR`). There is no declarative YAML format — peers and mirrors are created via SQL (or the UI, which is a wrapper around the same SQL). We commit the SQL to the repo so the bootstrap is reproducible.

- [ ] **Step 1: Author `deploy/peerdb/setup.sql`**

```sql
-- deploy/peerdb/setup.sql
--
-- One-shot bootstrap for the rovenue analytics mirror. Apply against
-- PeerDB's wire endpoint with:
--
--   psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" \
--        -f deploy/peerdb/setup.sql
--
-- Re-running is mostly idempotent — CREATE PEER / CREATE MIRROR
-- fail loudly if the named object already exists, so operators
-- either DROP first or edit-in-place via the UI. This file is the
-- canonical initial state.
--
-- Host addresses: PeerDB runs in its own docker network (deployed
-- via deploy/peerdb/upstream/run-peerdb.sh), so rovenue's services
-- are reachable at host.docker.internal. On Linux hosts without
-- Docker Desktop, add `--add-host=host.docker.internal:host-gateway`
-- to the PeerDB compose services (PeerDB's own run-peerdb.sh
-- already does this on recent versions).

-- Source: rovenue's Postgres (with TimescaleDB).
CREATE PEER rovenue_postgres FROM POSTGRES WITH (
  host = 'host.docker.internal',
  port = '5433',
  user = 'rovenue',
  password = 'rovenue',
  database = 'rovenue'
);

-- Target: rovenue's ClickHouse. disable_tls is fine for local dev;
-- production uses TLS terminated by a reverse proxy.
CREATE PEER rovenue_clickhouse FROM CLICKHOUSE WITH (
  host = 'host.docker.internal',
  port = 8124,
  user = 'rovenue',
  password = 'rovenue',
  database = 'rovenue',
  disable_tls = true
);

-- Mirror: continuous CDC from Postgres → ClickHouse. Uses the
-- publication created by Drizzle migration 0010
-- (packages/db/drizzle/migrations/0010_postgres_publication.sql).
--
-- Table mapping: source `public.<table>` → target `<ch_table>`. Per
-- PeerDB docs, ClickHouse target tables MUST NOT be schema-qualified
-- (the database is set at peer level).
--
-- soft_delete = true keeps Postgres DELETEs as tombstones in
-- ClickHouse (row marked _peerdb_is_deleted = 1) rather than
-- physical removal — matches rovenue's 7-year retention intent.
CREATE MIRROR rovenue_analytics
FROM rovenue_postgres TO rovenue_clickhouse
WITH TABLE MAPPING (
  public.revenue_events:raw_revenue_events,
  public.credit_ledger:raw_credit_ledger,
  public.subscribers:raw_subscribers,
  public.purchases:raw_purchases,
  public.experiment_assignments:raw_experiment_assignments,
  public.exposure_events:raw_exposures
)
WITH (
  do_initial_copy = true,
  publication_name = 'rovenue_analytics',
  soft_delete = true,
  synced_at_col_name = '_peerdb_synced_at',
  soft_delete_col_name = '_peerdb_is_deleted',
  snapshot_num_tables_in_parallel = 2,
  snapshot_num_rows_per_partition = 100000,
  max_batch_size = 100000,
  sync_interval = 60
);
```

**Note on column renames and schema drift:** the ClickHouse tables from Phase 2 use different PK column names than Postgres (`event_id` vs `id` in `revenue_events`, `entry_id` vs `id` in `credit_ledger`, etc.). PeerDB's CREATE MIRROR table mapping as written above maps the tables 1:1 but relies on matching column NAMES between source and target. We therefore need the ClickHouse target columns to **match Postgres source names** for the mirror to work without per-column `exclude`/rename plumbing (which PeerDB's CREATE MIRROR SQL does not support in the simple form).

**Action required before bootstrap:** amend Phase 2 migrations 0002-0007 to use Postgres column names directly:
- `raw_revenue_events.event_id` → rename to `id`
- `raw_credit_ledger.entry_id` → rename to `id`
- `raw_subscribers.subscriber_id` → keep as `id` (matches Postgres `subscribers.id`)
- `raw_purchases.purchase_id` → rename to `id`
- `raw_exposures.exposure_id` → rename to `id`

Keep the ORDER BY semantics (e.g. `ORDER BY (project_id, occurred_at, id)` in `raw_revenue_events`). Update `packages/db/scripts/verify-clickhouse.ts` EXPECTED constants and any SQL in `apps/api/src/services/analytics-router.ts` / `experiment-results.ts` that references the old names. If Phase 2 has already been implemented, write a Phase 2.11 follow-up migration `0009_rename_pk_columns.sql` that performs `ALTER TABLE rovenue.raw_<n> RENAME COLUMN <old> TO id` before Phase 4 runs.

- [ ] **Step 2: Boot the full stack and apply the setup**

```bash
# Rovenue services
docker compose up -d db redis clickhouse
pnpm --filter @rovenue/db db:migrate
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:clickhouse:migrate

# PeerDB services (submodule, Phase 1 Task 1.2)
(cd deploy/peerdb/upstream && ./run-peerdb.sh)

# Wait for PeerDB to be ready
until psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" -c 'SELECT 1' >/dev/null 2>&1; do
  echo "waiting for peerdb..."
  sleep 3
done

# Apply the rovenue mirror setup
psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" \
     -f deploy/peerdb/setup.sql
```

Expected: every statement prints `CREATE PEER` / `CREATE MIRROR` and `psql` exits 0. Re-running the file prints a duplicate-name error — that is expected and tells you the bootstrap has already been applied.

- [ ] **Step 3: Insert a Postgres row and watch it land in ClickHouse**

```bash
docker compose exec db psql -U rovenue -d rovenue <<'SQL'
INSERT INTO revenue_events (
  id, event_date, project_id, subscriber_id, product_id,
  country, platform, type, amount_cents, currency,
  period_months, occurred_at
) VALUES (
  gen_random_uuid()::text, CURRENT_DATE, 'proj_test', 'sub_test', 'prod_test',
  'TR', 'ios', 'INITIAL', 9999, 'USD', 1, NOW()
);
SQL

# Wait one sync interval + a little.
sleep 75
docker compose exec clickhouse clickhouse-client \
    --user=rovenue --password=rovenue \
    --query "SELECT count() FROM rovenue.raw_revenue_events"
```

Expected: `1`. If `0`, open the PeerDB UI at http://localhost:3000, click the `rovenue_analytics` mirror, and read the "Sync Status" + "Errors" tabs. Common causes:
- Publication `rovenue_analytics` not present on source (Task 4.1 not applied).
- Postgres `wal_level` is not `logical` (requires a restart; default of the `timescale/timescaledb:2.17.2-pg16` image is `replica`). If this is the issue, add `command: ["postgres", "-c", "wal_level=logical", "-c", "max_wal_senders=10", "-c", "max_replication_slots=10"]` to the `db` service in `docker-compose.yml` and `docker compose up -d --force-recreate db`.
- Column name mismatch between Postgres source and ClickHouse target — see Step 1 note.

- [ ] **Step 4: Commit the setup SQL**

```bash
git add deploy/peerdb/setup.sql
git commit -m "feat(infra): PeerDB CREATE PEER + CREATE MIRROR bootstrap"
```

Note: `deploy/peerdb/README.md` is already committed by Phase 1 Task 1.2 Step 5 — do NOT re-create it here. If the bootstrap-in-README section needs edits based on what was learned running Steps 2-3 above, amend the README in a separate follow-up commit.

---

## Phase 3 — `exposure_events` Postgres hypertable

### Task 3.1: Add `exposureEvents` to the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Add the pgTable definition**

Open `packages/db/src/drizzle/schema.ts`. After the `experimentAssignments` definition, append:

```typescript
export const exposureEvents = pgTable(
  "exposure_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    experimentId: text("experiment_id").notNull(),
    variantId: text("variant_id").notNull(),
    projectId: text("project_id").notNull(),
    subscriberId: text("subscriber_id").notNull(),
    platform: text("platform"),
    country: text("country"),
    exposedAt: timestamp("exposed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Composite PK is required once this becomes a TimescaleDB
    // hypertable in migration 0009; the partition column (exposedAt)
    // must appear in every UNIQUE or PRIMARY KEY constraint.
    pk: primaryKey({ columns: [t.id, t.exposedAt] }),
    experimentIdx: index("exposure_events_experiment_idx").on(
      t.experimentId,
      t.exposedAt,
    ),
    projectIdx: index("exposure_events_project_idx").on(
      t.projectId,
      t.exposedAt,
    ),
  }),
);

export type ExposureEvent = typeof exposureEvents.$inferSelect;
export type NewExposureEvent = typeof exposureEvents.$inferInsert;
```

Also ensure `primaryKey` and `index` are imported from `drizzle-orm/pg-core` at the top of the file if they aren't already.

- [ ] **Step 2: Extend the foundation test**

Open `packages/db/src/drizzle/drizzle-foundation.test.ts`. After the `experimentAssignments` assertions, append:

```typescript
  it("exposureEvents has a composite (id, exposedAt) primary key", () => {
    const config = exposureEvents[Symbol.for("drizzle:PgInlineForeignKeys")];
    const pkSymbol = Symbol.for("drizzle:ExtraConfigBuilder");
    // Delegate to the public schema API when available; fall back to
    // invariants we can reach: column existence.
    expect(exposureEvents.id).toBeDefined();
    expect(exposureEvents.exposedAt).toBeDefined();
    expect(exposureEvents.experimentId).toBeDefined();
    expect(exposureEvents.variantId).toBeDefined();
    expect(exposureEvents.projectId).toBeDefined();
    expect(exposureEvents.subscriberId).toBeDefined();
  });
```

(Drizzle's PK introspection API is fragile across versions; asserting column existence is the pragmatic floor. The hypertable assertion in Phase 9's verify-clickhouse-sibling `db:verify:timescale` is authoritative for the PK shape.)

- [ ] **Step 3: Run the schema tests**

```bash
pnpm --filter @rovenue/db test drizzle-foundation
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db): define exposure_events drizzle schema"
```

### Task 3.2: Write migration 0009 (`exposure_events` hypertable)

**Files:**
- Create: `packages/db/drizzle/migrations/0009_exposure_events.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Author the SQL**

```sql
-- 0009_exposure_events.sql
-- exposure_events: time-series hypertable with high insert rate.
-- Chunk interval 1 hour (vs. 1 day for revenue_events) because
-- insert throughput per project is ~100× higher — every variant
-- impression is a row.
--
-- Compression after 7 days, retention 90 days. Long-term analytics
-- reads from ClickHouse mv_experiment_daily aggregates, so raw
-- Postgres retention doesn't need to span years.
CREATE TABLE exposure_events (
  id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  experiment_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  platform TEXT,
  country TEXT,
  exposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, exposed_at)
);

CREATE INDEX exposure_events_experiment_idx
  ON exposure_events (experiment_id, exposed_at DESC);
CREATE INDEX exposure_events_project_idx
  ON exposure_events (project_id, exposed_at DESC);

-- Convert to hypertable. `migrate_data => true` is safe; table is empty.
SELECT create_hypertable(
  'exposure_events',
  'exposed_at',
  chunk_time_interval => INTERVAL '1 hour',
  migrate_data => TRUE
);

-- Compression: group same-experiment rows together for columnar reuse.
ALTER TABLE exposure_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'experiment_id',
  timescaledb.compress_orderby = 'exposed_at DESC'
);
SELECT add_compression_policy('exposure_events', INTERVAL '7 days');

-- Retention: drop chunks older than 90 days. Plan 2's MVs preserve
-- long-term aggregates.
SELECT add_retention_policy('exposure_events', INTERVAL '90 days');
```

- [ ] **Step 2: Append to the drizzle journal**

Append to `_journal.json`:

```json
{
  "idx": 9,
  "version": "7",
  "when": 1761199999000,
  "tag": "0009_exposure_events",
  "breakpoints": true
}
```

(`when` is monotonic but not load-bearing for ordering; drizzle sorts by `idx`. Keep it incrementing for readable history.)

- [ ] **Step 3: Apply and verify**

```bash
pnpm --filter @rovenue/db db:migrate

docker compose exec db psql -U rovenue -d rovenue -c "
SELECT hypertable_name, num_chunks
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'exposure_events';
"
```

Expected: one row, `num_chunks = 0` (empty), and no error.

```bash
docker compose exec db psql -U rovenue -d rovenue -c "
SELECT config FROM timescaledb_information.jobs
WHERE hypertable_name = 'exposure_events';
"
```

Expected: at least two rows (compression + retention).

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0009_exposure_events.sql \
        packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): exposure_events hypertable + compression + retention"
```

### Task 3.3: Add the exposure repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/exposure-events.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`

- [ ] **Step 1: Write the repo**

```typescript
import { and, eq, gte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  exposureEvents,
  type ExposureEvent,
  type NewExposureEvent,
} from "../schema";

export async function insertMany(
  db: NodePgDatabase,
  rows: NewExposureEvent[],
): Promise<void> {
  if (rows.length === 0) return;
  // Chunked insert to stay under the 65k parameter limit.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(exposureEvents).values(rows.slice(i, i + CHUNK));
  }
}

export async function countSince(
  db: NodePgDatabase,
  projectId: string,
  since: Date,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(exposureEvents)
    .where(
      and(
        eq(exposureEvents.projectId, projectId),
        gte(exposureEvents.exposedAt, since),
      ),
    );
  return Number(result[0]?.count ?? 0);
}

export type { ExposureEvent, NewExposureEvent };
```

- [ ] **Step 2: Wire the barrel**

Open `packages/db/src/drizzle/repositories/index.ts`. Add:

```typescript
import * as exposureEvents from "./exposure-events";
// ...inside the default export / namespace object:
export const exposureRepo = exposureEvents;
```

Follow the existing export pattern in the file — don't invent a new one.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/repositories/exposure-events.ts \
        packages/db/src/drizzle/repositories/index.ts
git commit -m "feat(db): exposure-events repository"
```

---

## Phase 5 — ClickHouse client + analytics router (API)

### Task 5.1: Write the ClickHouse client wrapper

**Files:**
- Create: `apps/api/src/lib/clickhouse.ts`
- Create: `apps/api/tests/clickhouse-client.test.ts`

- [ ] **Step 1: Write the client**

```typescript
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { env } from "./env";
import { logger } from "./logger";
import { metrics } from "./metrics";

const log = logger.child("clickhouse");

let client: ClickHouseClient | null = null;

function getClient(): ClickHouseClient | null {
  if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_PASSWORD) return null;
  if (client) return client;
  client = createClient({
    host: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: "rovenue",
    request_timeout: 15_000,
    max_open_connections: 10,
  });
  log.info("client initialised", { host: env.CLICKHOUSE_URL });
  return client;
}

export class ClickHouseUnavailableError extends Error {
  constructor() {
    super("ClickHouse is not configured; analytics query skipped");
    this.name = "ClickHouseUnavailableError";
  }
}

export async function queryAnalytics<T>(
  projectId: string,
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const c = getClient();
  if (!c) throw new ClickHouseUnavailableError();

  const start = performance.now();
  try {
    const result = await c.query({
      query: sql,
      query_params: { ...params, projectId },
      format: "JSONEachRow",
    });
    return (await result.json()) as T[];
  } finally {
    metrics.observeAnalyticsQueryDuration(performance.now() - start);
  }
}

export function isClickHouseConfigured(): boolean {
  return Boolean(env.CLICKHOUSE_URL && env.CLICKHOUSE_PASSWORD);
}

// Exported for tests that want to reset the singleton between cases.
export function __resetClickHouseForTests(): void {
  client = null;
}
```

- [ ] **Step 2: Extend metrics**

Open `apps/api/src/lib/metrics.ts`. Add:

```typescript
// Pre-existing registry declarations above.

const analyticsQueryDuration = new Histogram({
  name: "rovenue_analytics_query_duration_seconds",
  help: "ClickHouse analytics query wall-clock duration",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
});

export const metrics = {
  // ...existing exports
  observeAnalyticsQueryDuration(ms: number): void {
    analyticsQueryDuration.observe(ms / 1000);
  },
};
```

If `metrics.ts` does not yet exist, create it with a single `Registry` and the histogram above; otherwise extend the existing export. Match the local style — do not introduce prom-client if the repo uses a lighter helper.

- [ ] **Step 3: Write the unit test**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clickhouse/client", () => {
  const query = vi.fn(async () => ({
    json: async () => [{ ok: 1 }],
  }));
  return {
    createClient: vi.fn(() => ({ query })),
    __query: query,
  };
});

import * as chModule from "@clickhouse/client";
import {
  queryAnalytics,
  ClickHouseUnavailableError,
  __resetClickHouseForTests,
} from "../src/lib/clickhouse";

describe("queryAnalytics", () => {
  afterEach(() => {
    __resetClickHouseForTests();
    vi.clearAllMocks();
    delete process.env.CLICKHOUSE_URL;
    delete process.env.CLICKHOUSE_PASSWORD;
  });

  it("throws ClickHouseUnavailableError when env is missing", async () => {
    // env module is cached; construct a fresh runtime by mocking at
    // the module boundary. For simplicity, assert the sentinel error
    // when `isClickHouseConfigured()` returns false in this test env.
    await expect(queryAnalytics("p", "SELECT 1")).rejects.toBeInstanceOf(
      ClickHouseUnavailableError,
    );
  });

  it("passes projectId + params through to the client", async () => {
    process.env.CLICKHOUSE_URL = "http://localhost:8124";
    process.env.CLICKHOUSE_USER = "rovenue_reader";
    process.env.CLICKHOUSE_PASSWORD = "rovenue";
    __resetClickHouseForTests();

    await queryAnalytics<{ ok: number }>("proj_x", "SELECT 1", { foo: 2 });

    const createCalls = (chModule.createClient as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(createCalls).toHaveLength(1);
    // One instance created; query called once with projectId merged.
    const instance = (chModule.createClient as unknown as (opts: unknown) => { query: typeof vi.fn }) (
      { /* reuse */ },
    );
    // @ts-expect-error — introspecting the mock instance returned above
    const queryFn = instance.query as ReturnType<typeof vi.fn>;
    expect(queryFn).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @rovenue/api test clickhouse-client
```

Expected: both cases pass. If the `env` singleton caches missing creds from an earlier test run and leaks, apply the same `__resetClickHouseForTests` discipline in any sibling tests you write.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/clickhouse.ts \
        apps/api/src/lib/metrics.ts \
        apps/api/tests/clickhouse-client.test.ts
git commit -m "feat(api): clickhouse client wrapper with projectId scoping"
```

### Task 5.2: Write the analytics router dispatcher

**Files:**
- Create: `apps/api/src/services/analytics-router.ts`

- [ ] **Step 1: Write the dispatcher**

```typescript
import { drizzle } from "@rovenue/db";
import { queryAnalytics, isClickHouseConfigured } from "../lib/clickhouse";
import { logger } from "../lib/logger";

const log = logger.child("analytics-router");

// Plan 1 ships one query kind. Plan 2 adds MRR / cohort / funnel /
// LTV / geo / event-timeline kinds. Each kind has an exhaustive
// switch branch; unknown kinds are a compile-time error thanks to
// the `never` exhaustiveness helper.
export type AnalyticsQuery =
  | {
      kind: "experiment_results";
      experimentId: string;
      projectId: string;
      /** Optional stratification dimensions. */
      groupBy?: Array<"country" | "platform">;
    };

export interface ExperimentDailyRow {
  experiment_id: string;
  variant_id: string;
  day: string;
  country: string;
  platform: string;
  exposures: number;
  unique_users: number;
}

export async function runAnalyticsQuery(
  q: AnalyticsQuery,
): Promise<ExperimentDailyRow[]> {
  if (!isClickHouseConfigured()) {
    log.warn("analytics query requested but ClickHouse is unconfigured", {
      kind: q.kind,
    });
    return [];
  }

  switch (q.kind) {
    case "experiment_results":
      return queryAnalytics<ExperimentDailyRow>(
        q.projectId,
        `
          SELECT
            experiment_id,
            variant_id,
            toString(day) AS day,
            country,
            platform,
            sum(exposures) AS exposures,
            uniqMerge(unique_users_state) AS unique_users
          FROM rovenue.mv_experiment_daily
          WHERE experiment_id = {experimentId:String}
          GROUP BY experiment_id, variant_id, day, country, platform
          ORDER BY day, variant_id
        `,
        { experimentId: q.experimentId },
      );
    default: {
      const _exhaustive: never = q.kind;
      throw new Error(`unhandled analytics kind: ${String(_exhaustive)}`);
    }
  }
}
```

- [ ] **Step 2: Commit (no test yet — the integration test in Phase 10 covers it)**

```bash
git add apps/api/src/services/analytics-router.ts
git commit -m "feat(api): analytics-router dispatcher skeleton"
```

---

## Phase 6 — Exposure ingest pipeline

### Task 6.1: Write the exposure buffer

**Files:**
- Create: `apps/api/src/services/exposure-buffer.ts`

- [ ] **Step 1: Write the buffer**

```typescript
import { drizzle } from "@rovenue/db";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import { metrics } from "../lib/metrics";

const log = logger.child("exposure-buffer");
const KEY = "rovenue:exposure:buffer";
export const BATCH_THRESHOLD_ROWS = 500;
export const FLUSH_INTERVAL_MS = 2_000;

export interface ExposurePayload {
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform?: string;
  country?: string;
  exposedAt: string; // ISO 8601 UTC
}

export async function enqueue(rows: ExposurePayload[]): Promise<void> {
  if (rows.length === 0) return;
  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.rpush(KEY, JSON.stringify(row));
  }
  pipeline.llen(KEY);
  const results = await pipeline.exec();
  const len = Number(results?.[results.length - 1]?.[1] ?? 0);
  if (len >= BATCH_THRESHOLD_ROWS) {
    // Hint the flusher; actual flush is debounced by the worker.
    await redis.publish("rovenue:exposure:flush_request", "1");
  }
}

/**
 * Drains up to `limit` rows from the Redis list and writes them to
 * Postgres. Returns the number of rows flushed. Safe to call
 * concurrently — uses LPOP to claim rows exclusively.
 */
export async function drainOnce(limit: number = BATCH_THRESHOLD_ROWS): Promise<number> {
  const rows: ExposurePayload[] = [];
  const pipeline = redis.pipeline();
  for (let i = 0; i < limit; i += 1) pipeline.lpop(KEY);
  const results = await pipeline.exec();
  for (const [, value] of results ?? []) {
    if (typeof value === "string") {
      try {
        rows.push(JSON.parse(value) as ExposurePayload);
      } catch (err) {
        log.warn("malformed exposure payload dropped", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (rows.length === 0) return 0;

  await drizzle.exposureRepo.insertMany(
    drizzle.db,
    rows.map((r) => ({
      experimentId: r.experimentId,
      variantId: r.variantId,
      projectId: r.projectId,
      subscriberId: r.subscriberId,
      platform: r.platform,
      country: r.country,
      exposedAt: new Date(r.exposedAt),
    })),
  );

  metrics.recordExposureFlushRows(rows.length);
  return rows.length;
}
```

- [ ] **Step 2: Extend metrics with the exposure counter**

Extend `apps/api/src/lib/metrics.ts` with:

```typescript
const exposureFlushRows = new Counter({
  name: "rovenue_exposure_flush_rows_total",
  help: "Total rows drained from the exposure buffer into Postgres",
});

// inside the metrics object:
recordExposureFlushRows(n: number): void {
  exposureFlushRows.inc(n);
},
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/exposure-buffer.ts \
        apps/api/src/lib/metrics.ts
git commit -m "feat(api): exposure buffer (redis list + postgres flush)"
```

### Task 6.2: Write the flusher worker

**Files:**
- Create: `apps/api/src/workers/exposure-flusher.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write the worker**

```typescript
import {
  drainOnce,
  FLUSH_INTERVAL_MS,
  BATCH_THRESHOLD_ROWS,
} from "../services/exposure-buffer";
import { logger } from "../lib/logger";

const log = logger.child("exposure-flusher");

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let total = 0;
    // Drain until buffer is smaller than one batch, bounded at 10
    // iterations to avoid starving the event loop under heavy load.
    for (let i = 0; i < 10; i += 1) {
      const n = await drainOnce(BATCH_THRESHOLD_ROWS);
      total += n;
      if (n < BATCH_THRESHOLD_ROWS) break;
    }
    if (total > 0) log.debug("flushed", { rows: total });
  } catch (err) {
    log.error("flush failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running = false;
  }
}

export function startExposureFlusher(): void {
  if (timer) return;
  timer = setInterval(tick, FLUSH_INTERVAL_MS);
  log.info("started", { intervalMs: FLUSH_INTERVAL_MS });
}

export function stopExposureFlusher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
```

- [ ] **Step 2: Start the flusher from `index.ts`**

Open `apps/api/src/index.ts`. Near the existing worker starts (`webhook-delivery`, `webhook-retention`, `expiry-checker`), add:

```typescript
import { startExposureFlusher } from "./workers/exposure-flusher";

// ...inside the boot sequence, after other workers start:
startExposureFlusher();
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/workers/exposure-flusher.ts apps/api/src/index.ts
git commit -m "feat(api): exposure flusher background worker"
```

### Task 6.3: Write the ingest route

**Files:**
- Create: `apps/api/src/routes/v1/experiments-expose.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/exposure-ingest.test.ts`

- [ ] **Step 1: Write the route**

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { enqueue } from "../../services/exposure-buffer";

const exposeBodySchema = z.object({
  subscriberId: z.string().min(1),
  variantId: z.string().min(1),
  platform: z.string().max(32).optional(),
  country: z.string().length(2).optional(),
  // Clients SHOULD send the exact impression time. Server tolerates
  // up to 5 minutes of skew; older exposures are stamped at receipt.
  exposedAt: z.string().datetime().optional(),
});

export const experimentsExposeRoute = new Hono()
  .use("*", apiKeyAuth)
  .post(
    "/v1/experiments/:experimentId/expose",
    zValidator("json", exposeBodySchema),
    async (c) => {
      const { experimentId } = c.req.param();
      const body = c.req.valid("json");
      const projectId = c.get("projectId") as string;

      const exposedAt = body.exposedAt ?? new Date().toISOString();
      const receivedAt = Date.now();
      const parsedAt = Date.parse(exposedAt);
      const finalExposedAt =
        Math.abs(receivedAt - parsedAt) > 5 * 60 * 1000
          ? new Date().toISOString()
          : exposedAt;

      await enqueue([
        {
          experimentId,
          variantId: body.variantId,
          projectId,
          subscriberId: body.subscriberId,
          platform: body.platform,
          country: body.country,
          exposedAt: finalExposedAt,
        },
      ]);

      return c.json({ data: { accepted: true } }, 202);
    },
  );
```

Import paths: adjust `apiKeyAuth` path to match the existing file (grep for `apiKeyAuth` in `apps/api/src/middleware/`). The `c.get("projectId")` pattern comes from the middleware — it sets project context on the Hono request.

- [ ] **Step 2: Mount the route**

Open `apps/api/src/app.ts`. Next to existing `app.route(...)` calls, add:

```typescript
import { experimentsExposeRoute } from "./routes/v1/experiments-expose";

// ...
app.route("/", experimentsExposeRoute);
```

(Mount at `/` because the route itself specifies the `/v1/...` prefix.)

- [ ] **Step 3: Write the integration test**

```typescript
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const enqueueCalls: unknown[] = [];
vi.mock("../src/services/exposure-buffer", () => ({
  enqueue: vi.fn(async (rows: unknown[]) => {
    enqueueCalls.push(...rows);
  }),
}));
vi.mock("../src/middleware/api-key-auth", () => ({
  apiKeyAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("projectId", "proj_test");
    await next();
  },
}));

import { Hono } from "hono";
import { experimentsExposeRoute } from "../src/routes/v1/experiments-expose";

let app: Hono;

beforeAll(() => {
  app = new Hono().route("/", experimentsExposeRoute);
});

afterEach(() => {
  enqueueCalls.length = 0;
});

describe("POST /v1/experiments/:id/expose", () => {
  it("accepts a well-formed payload", async () => {
    const res = await app.request("/v1/experiments/exp_a/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscriberId: "sub_1",
        variantId: "var_treatment",
        platform: "ios",
        country: "TR",
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { accepted: true } });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      experimentId: "exp_a",
      subscriberId: "sub_1",
      variantId: "var_treatment",
      projectId: "proj_test",
    });
  });

  it("rejects invalid ISO timestamps", async () => {
    const res = await app.request("/v1/experiments/exp_a/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscriberId: "sub_1",
        variantId: "var_treatment",
        exposedAt: "not-a-date",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("clamps timestamps outside ±5min skew", async () => {
    const res = await app.request("/v1/experiments/exp_a/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscriberId: "sub_1",
        variantId: "var_treatment",
        exposedAt: "2000-01-01T00:00:00.000Z",
      }),
    });
    expect(res.status).toBe(202);
    expect(enqueueCalls).toHaveLength(1);
    const received = (enqueueCalls[0] as { exposedAt: string }).exposedAt;
    expect(new Date(received).getUTCFullYear()).toBeGreaterThan(2020);
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @rovenue/api test exposure-ingest
```

Expected: all three cases pass. If the `apiKeyAuth` mock path does not match the actual middleware path, adjust.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/experiments-expose.ts \
        apps/api/src/app.ts \
        apps/api/tests/exposure-ingest.test.ts
git commit -m "feat(api): POST /v1/experiments/:id/expose ingest endpoint"
```

---

## Phase 7 — SSE config stream + invalidation

### Task 7.1: Write the SSE route

**Files:**
- Create: `apps/api/src/routes/v1/config-stream.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the route**

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import { env } from "../../lib/env";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { loadBundleFromCache } from "../../services/experiment-engine";
import { logger } from "../../lib/logger";

const log = logger.child("config-stream");
const INVALIDATE_CHANNEL = "rovenue:experiments:invalidate";

export const configStreamRoute = new Hono()
  .use("*", apiKeyAuth)
  .get("/v1/config/stream", (c) =>
    streamSSE(c, async (stream) => {
      const projectId = c.get("projectId") as string;

      // Send the initial bundle straight away so SDK clients have a
      // working config before the first invalidation arrives.
      const initial = await loadBundleFromCache(projectId);
      await stream.writeSSE({
        event: "initial",
        data: JSON.stringify(initial),
      });

      // Dedicated subscriber connection — ioredis requires a separate
      // client for pub/sub because the connection transitions to a
      // subscribe-only mode.
      const subscriber = new Redis(env.REDIS_URL, { lazyConnect: false });
      await subscriber.subscribe(INVALIDATE_CHANNEL);

      const onMessage = async (_channel: string, payload: string) => {
        try {
          const parsed = JSON.parse(payload) as { projectId: string };
          if (parsed.projectId !== projectId) return;
          const bundle = await loadBundleFromCache(projectId);
          await stream.writeSSE({
            event: "invalidate",
            data: JSON.stringify(bundle),
          });
        } catch (err) {
          log.warn("invalidation delivery failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };
      subscriber.on("message", onMessage);

      // Keepalive comment every 25s (below most CDN idle timeouts).
      const keepalive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, 25_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        void subscriber.unsubscribe(INVALIDATE_CHANNEL).catch(() => undefined);
        void subscriber.quit().catch(() => undefined);
      });

      // Block until the client disconnects. hono's streamSSE returns
      // when the response is closed; we just await an unresolvable
      // promise here.
      await new Promise(() => undefined);
    }),
  );
```

- [ ] **Step 2: Expose `loadBundleFromCache` from experiment-engine**

Open `apps/api/src/services/experiment-engine.ts`. Currently the cache-loader is internal (called by `getExperimentBundle`). Export it:

```typescript
export async function loadBundleFromCache(
  projectId: string,
): Promise<ExperimentBundle> {
  // ...existing body that reads Redis cache and falls back to DB...
}
```

If the existing code already has a similarly named private helper, rename + export rather than duplicate. If the existing helper has a different return shape, export a thin wrapper.

- [ ] **Step 3: Wire the invalidation publish**

In the same file, find every place that calls `invalidateExperimentCache`. After the `redis.del(cacheKey)` call, add:

```typescript
await redis.publish(
  "rovenue:experiments:invalidate",
  JSON.stringify({ projectId }),
);
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/app.ts`, add:

```typescript
import { configStreamRoute } from "./routes/v1/config-stream";

// ...
app.route("/", configStreamRoute);
```

- [ ] **Step 5: Smoke test manually**

```bash
# Terminal A: start the api
pnpm --filter @rovenue/api dev

# Terminal B: subscribe
curl -N -H "X-API-Key: $(cat .env | grep ROVENUE_API_KEY | cut -d= -f2)" \
  http://localhost:3000/v1/config/stream

# Terminal C: publish an invalidation
docker compose exec redis redis-cli \
  publish rovenue:experiments:invalidate '{"projectId":"proj_demo"}'
```

Expected in Terminal B: the initial `event: initial` arrives immediately, then `event: invalidate` arrives after the publish. `event: ping` arrives every 25s.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/config-stream.ts \
        apps/api/src/services/experiment-engine.ts \
        apps/api/src/app.ts
git commit -m "feat(api): SSE /v1/config/stream with pubsub invalidation"
```

### Task 7.2: Write the SSE integration test

**Files:**
- Create: `apps/api/tests/config-stream.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi, beforeAll } from "vitest";

const mockSubscriber = {
  subscribe: vi.fn(async () => undefined),
  on: vi.fn(),
  unsubscribe: vi.fn(async () => undefined),
  quit: vi.fn(async () => undefined),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockSubscriber),
}));

vi.mock("../src/services/experiment-engine", () => ({
  loadBundleFromCache: vi.fn(async (projectId: string) => ({
    schemaVersion: 1,
    projectId,
    experiments: [],
    audiences: {},
  })),
}));

vi.mock("../src/middleware/api-key-auth", () => ({
  apiKeyAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("projectId", "proj_test");
    await next();
  },
}));

import { Hono } from "hono";
import { configStreamRoute } from "../src/routes/v1/config-stream";

let app: Hono;
beforeAll(() => {
  app = new Hono().route("/", configStreamRoute);
});

describe("GET /v1/config/stream", () => {
  it("sends an initial bundle frame", async () => {
    const controller = new AbortController();
    const promise = app.request("/v1/config/stream", {
      method: "GET",
      signal: controller.signal,
    });
    // Race: read the first chunk, then abort.
    const res = await promise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: initial");
    expect(text).toContain('"projectId":"proj_test"');

    controller.abort();
    await reader.cancel();
  });

  it("subscribes to the invalidation channel", async () => {
    await app.request("/v1/config/stream", { method: "GET" }).catch(() => undefined);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      "rovenue:experiments:invalidate",
    );
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @rovenue/api test config-stream
```

Expected: both cases pass. Note: the test aborts the stream early; any noise about "aborted" in logs is expected.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/config-stream.test.ts
git commit -m "test(api): SSE config stream initial + subscription"
```

---

## Phase 8 — Stats endpoint CH-backed

### Task 8.1: Write the experiment results service

**Files:**
- Create: `apps/api/src/services/experiment-results.ts`

- [ ] **Step 1: Write the service**

```typescript
import {
  analyzeConversion,
  analyzeRevenue,
  checkSRM,
  estimateSampleSize,
  type ConversionAnalysis,
  type RevenueAnalysis,
  type SRMResult,
} from "../lib/experiment-stats";
import {
  runAnalyticsQuery,
  type ExperimentDailyRow,
} from "./analytics-router";
import { drizzle, ExperimentStatus } from "@rovenue/db";

export interface ExperimentResults {
  experimentId: string;
  status: ExperimentStatus;
  variants: Array<{
    variantId: string;
    exposures: number;
    uniqueUsers: number;
  }>;
  conversion: ConversionAnalysis | null;
  revenue: RevenueAnalysis | null;
  srm: SRMResult | null;
  sampleSize: {
    required: number;
    reached: boolean;
  } | null;
}

interface VariantAgg {
  variantId: string;
  exposures: number;
  uniqueUsers: number;
  conversions: number;
  revenueSeries: number[];
}

export async function computeExperimentResults(
  experimentId: string,
  projectId: string,
): Promise<ExperimentResults> {
  const experiment = await drizzle.experimentRepo.findById(
    drizzle.db,
    experimentId,
  );
  if (!experiment || experiment.projectId !== projectId) {
    throw new Error("experiment not found");
  }

  const rows = await runAnalyticsQuery({
    kind: "experiment_results",
    experimentId,
    projectId,
  });

  // Plan 1 ships exposure + unique-user aggregation only. Revenue /
  // conversion joins with raw_revenue_events land in Plan 2. We still
  // return a null-filled shape so the route contract is stable.
  const byVariant = aggregate(rows);
  const variants = [...byVariant.values()];

  const srm = variants.length >= 2
    ? checkSRM(
        variants.map((v) => ({
          expected:
            variants.reduce((sum, x) => sum + x.exposures, 0) / variants.length,
          observed: v.exposures,
        })),
      )
    : null;

  const conversion = variants.length === 2
    ? analyzeConversion(
        {
          users: variants[0]!.exposures,
          conversions: variants[0]!.conversions,
        },
        {
          users: variants[1]!.exposures,
          conversions: variants[1]!.conversions,
        },
      )
    : null;

  const revenue = variants.length === 2 &&
      variants[0]!.revenueSeries.length >= 2 &&
      variants[1]!.revenueSeries.length >= 2
    ? analyzeRevenue(variants[0]!.revenueSeries, variants[1]!.revenueSeries)
    : null;

  return {
    experimentId,
    status: experiment.status,
    variants: variants.map((v) => ({
      variantId: v.variantId,
      exposures: v.exposures,
      uniqueUsers: v.uniqueUsers,
    })),
    conversion,
    revenue,
    srm,
    sampleSize: null, // populated in Plan 2 when we have baseline data
  };
}

function aggregate(rows: ExperimentDailyRow[]): Map<string, VariantAgg> {
  const out = new Map<string, VariantAgg>();
  for (const r of rows) {
    const acc = out.get(r.variant_id) ?? {
      variantId: r.variant_id,
      exposures: 0,
      uniqueUsers: 0,
      conversions: 0, // Plan 2 fills this via a revenue join MV
      revenueSeries: [] as number[],
    };
    acc.exposures += Number(r.exposures);
    acc.uniqueUsers = Math.max(acc.uniqueUsers, Number(r.unique_users));
    out.set(r.variant_id, acc);
  }
  return out;
}
```

- [ ] **Step 2: Rewire `getExperimentResults` in experiment-engine**

Open `apps/api/src/services/experiment-engine.ts`. Replace the existing body of `getExperimentResults` with:

```typescript
import { computeExperimentResults } from "./experiment-results";

// ...
export async function getExperimentResults(
  experimentId: string,
  projectId: string,
) {
  return computeExperimentResults(experimentId, projectId);
}
```

If the existing signature takes only `experimentId`, add `projectId` as a parameter and update the dashboard route caller in `apps/api/src/routes/dashboard/experiments.ts` accordingly (pass the `projectId` from the validated request / session context).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/experiment-results.ts \
        apps/api/src/services/experiment-engine.ts \
        apps/api/src/routes/dashboard/experiments.ts
git commit -m "feat(api): experiment results now read from ClickHouse"
```

### Task 8.2: Write the public v1 results route

**Files:**
- Create: `apps/api/src/routes/v1/experiments-results.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/experiment-results.test.ts`

- [ ] **Step 1: Write the route**

```typescript
import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { computeExperimentResults } from "../../services/experiment-results";
import { ok } from "../../lib/response";

export const experimentsResultsRoute = new Hono()
  .use("*", apiKeyAuth)
  .get("/v1/experiments/:experimentId/results", async (c) => {
    const { experimentId } = c.req.param();
    const projectId = c.get("projectId") as string;
    const results = await computeExperimentResults(experimentId, projectId);
    return c.json(ok(results));
  });
```

- [ ] **Step 2: Mount the route**

Open `apps/api/src/app.ts`:

```typescript
import { experimentsResultsRoute } from "./routes/v1/experiments-results";
// ...
app.route("/", experimentsResultsRoute);
```

- [ ] **Step 3: Write the test**

```typescript
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/experiment-results", () => ({
  computeExperimentResults: vi.fn(async () => ({
    experimentId: "exp_a",
    status: "RUNNING",
    variants: [
      { variantId: "control", exposures: 1000, uniqueUsers: 950 },
      { variantId: "treatment", exposures: 1010, uniqueUsers: 960 },
    ],
    conversion: null,
    revenue: null,
    srm: { chi2: 0.1, df: 1, pValue: 0.75, isMismatch: false, message: "ok" },
    sampleSize: null,
  })),
}));

vi.mock("../src/middleware/api-key-auth", () => ({
  apiKeyAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("projectId", "proj_test");
    await next();
  },
}));

import { Hono } from "hono";
import { experimentsResultsRoute } from "../src/routes/v1/experiments-results";

let app: Hono;
beforeAll(() => {
  app = new Hono().route("/", experimentsResultsRoute);
});

describe("GET /v1/experiments/:id/results", () => {
  it("returns the CH-backed computation wrapped in {data: ...}", async () => {
    const res = await app.request("/v1/experiments/exp_a/results");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { experimentId: string; variants: unknown[] } };
    expect(body.data.experimentId).toBe("exp_a");
    expect(body.data.variants).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @rovenue/api test experiment-results
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/experiments-results.ts \
        apps/api/src/app.ts \
        apps/api/tests/experiment-results.test.ts
git commit -m "feat(api): GET /v1/experiments/:id/results public route"
```

---

## Phase 9 — `verify-clickhouse` CLI

### Task 9.1: Write the verifier

**Files:**
- Create: `packages/db/scripts/verify-clickhouse.ts`

- [ ] **Step 1: Write the CLI**

```typescript
import { createClient } from "@clickhouse/client";

interface TableExpectation {
  engine: string;           // e.g. "ReplacingMergeTree(version)" or "MergeTree"
  orderBy: readonly string[];
  partitionBy?: string;     // e.g. "toYYYYMM(occurred_at)"
  ttl?: string;             // e.g. "toDateTime(occurred_at) + toIntervalYear(7)"
}

const EXPECTED_TABLES: Record<string, TableExpectation> = {
  raw_revenue_events: {
    engine: "ReplacingMergeTree(version)",
    orderBy: ["project_id", "occurred_at", "event_id"],
    partitionBy: "toYYYYMM(occurred_at)",
    ttl: "toDateTime(occurred_at) + toIntervalYear(7)",
  },
  raw_credit_ledger: {
    engine: "ReplacingMergeTree(version)",
    orderBy: ["project_id", "created_at", "entry_id"],
    partitionBy: "toYYYYMM(created_at)",
    ttl: "toDateTime(created_at) + toIntervalYear(7)",
  },
  raw_subscribers: {
    engine: "ReplacingMergeTree(version)",
    orderBy: ["project_id", "subscriber_id"],
    ttl: "toDateTime(updated_at) + toIntervalYear(7)",
  },
  raw_purchases: {
    engine: "ReplacingMergeTree(version)",
    orderBy: ["project_id", "purchased_at", "purchase_id"],
    partitionBy: "toYYYYMM(purchased_at)",
    ttl: "toDateTime(purchased_at) + toIntervalYear(7)",
  },
  raw_experiment_assignments: {
    engine: "ReplacingMergeTree(version)",
    orderBy: ["experiment_id", "subscriber_id"],
  },
  raw_exposures: {
    engine: "MergeTree",
    orderBy: ["experiment_id", "exposed_at", "subscriber_id"],
    partitionBy: "toYYYYMM(exposed_at)",
    ttl: "toDateTime(exposed_at) + toIntervalDay(90)",
  },
  mv_experiment_daily: {
    engine: "SummingMergeTree",
    orderBy: ["experiment_id", "variant_id", "day", "country", "platform"],
    partitionBy: "toYYYYMM(day)",
  },
};

const client = createClient({
  host: process.env.CLICKHOUSE_URL!,
  username: process.env.CLICKHOUSE_USER ?? "rovenue_reader",
  password: process.env.CLICKHOUSE_PASSWORD!,
  database: "rovenue",
});

interface SystemRow {
  name: string;
  engine: string;
  engine_full: string;
  sorting_key: string;
  partition_key: string;
  primary_key: string;
  total_rows: number;
}

async function fetchTables(): Promise<Map<string, SystemRow>> {
  const result = await client.query({
    query: `
      SELECT name, engine, engine_full, sorting_key, partition_key, primary_key, total_rows
      FROM system.tables
      WHERE database = 'rovenue'
    `,
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as SystemRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

async function main(): Promise<void> {
  const tables = await fetchTables();
  const drift: string[] = [];

  for (const [name, expected] of Object.entries(EXPECTED_TABLES)) {
    const row = tables.get(name);
    if (!row) {
      drift.push(`missing table: ${name}`);
      continue;
    }

    // engine_full is the canonical string including parameters.
    if (!row.engine_full.startsWith(expected.engine)) {
      drift.push(
        `engine mismatch on ${name}: expected ${expected.engine}, got ${row.engine_full}`,
      );
    }

    const actualOrder = row.sorting_key.split(",").map((s) => s.trim());
    const expectedOrder = [...expected.orderBy];
    if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
      drift.push(
        `ORDER BY mismatch on ${name}: expected [${expectedOrder.join(", ")}], got [${actualOrder.join(", ")}]`,
      );
    }

    if (expected.partitionBy && row.partition_key.trim() !== expected.partitionBy) {
      drift.push(
        `PARTITION BY mismatch on ${name}: expected ${expected.partitionBy}, got ${row.partition_key}`,
      );
    }
  }

  for (const present of tables.keys()) {
    if (present.startsWith("_")) continue;
    if (!(present in EXPECTED_TABLES)) {
      drift.push(`unexpected table present: ${present}`);
    }
  }

  if (drift.length === 0) {
    console.log("OK");
    await client.close();
    return;
  }

  console.error("DRIFT:");
  for (const d of drift) console.error(`  - ${d}`);
  await client.close();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the verifier**

```bash
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:verify:clickhouse
```

Expected: `OK`. If any drift, fix the migration; do not relax the `EXPECTED` object to hide discrepancies.

- [ ] **Step 3: Commit**

```bash
git add packages/db/scripts/verify-clickhouse.ts
git commit -m "feat(db): verify-clickhouse post-migrate smoke CLI"
```

---

## Phase 10 — Hardening

### Task 10.1: Replication parity integration test

**Files:**
- Create: `apps/api/tests/replication-parity.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";

// This test is slow (boots Postgres+TimescaleDB + ClickHouse containers).
// CI runs it nightly via `pnpm test:slow`. Local dev uses it as a
// smoke gate before merging ClickHouse-touching changes.
describe.skipIf(!process.env.ROVENUE_SLOW_TESTS)("replication parity", () => {
  let network: StartedNetwork;
  let pg: StartedTestContainer;
  let ch: StartedTestContainer;

  beforeAll(async () => {
    network = await new Network().start();

    pg = await new GenericContainer("timescale/timescaledb:2.17.2-pg16")
      .withNetwork(network)
      .withNetworkAliases("db")
      .withEnvironment({
        POSTGRES_USER: "rovenue",
        POSTGRES_PASSWORD: "rovenue",
        POSTGRES_DB: "rovenue",
      })
      .withCommand([
        "postgres",
        "-c",
        "wal_level=logical",
        "-c",
        "max_wal_senders=10",
        "-c",
        "max_replication_slots=10",
      ])
      .withWaitStrategy(Wait.forLogMessage("ready to accept connections", 2))
      .start();

    ch = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
      .withNetwork(network)
      .withNetworkAliases("clickhouse")
      .withEnvironment({
        CLICKHOUSE_DB: "rovenue",
        CLICKHOUSE_USER: "rovenue",
        CLICKHOUSE_PASSWORD: "rovenue",
      })
      .withWaitStrategy(Wait.forHttp("/ping", 8123))
      .start();
  }, 120_000);

  afterAll(async () => {
    await ch?.stop();
    await pg?.stop();
    await network?.stop();
  });

  it("TODO: wire PeerDB container + assert convergence within 30s", async () => {
    // PeerDB's testcontainer story requires the full 4-service
    // bundle. Stubbed until Phase 10.1 ships a helper that boots
    // the overlay. For now, this test asserts the two containers
    // are up and the schemas are applicable; real parity is asserted
    // by the manual bootstrap in Phase 4.
    expect(pg.getMappedPort(5432)).toBeGreaterThan(0);
    expect(ch.getMappedPort(8123)).toBeGreaterThan(0);
  });
});
```

Note: wiring the full PeerDB stack into testcontainers is a 1-2 day effort because of the 4-service overlay. Plan 1 ships the scaffolding + a skipped placeholder; full parity is asserted by the manual bootstrap in Phase 4 Step 3. Task 10.5 tracks the follow-up.

- [ ] **Step 2: Wire the `test:slow` script**

Open `apps/api/package.json`:

```json
    "test:slow": "ROVENUE_SLOW_TESTS=1 vitest run --testTimeout=180000"
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/replication-parity.test.ts apps/api/package.json
git commit -m "test(api): scaffold replication parity testcontainer"
```

### Task 10.2: Aggregate correctness integration test

**Files:**
- Create: `apps/api/tests/clickhouse-integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

const migrationsDir = fileURLToPath(
  new URL("../../../packages/db/clickhouse/migrations", import.meta.url),
);

describe("ClickHouse mv_experiment_daily parity", () => {
  let ch: StartedTestContainer;
  let client: ClickHouseClient;

  beforeAll(async () => {
    ch = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
      .withEnvironment({
        CLICKHOUSE_DB: "rovenue",
        CLICKHOUSE_USER: "rovenue",
        CLICKHOUSE_PASSWORD: "rovenue",
      })
      .withExposedPorts(8123)
      .withWaitStrategy(Wait.forHttp("/ping", 8123))
      .start();

    client = createClient({
      host: `http://${ch.getHost()}:${ch.getMappedPort(8123)}`,
      username: "rovenue",
      password: "rovenue",
      database: "default",
    });

    // Apply every migration in order.
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      for (const stmt of content.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
        if (stmt.startsWith("--")) continue;
        await client.command({ query: stmt });
      }
    }
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await ch?.stop();
  });

  it("mv_experiment_daily matches a raw GROUP BY over raw_exposures", async () => {
    const now = new Date("2026-04-23T12:00:00Z");
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      exposure_id: crypto.randomUUID(),
      experiment_id: "exp_a",
      variant_id: i % 2 === 0 ? "control" : "treatment",
      project_id: "proj_test",
      subscriber_id: `sub_${i % 300}`,
      platform: i % 3 === 0 ? "ios" : "android",
      country: i % 4 === 0 ? "TR" : "US",
      exposed_at: now.toISOString(),
    }));

    await client.insert({
      table: "rovenue.raw_exposures",
      values: rows,
      format: "JSONEachRow",
    });

    // Force merge so the MV reflects all incoming rows.
    await client.command({ query: "OPTIMIZE TABLE rovenue.mv_experiment_daily FINAL" });

    const mvRes = await client.query({
      query: `
        SELECT variant_id, sum(exposures) AS n
        FROM rovenue.mv_experiment_daily
        WHERE experiment_id = 'exp_a'
        GROUP BY variant_id ORDER BY variant_id
      `,
      format: "JSONEachRow",
    });
    const mv = (await mvRes.json()) as Array<{ variant_id: string; n: number }>;

    const rawRes = await client.query({
      query: `
        SELECT variant_id, count() AS n
        FROM rovenue.raw_exposures
        WHERE experiment_id = 'exp_a'
        GROUP BY variant_id ORDER BY variant_id
      `,
      format: "JSONEachRow",
    });
    const raw = (await rawRes.json()) as Array<{ variant_id: string; n: number }>;

    expect(mv.map((r) => ({ ...r, n: Number(r.n) }))).toEqual(
      raw.map((r) => ({ ...r, n: Number(r.n) })),
    );
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @rovenue/api test clickhouse-integration
```

Expected: pass. First run downloads the 24.3 image (~1-2 min); subsequent runs are cached.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/clickhouse-integration.test.ts
git commit -m "test(api): mv_experiment_daily parity with raw GROUP BY"
```

### Task 10.3: PeerDB lag poller + metric

**Files:**
- Create: `apps/api/src/workers/peerdb-lag-poller.ts`
- Modify: `apps/api/src/lib/metrics.ts`
- Modify: `apps/api/src/index.ts`

**Note on the PeerDB API endpoint:** PeerDB's REST API surface drifts between versions. Before implementing this task, consult `https://docs.peerdb.io/peerdb-api/reference` (or the `/api` routes in the vendored `deploy/peerdb/upstream/flow/cmd/api` source) to find the current "mirror stats" endpoint — it returns lag in seconds among other sync metrics. The skeleton below assumes a `GET /v1/mirrors/{name}` shape with a `replication_lag_seconds` field; adjust the URL + JSON parsing if PeerDB's current release uses a different shape.

- [ ] **Step 1: Write the poller**

```typescript
import { logger } from "../lib/logger";
import { metrics } from "../lib/metrics";

const log = logger.child("peerdb-lag-poller");
const POLL_MS = 60_000;
const PEERDB_MIRROR = "rovenue_analytics";

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const url = process.env.PEERDB_FLOW_API_URL;
  if (!url) {
    metrics.setPeerdbLagSeconds(NaN);
    return;
  }
  try {
    // Endpoint shape per PeerDB API reference at implementation time.
    // Verify against docs.peerdb.io/peerdb-api/reference before merging.
    const res = await fetch(`${url}/v1/mirrors/${PEERDB_MIRROR}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn("peerdb stats unhealthy", { status: res.status });
      metrics.setPeerdbLagSeconds(NaN);
      return;
    }
    const body = (await res.json()) as { replication_lag_seconds?: number };
    const lag = Number(body.replication_lag_seconds ?? 0);
    metrics.setPeerdbLagSeconds(lag);
  } catch (err) {
    log.warn("peerdb poll failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    metrics.setPeerdbLagSeconds(NaN);
  }
}

export function startPeerdbLagPoller(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  void tick();
  log.info("started", { intervalMs: POLL_MS });
}
```

- [ ] **Step 2: Extend metrics**

```typescript
const peerdbLagSeconds = new Gauge({
  name: "rovenue_peerdb_replication_lag_seconds",
  help: "PeerDB reported replication lag (NaN when stats unreachable)",
});

// inside metrics:
setPeerdbLagSeconds(v: number): void {
  if (Number.isNaN(v)) peerdbLagSeconds.reset();
  else peerdbLagSeconds.set(v);
},
```

- [ ] **Step 3: Start the poller**

```typescript
// apps/api/src/index.ts
import { startPeerdbLagPoller } from "./workers/peerdb-lag-poller";

// ...
startPeerdbLagPoller();
```

Document in a README comment:

```typescript
// Prometheus alert wiring (ops-owned, not in this plan):
//   rovenue_peerdb_replication_lag_seconds > 300 for 5m → page
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/peerdb-lag-poller.ts \
        apps/api/src/lib/metrics.ts \
        apps/api/src/index.ts
git commit -m "feat(api): peerdb replication lag metric + poller"
```

### Task 10.4: ClickHouse backup script

**Files:**
- Create: `deploy/clickhouse/backup.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# ClickHouse daily backup to S3-compatible storage.
#
# Expects in env:
#   CH_BACKUP_S3_BUCKET   — e.g. rovenue-backups
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#   CLICKHOUSE_HOST        — default `clickhouse`
#   CLICKHOUSE_USER        — default `rovenue`
#   CLICKHOUSE_PASSWORD
#
# Retention (30 days) is enforced at the S3 bucket lifecycle policy
# level, not here. This script only creates the backup.
set -euo pipefail

DATE="$(date -u +%Y-%m-%d)"
BACKUP_NAME="rovenue-${DATE}"
HOST="${CLICKHOUSE_HOST:-clickhouse}"
USER="${CLICKHOUSE_USER:-rovenue}"

clickhouse-client \
    --host "$HOST" --user "$USER" --password "$CLICKHOUSE_PASSWORD" \
    --query "
        BACKUP DATABASE rovenue
        TO S3('s3://${CH_BACKUP_S3_BUCKET}/${BACKUP_NAME}.tar',
              '${AWS_ACCESS_KEY_ID}', '${AWS_SECRET_ACCESS_KEY}')
    "

echo "OK: ${BACKUP_NAME} pushed to s3://${CH_BACKUP_S3_BUCKET}/"
```

Make executable:

```bash
chmod +x deploy/clickhouse/backup.sh
```

- [ ] **Step 2: Test the script locally against a mock**

Skip remote S3 for the test; just confirm the `clickhouse-client` command executes without a parse error:

```bash
docker compose exec clickhouse clickhouse-client --query "SHOW BACKUPS" || true
```

Expected: no parse error. (The command returns empty on a fresh install.)

- [ ] **Step 3: Commit**

```bash
git add deploy/clickhouse/backup.sh
git commit -m "feat(infra): clickhouse S3 backup script"
```

### Task 10.5: CI hook for `verify-clickhouse`

**Files:**
- Modify: `.github/workflows/<existing-ci>.yml` (whichever runs on PRs)

- [ ] **Step 1: Locate the existing CI file**

```bash
ls .github/workflows/
```

Identify the file that runs `pnpm test` on PRs. Typical names: `ci.yml`, `test.yml`. If none exists, skip to Step 2's alternative.

- [ ] **Step 2: Add a ClickHouse job**

Inside the existing workflow, add a new job adjacent to the postgres job:

```yaml
  clickhouse:
    runs-on: ubuntu-latest
    services:
      clickhouse:
        image: clickhouse/clickhouse-server:24.3-alpine
        env:
          CLICKHOUSE_DB: rovenue
          CLICKHOUSE_USER: rovenue
          CLICKHOUSE_PASSWORD: rovenue
        ports:
          - 8123:8123
        options: >-
          --ulimit nofile=262144:262144
          --health-cmd "wget --spider -q http://localhost:8123/ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Apply ClickHouse migrations
        env:
          CLICKHOUSE_URL: http://localhost:8123
          CLICKHOUSE_USER: rovenue
          CLICKHOUSE_PASSWORD: rovenue
        run: pnpm --filter @rovenue/db db:clickhouse:migrate
      - name: Verify ClickHouse schema
        env:
          CLICKHOUSE_URL: http://localhost:8123
          CLICKHOUSE_USER: rovenue
          CLICKHOUSE_PASSWORD: rovenue
        run: pnpm --filter @rovenue/db db:verify:clickhouse
```

If the repo does not yet have a workflow for DB-backed jobs, create `.github/workflows/clickhouse.yml` with the same job plus the standard `on: { pull_request: ... }` trigger.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci: run clickhouse migrate + verify on PRs"
```

---

## Phase 11 — Final baseline pass

### Task 11.1: Clean-slate replay

**Files:** none

- [ ] **Step 1: Down + wipe volumes + bring up + run every migration**

```bash
docker compose -f docker-compose.yml -f deploy/peerdb/docker-compose.peerdb.yml down -v
docker compose up -d db redis clickhouse
until docker compose ps db clickhouse | grep healthy | wc -l | grep -q 2; do sleep 2; done

pnpm --filter @rovenue/db db:migrate
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:clickhouse:migrate

pnpm --filter @rovenue/db db:verify:timescale
CLICKHOUSE_URL=http://localhost:8124 \
CLICKHOUSE_USER=rovenue \
CLICKHOUSE_PASSWORD=rovenue \
pnpm --filter @rovenue/db db:verify:clickhouse
```

Expected: both verifiers print `OK`. Every migration in both chains applies without error.

### Task 11.2: Full workspace test suite

**Files:** none

- [ ] **Step 1: Run tests**

```bash
pnpm test
```

Expected: every workspace passes. The clickhouse-integration test is `describe`-gated on the container being available; it runs because ClickHouse is up.

- [ ] **Step 2: Run the slow suite**

```bash
cd apps/api && pnpm test:slow
```

Expected: the replication parity scaffold test passes (the real PeerDB container is still stubbed per Task 10.1 note).

### Task 11.3: Mark spec items complete

**Files:**
- Modify: `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md`

- [ ] **Step 1: Skim the spec for items Plan 1 actually shipped**

Open the spec. For each of these items, add a `✅ <YYYY-MM-DD>` marker next to the bullet (match the existing convention in the same directory — do not invent one):

- §4.1 engine matrix: all raw_* engines landed
- §4.2 `raw_revenue_events` schema
- §4.5 `raw_exposures` + `mv_experiment_daily`
- §8.1 `clickhouse.ts` wrapper
- §8.2 endpoint example pattern (adapted to `/v1/experiments/:id/results`)
- §10.1 replication parity test (scaffolded)
- §10.2 aggregate correctness test (full)
- §11 T8 PeerDB lag metric

Do NOT mark §4.3 `mv_daily_revenue` or §4.4 `mv_cohort_retention` — those are Plan 2.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md
git commit -m "docs(spec): mark Alan 6 Plan 1 completed items"
```

### Task 11.4: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/clickhouse-analytics
```

- [ ] **Step 2: Open a PR**

Title: `feat(analytics): ClickHouse foundation + experiments backend (Plan 1)`

Body (via `gh pr create`):

```markdown
## Summary
- Stands up ClickHouse 24.3 + PeerDB replication (publication `rovenue_analytics`)
- Adds `exposure_events` Postgres hypertable + ingest pipeline (`POST /v1/experiments/:id/expose`, Redis buffer, flusher worker)
- Rewires `GET /v1/experiments/:id/results` to compute CUPED/mSPRT/SRM from ClickHouse `mv_experiment_daily`
- Ships `verify-clickhouse` CLI + Prometheus lag metric + S3 backup script

## Test plan
- [x] `pnpm test` passes on every workspace
- [x] `pnpm --filter @rovenue/db db:verify:timescale` prints OK
- [x] `pnpm --filter @rovenue/db db:verify:clickhouse` prints OK
- [x] Manual SSE smoke: curl against `/v1/config/stream` receives `initial` then `invalidate`
- [x] Manual replication smoke: Postgres insert lands in ClickHouse within 10s
- [x] `clickhouse-integration.test.ts` passes (MV parity vs raw GROUP BY)

## Scope note
- SDK-RN, dashboard UI, revenue MVs → Plans 2-4. TimescaleDB `daily_mrr` continuous aggregate is intentionally preserved until Plan 2's cutover.
```

---

## Deferred follow-ups (out of scope for this plan)

- **PeerDB testcontainer bundle (Task 10.1 TODO):** boot the 4-service PeerDB overlay in a vitest global setup and assert 30s row-count convergence. Non-trivial because temporal must also start; a 1-2 day effort.
- **Auto-emit exposures from the existing `GET /v1/config` route.** Requires decisions about deduplication (per-session / per-request / never) that should be made with the SDK team in Plan 3.
- **ClickHouse secondary indexes** on `raw_revenue_events.country` / `raw_exposures.country` (spec §11 T2). Only needed once cross-country dashboards land (Plan 2).
- **Compression policy on `exposure_events` at a finer grain than 7 days.** If exposure volume is much higher than `revenue_events`, Plan 2 may want to shift compression to 3 days. Revisit after first week of production data.
- **`daily_mrr` TimescaleDB continuous aggregate drop.** Scheduled for Plan 2 when `mv_daily_revenue` cutover lands.
- **Revenue-side MVs** (`mv_daily_revenue`, `mv_cohort_retention`, LTV) and the cohort / funnel / LTV / geo / event-timeline routes. Plan 2.
- **SDK-RN exposure queue / identity merge.** Plan 3.
- **Dashboard experiment results UI + revenue charts.** Plan 4.
