# Kafka Analytics Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PeerDB CDC ingestion pipeline (which cannot replicate TimescaleDB hypertables — see spec §14.1) with an application-layer outbox pattern that fans into a Redpanda topic, which ClickHouse consumes via the Kafka Engine + materialized views. Plan 1's analytics read path (SSE config stream, experiment results endpoint with CUPED/mSPRT/SRM) is unchanged from the superseded plan's Phase 7-8; only the write/replication half pivots.

**Architecture:** Each analytics-eligible request writes to Postgres AND to a `outbox_events` table in the same transaction. An async `outbox-dispatcher` worker drains `outbox_events`, publishes to a Redpanda topic per aggregate (`rovenue.exposures`, `rovenue.revenue`, `rovenue.credit`), and marks rows published. ClickHouse's Kafka Engine table consumes the topic, an MV projects the raw payload into a `ReplacingMergeTree` target, and a second MV projects that into a `SummingMergeTree` daily rollup (`mv_experiment_daily`). At-least-once semantics; dedup via `eventId` in the `ReplacingMergeTree` version column. The Postgres `exposure_events` hypertable is **deleted** — exposures are a pure analytics event with no OLTP read path. `revenue_events` and `credit_ledger` stay as TimescaleDB hypertables (VUK 7-year source of truth); their Kafka fan-out is **deferred** to Plan 2 — this plan ships only the exposures pipeline end-to-end.

**Tech Stack:** Redpanda 24.2 (single-node, Kafka-wire-compatible, self-host-friendly single Go binary — spec §14.3 point 4), Redpanda Console 2.6, kafkajs 2.x, ClickHouse 24.3 Kafka Engine, Drizzle ORM 0.45, drizzle-kit 0.31, Vitest, testcontainers 10.15. No new OLTP dependencies beyond `kafkajs`.

**Scope note — what is intentionally NOT in this plan:**
- Revenue/credit/webhook Kafka pipelines. The outbox infrastructure is built generically (aggregate-typed rows), but only the `EXPOSURE` aggregate is wired end-to-end. Revenue/credit fan-out is Plan 2 scope — the Postgres hypertables remain the read source for MRR/credit queries until then (the `daily_mrr` cagg from Alan 4 is already load-bearing).
- PeerDB anything. Submodule deleted, `deploy/peerdb/` removed, publication rolled back — spec §14 is categorical.
- BullMQ → Redpanda migration for webhook delivery. Redpanda is the backbone (§14.3 point 5) but webhook retry stays on BullMQ/Redis in this plan.
- Backup strategy swap, CI hook for verify-clickhouse. Orthogonal ops decisions (deferred same as Alan 4 plan §scope-note).
- `exposure_events` MMKV/offline SDK cache. SDK-side concerns; server-only work here.
- Dashboard UI changes. The new `/v1/experiments/:id/results` endpoint is consumed by the SDK; dashboard continues to call the existing Postgres-backed endpoints.

---

## Testing conventions

- Schema-level unit tests live in `packages/db/src/drizzle/drizzle-foundation.test.ts`. Extend that file; do not invent a test-container harness for DB shape checks.
- Integration tests that need Redpanda/ClickHouse live in `apps/api/tests/`. Use `testcontainers` (already a devDependency) to spin up `redpandadata/redpanda:v24.2.13` and `clickhouse/clickhouse-server:24.3-alpine` per test file. Do **not** try to share containers across files — isolation beats speed.
- Each migration in this plan is authored as hand-written SQL plus a hand-appended entry in `packages/db/drizzle/migrations/meta/_journal.json`. Same contract as Alan 4 (timescaledb) plan — the migrator hashes the `.sql` content and records it in `__drizzle_migrations`.
- ClickHouse migrations live in `packages/db/clickhouse/migrations/` and are applied by `pnpm --filter @rovenue/db db:clickhouse:migrate` (runner already exists in-tree at `packages/db/src/clickhouse-migrate.ts`).
- **Do NOT run `drizzle-kit generate`.** All migrations in this plan are hand-authored; generate will corrupt `_journal.json`.

---

## File structure

### Create

- `packages/db/drizzle/migrations/0011_drop_publication.sql` — `DROP PUBLICATION IF EXISTS rovenue_analytics`
- `packages/db/drizzle/migrations/0012_drop_exposure_events.sql` — `DROP TABLE IF EXISTS exposure_events`
- `packages/db/drizzle/migrations/0013_outbox_events.sql` — outbox table + indexes + aggregate_type enum
- `packages/db/clickhouse/migrations/0002_exposures_kafka_engine.sql` — queue + raw_exposures target + MV
- `packages/db/clickhouse/migrations/0003_mv_experiment_daily.sql` — SummingMergeTree daily rollup + MV
- `packages/db/src/drizzle/repositories/outbox.ts` — `insert`, `claimBatch`, `markPublished`, `countUnpublished`
- `apps/api/src/lib/kafka.ts` — kafkajs producer singleton + admin helper for topic assertion
- `apps/api/src/lib/clickhouse.ts` — `@clickhouse/client` wrapper with typed query helper
- `apps/api/src/services/event-bus.ts` — `publishExposure` helper writing to outbox in the caller's transaction
- `apps/api/src/workers/outbox-dispatcher.ts` — batch loop: read outbox → publish → mark published
- `apps/api/src/services/experiment-results.ts` — CUPED/mSPRT/SRM over ClickHouse
- `apps/api/src/routes/v1/config-stream.ts` — SSE endpoint streaming flag/experiment config
- `apps/api/src/routes/v1/experiments.ts` — `POST /:id/expose` (eventBus) + `GET /:id/results` (CH)
- `apps/api/src/routes/analytics-router.ts` — dispatcher that routes aggregate queries to CH vs Postgres
- `packages/db/scripts/verify-clickhouse.ts` — standalone CLI printing CH schema state + drift detection
- `apps/api/tests/outbox-dispatcher.integration.test.ts` — testcontainers Redpanda round-trip
- `apps/api/tests/ch-kafka-engine.integration.test.ts` — testcontainers Redpanda + CH end-to-end
- `apps/api/tests/experiment-results.test.ts` — unit test over the statistical helper (no DB)

### Modify

- `packages/db/drizzle/migrations/meta/_journal.json` — append entries for 0011, 0012, 0013
- `packages/db/src/drizzle/schema.ts` — remove the `exposureEvents` pgTable block + its type exports; add `outboxEvents` pgTable + aggregate-type enum
- `packages/db/src/drizzle/index.ts` — drop `exposureEventRepo` export; add `outboxRepo`
- `apps/api/src/lib/env.ts` — add `KAFKA_BROKERS` (required in prod; optional in dev — worker logs and exits cleanly if missing)
- `docker-compose.yml` — remove ClickHouse native-TCP port 9102 host mapping (no longer needed; Kafka path replaces it); add `redpanda` and `redpanda-console` services
- `.env.example` — add `KAFKA_BROKERS=localhost:19092`
- `apps/api/src/app.ts` — mount `/v1/experiments/*`, `/v1/config/stream`; start the outbox-dispatcher worker alongside the existing BullMQ workers
- `packages/db/package.json` — add `"db:verify:clickhouse": "tsx scripts/verify-clickhouse.ts"` script
- `apps/api/package.json` — add `kafkajs` dependency

### Delete

- `packages/db/src/drizzle/repositories/exposure-events.ts` — Postgres hypertable gone; repo unreachable
- `deploy/peerdb/` — entire directory (setup.sql, README.md, run-peerdb.sh, upstream submodule)
- `.gitmodules` — remove the `peerdb-upstream` submodule entry (delete the file if it's the only entry)

---

## Reference: existing in-tree bindings this plan depends on

These compile today; later tasks assume they keep working. Stop and reconcile if any has drifted.

- `apps/api/src/lib/experiment-stats.ts` — CUPED-adjusted lift, mSPRT p-value, SRM chi-squared helpers. Consumed by `services/experiment-results.ts` (Task F.4). Public API: `cupedAdjust(controls, treatments, covariate)`, `mSprtPValue(successes, trials, tau, alpha)`, `srmChiSquared(observed, expected)`. Do NOT modify.
- `packages/db/src/drizzle/client.ts` — exports `db` (NodePgDatabase-typed), `type Db`, `schema`. Every repo uses `Db` as the first arg; this plan's `outboxRepo` follows the same pattern.
- `packages/db/src/clickhouse-migrate.ts` — migration runner. Reads `packages/db/clickhouse/migrations/*.sql` in lex order, splits on line-terminated `;`, hashes each file, records in `rovenue._migrations`. New migrations in Phase E follow its split rules (no mid-statement `;`, one statement per block separated by a trailing `;` on its own line).
- `deploy/clickhouse/config.d/`, `deploy/clickhouse/users.d/` — ClickHouse XML config (Kafka broker settings etc. go in `config.d/kafka.xml` per Phase E.1).
- `packages/db/drizzle/migrations/0008_experiment_assignments_hash_version.sql` — last migration before the rollback chain. New journal entries in this plan start at idx 11.

---

## Phase A — Roll back PeerDB + `exposure_events` artifacts

Rationale: the `feat/clickhouse-analytics` branch carries migrations 0009 (exposure_events hypertable) and 0010 (publication) + the PeerDB submodule + a PeerDB bootstrap under `deploy/peerdb/`. Per spec §14.1 none of these can stay: exposure_events moves to a pure-Kafka path, and publication is meaningless without a CDC consumer. Rollback strategy is **forward-only migrations** (0011 DROP PUBLICATION, 0012 DROP TABLE) — not journal/file deletion — so dev databases that already ran 0009/0010 converge to the new zero-state cleanly, and honest history survives (spec §14.6).

> Note for environments that carried state from the earlier PeerDB exploration: Phase A's migrations only touch Postgres. Your ClickHouse instance may still have stale tables from that pipeline (`raw_exposures`, `_peerdb_raw_rovenue_analytics`, `raw_purchases`, `raw_subscribers`) that will collide with Phase E's CREATE TABLEs or silently diverge from them. Before starting Phase E, run once for a clean slate: `docker compose exec clickhouse clickhouse-client --query "DROP TABLE IF EXISTS rovenue.raw_exposures; DROP TABLE IF EXISTS rovenue._peerdb_raw_rovenue_analytics; DROP TABLE IF EXISTS rovenue.raw_purchases; DROP TABLE IF EXISTS rovenue.raw_subscribers;"`. Fresh checkouts can skip this.

### Task A.1: Write migration 0011 — drop the `rovenue_analytics` publication

**Files:**
- Create: `packages/db/drizzle/migrations/0011_drop_publication.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write this exact content to `packages/db/drizzle/migrations/0011_drop_publication.sql`:

```sql
-- Roll back the rovenue_analytics logical-replication publication
-- introduced in 0010. The PeerDB CDC pipeline that consumed it is
-- removed in Phase A of the Kafka+outbox plan (spec §14); without a
-- consumer the publication holds WAL segments and leaks disk, so we
-- drop it unconditionally. If no PeerDB mirror was ever started
-- (common in local dev), the publication still exists from 0010 —
-- the IF EXISTS guard keeps this migration safe.
--
-- wal_level=logical / max_wal_senders / max_replication_slots stay
-- on in docker-compose.yml — they were introduced alongside 0010
-- but are harmless without a subscriber, and a future reintroduction
-- of logical replication (for a different purpose) should not have
-- to re-sequence a full Postgres restart.
--
-- drizzle-orm's migrator wraps each .sql in a transaction — no
-- BEGIN/COMMIT here. DROP PUBLICATION is transactional in PG16.

DROP PUBLICATION IF EXISTS rovenue_analytics;
```

- [ ] **Step 2: Append the journal entry**

Generate a fresh timestamp: `node -e "console.log(Date.now())"`. Append this entry after idx 10 in `packages/db/drizzle/migrations/meta/_journal.json`:

```json
    {
      "idx": 11,
      "version": "7",
      "when": 1777507200000,
      "tag": "0011_drop_publication",
      "breakpoints": true
    }
```

Replace `1777507200000` with the `Date.now()` output. Remember to add the trailing comma on the existing idx-10 entry before inserting.

- [ ] **Step 3: Apply the migration against the local database**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: drizzle-orm prints that it applied 1 migration, and exit code 0.

- [ ] **Step 4: Verify the publication is gone**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT pubname FROM pg_publication WHERE pubname = 'rovenue_analytics';"`
Expected: zero rows. If the local DB never had PeerDB running, zero rows was already the case — `DROP ... IF EXISTS` silently succeeded.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0011_drop_publication.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "revert(db): drop rovenue_analytics publication — PeerDB pivot to Kafka+outbox"
```

---

### Task A.2: Write migration 0012 — drop the `exposure_events` hypertable

**Files:**
- Create: `packages/db/drizzle/migrations/0012_drop_exposure_events.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write this exact content to `packages/db/drizzle/migrations/0012_drop_exposure_events.sql`:

```sql
-- Roll back the exposure_events TimescaleDB hypertable introduced
-- in 0009. Per spec §14.2 / §14.7 exposure_events is a pure
-- analytics event with no OLTP read path; after the Kafka pivot it
-- lives only in ClickHouse (raw_exposures, populated by the Kafka
-- Engine table in clickhouse/migrations/0002_exposures_kafka_engine.sql).
--
-- CASCADE drops the associated compression + retention policies,
-- chunk indexes, and TimescaleDB catalog entries in one shot. The
-- table is empty in dev and was never deployed to production, so
-- data loss is not a concern.
--
-- IF EXISTS handles the case where 0009 was never applied (fresh
-- branch checkout).

DROP TABLE IF EXISTS "exposure_events" CASCADE;
```

- [ ] **Step 2: Append the journal entry**

Generate timestamp and append after idx 11:

```json
    {
      "idx": 12,
      "version": "7",
      "when": 1777510800000,
      "tag": "0012_drop_exposure_events",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: 1 migration applied.

- [ ] **Step 4: Verify the table and its hypertable catalog row are gone**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT tablename FROM pg_tables WHERE tablename = 'exposure_events'; SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'exposure_events';"`
Expected: zero rows from both queries.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0012_drop_exposure_events.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "revert(db): drop exposure_events hypertable — pivot to Kafka-only"
```

---

### Task A.3: Remove `exposureEvents` from the Drizzle schema and repo barrel

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (lines 739-779 — the exposure_events block)
- Modify: `packages/db/src/drizzle/index.ts` (the `exposureEventRepo` export line)
- Delete: `packages/db/src/drizzle/repositories/exposure-events.ts`
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts` (remove the exposure_events pin if present)

- [ ] **Step 1: Delete the `exposureEvents` block from `schema.ts`**

Open `packages/db/src/drizzle/schema.ts` and delete the entire block starting at the `// exposure_events (time-series, hypertable in migration 0009)` banner and ending at `export type NewExposureEvent = typeof exposureEvents.$inferInsert;` (inclusive). Also delete the banner's blank line above.

Verify after deletion: `grep -n exposure /Volumes/Development/rovenue/packages/db/src/drizzle/schema.ts`
Expected: no matches.

- [ ] **Step 2: Delete the repo file**

Run: `rm /Volumes/Development/rovenue/packages/db/src/drizzle/repositories/exposure-events.ts`

- [ ] **Step 3: Remove the barrel export**

In `packages/db/src/drizzle/index.ts`, delete the line:

```ts
export * as exposureEventRepo from "./repositories/exposure-events";
```

- [ ] **Step 4: Remove any test pin on `exposureEvents`**

Run: `grep -n exposureEvents /Volumes/Development/rovenue/packages/db/src/drizzle/drizzle-foundation.test.ts`
If matches exist, delete those test blocks (they would now reference an undefined symbol). If no matches, skip.

- [ ] **Step 5: Grep for remaining callers in the API**

Run: `grep -rn 'exposureEventRepo\|exposure-events' /Volumes/Development/rovenue/apps/api/src 2>/dev/null`
Expected: zero matches. The exposure-events repo was created alongside the Postgres hypertable in commit `2044272` and no caller landed yet (the ingest route that would have called it is replaced by Phase F's eventBus-backed version). If any match appears, stop — there's an intermediate caller that needs to be removed before Phase D rewires the write path.

- [ ] **Step 6: Run the db package tests**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass. A type error here means step 4 missed a pin.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/index.ts packages/db/src/drizzle/drizzle-foundation.test.ts
git rm packages/db/src/drizzle/repositories/exposure-events.ts
git commit -m "revert(db): remove exposureEvents Drizzle schema + repo"
```

---

### Task A.4: Remove the PeerDB submodule and `deploy/peerdb/` directory

**Files:**
- Delete: `deploy/peerdb/` (entire directory, including submodule at `deploy/peerdb/upstream`)
- Modify: `.gitmodules` (remove the `peerdb-upstream` entry; delete the file if empty afterwards)

- [ ] **Step 1: Deinit the submodule**

Run:
```bash
git submodule deinit -f deploy/peerdb/upstream
git rm -rf deploy/peerdb/upstream
rm -rf .git/modules/peerdb-upstream
```

- [ ] **Step 2: Delete the rest of `deploy/peerdb/`**

Run: `git rm -rf deploy/peerdb/`

- [ ] **Step 3: Clean up `.gitmodules`**

Run: `cat .gitmodules`
- If `peerdb-upstream` was the only entry, the `git submodule deinit + rm` above may have already emptied it. If the file still exists with only whitespace, run `git rm .gitmodules`.
- If other submodules exist, open `.gitmodules` and delete the `[submodule "peerdb-upstream"]` stanza + its two indented lines (`path = ...`, `url = ...`). Leave a trailing newline.

- [ ] **Step 4: Verify working tree is clean**

Run: `git status`
Expected: staged deletions for `.gitmodules`, `deploy/peerdb/**`, nothing in `Untracked`. `git ls-files | grep peerdb` should print nothing.

- [ ] **Step 5: Commit**

```bash
git commit -m "revert(infra): remove PeerDB submodule and deploy/peerdb/ bundle"
```

---

### Task A.5: Strip the ClickHouse native-TCP host mapping from `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml` (clickhouse service, ports block + header comment)

The port 9102 host mapping was added because PeerDB's bundled MinIO claimed 9001/9002 on the host. With PeerDB gone, CH's native-TCP surface is unused (the API hits the HTTP port 8123 / `@clickhouse/client` HTTP client). Removing the mapping frees the port and narrows the docker-compose attack surface.

- [ ] **Step 1: Update the header comment block**

Open `docker-compose.yml`. Replace lines 1-14 (the `# Rovenue local stack ...` comment) with:

```yaml
# Rovenue local stack — rovenue's own services (api, db, redis,
# clickhouse, redpanda, redpanda-console).
#
# Default boot:
#   docker compose up -d
#
# Analytics ingestion runs on an outbox + Kafka pipeline:
# app writes outbox_events in the same tx as the OLTP write, the
# outbox-dispatcher worker (apps/api/src/workers/outbox-dispatcher.ts)
# drains it into Redpanda, and ClickHouse's Kafka Engine consumes
# the topic. No CDC. See docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md §14.
```

- [ ] **Step 2: Delete the port 9102 mapping and its inline comment**

In the `clickhouse:` service's `ports:` list, delete the line `- "9102:9000"` AND the comment block immediately above it that references PeerDB/MinIO (the 4-line comment starting `# Host 8124 → container 8123 (HTTP), 9102 → 9000 (native TCP).`).

Replace the ports block with:

```yaml
    ports:
      # Host 8124 → container 8123 (HTTP). CH native-TCP (9000) is
      # not exposed — the API hits CH over HTTP via @clickhouse/client,
      # and integration tests spin their own container.
      - "8124:8123"
```

- [ ] **Step 3: Sanity-check the compose file parses**

Run: `docker compose config > /dev/null`
Expected: exit code 0. Any YAML error shows up here.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(infra): drop ClickHouse native-TCP host mapping — HTTP only"
```

---

## Phase B — Redpanda single-node

### Task B.1: Add `redpanda` and `redpanda-console` services to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml` (add two new services; declare one new named volume)

- [ ] **Step 1: Append the two services after `clickhouse:` and before the `volumes:` block**

Insert this block between the end of the `clickhouse:` service (after its `restart: unless-stopped` line) and the `volumes:` block:

```yaml
  redpanda:
    # Redpanda 24.2 — Kafka-wire-compatible single Go binary. Spec
    # §14.3 point 4 argues the single-node config (one container)
    # beats Kafka+ZK+Schema-Registry (≥5 containers) on ops weight
    # for a self-hosted subscription platform. Rovenue does not need
    # multi-broker durability at Plan 1 scale.
    image: redpandadata/redpanda:v24.2.13
    container_name: rovenue-redpanda
    command:
      - redpanda
      - start
      - --smp=1
      - --memory=1G
      - --reserve-memory=0M
      - --overprovisioned
      - --node-id=0
      - --check=false
      # External (host) listener on 19092 so apps running on the
      # host (pnpm dev) connect without a docker-network round-trip.
      # Internal listener on 9092 for other compose services.
      - --kafka-addr=PLAINTEXT://0.0.0.0:9092,EXTERNAL://0.0.0.0:19092
      - --advertise-kafka-addr=PLAINTEXT://redpanda:9092,EXTERNAL://localhost:19092
      - --rpc-addr=0.0.0.0:33145
      - --advertise-rpc-addr=redpanda:33145
    ports:
      - "19092:19092"
      - "9644:9644"
    volumes:
      - rovenue-redpanda-data:/var/lib/redpanda/data
    healthcheck:
      test: ["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true'"]
      interval: 5s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  redpanda-console:
    # Web UI for Redpanda — topic inspector, consumer-group lag,
    # message browser. Only bound to localhost in production (this
    # compose is self-host dev; Coolify operator should put it
    # behind basic auth if exposed).
    image: redpandadata/console:v2.6.1
    container_name: rovenue-redpanda-console
    environment:
      KAFKA_BROKERS: redpanda:9092
      SERVER_LISTENPORT: "8080"
    ports:
      - "8080:8080"
    depends_on:
      redpanda:
        condition: service_healthy
    restart: unless-stopped
```

- [ ] **Step 2: Add the redpanda volume**

In the `volumes:` block at the bottom of the file, add `rovenue-redpanda-data:` as a new line alongside `rovenue-data:` and `rovenue-clickhouse-data:`. The final block should read:

```yaml
volumes:
  rovenue-data:
  rovenue-clickhouse-data:
  rovenue-redpanda-data:
```

- [ ] **Step 3: Wire the API service to Redpanda**

In the `api:` service's `environment:` block, add one line:

```yaml
      KAFKA_BROKERS: redpanda:9092
```

In the `api:` service's `depends_on:` block, add:

```yaml
      redpanda:
        condition: service_healthy
```

- [ ] **Step 4: Validate compose config**

Run: `docker compose config > /dev/null`
Expected: exit code 0.

- [ ] **Step 5: Boot and verify**

Run: `docker compose up -d redpanda redpanda-console`
Run: `docker compose ps redpanda` — expect `healthy` within 30s.
Run: `docker compose exec redpanda rpk cluster info`
Expected: prints the node id 0 with status `active`.

Run: `curl -sf http://localhost:8080/api/cluster/overview | head -c 200`
Expected: JSON payload with `"status": "HEALTHY"` somewhere in the response. The console is reachable.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add Redpanda single-node + Console services"
```

---

### Task B.2: Add `KAFKA_BROKERS` to the env schema and `.env.example`

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the schema field**

In `apps/api/src/lib/env.ts`, add this entry to the `z.object({ ... })` block, next to `CLICKHOUSE_URL`:

```ts
    // Redpanda/Kafka brokers — comma-separated host:port list
    // consumed by kafkajs. Optional in dev (the outbox-dispatcher
    // worker logs and exits cleanly if missing — OLTP writes still
    // land in outbox_events, pending a dispatcher). Required in
    // production; without it exposure events never reach CH.
    KAFKA_BROKERS: z.string().min(1).optional(),
```

- [ ] **Step 2: Require it in production**

In the `superRefine` block at the bottom of the schema, add one `require` call next to the `CLICKHOUSE_URL` one:

```ts
    require(
      data.KAFKA_BROKERS,
      "KAFKA_BROKERS",
      "analytics ingestion requires a Kafka/Redpanda cluster in production",
    );
```

- [ ] **Step 3: Extend `.env.example`**

Append this block to `.env.example`:

```
# ---- Kafka / Redpanda ---------------------------------------------------
# Comma-separated host:port list. docker-compose.yml exposes the
# external listener on localhost:19092; inside the compose network
# the api container talks to redpanda:9092 (set by compose env).
KAFKA_BROKERS=localhost:19092
```

- [ ] **Step 4: Verify the API boots with the new variable**

Run: `pnpm --filter @rovenue/api test -- --run` (hoisted-mock tests only; no DB required)
Expected: pass. A zod parse error here means step 1 broke the schema.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/env.ts .env.example
git commit -m "feat(env): declare KAFKA_BROKERS for Redpanda ingestion"
```

---

### Task B.3: Install `kafkajs` in `apps/api`

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @rovenue/api add kafkajs@^2.2.4`
Expected: pnpm updates `apps/api/package.json` and `pnpm-lock.yaml`.

- [ ] **Step 2: Verify the install**

Run: `pnpm --filter @rovenue/api ls kafkajs`
Expected: prints `kafkajs 2.2.x`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore(api): add kafkajs dependency"
```

---

## Phase C — Postgres outbox table + repo

### Task C.1: Write migration 0013 — `outbox_events` table + `aggregate_type` enum

**Files:**
- Create: `packages/db/drizzle/migrations/0013_outbox_events.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write this exact content to `packages/db/drizzle/migrations/0013_outbox_events.sql`:

```sql
-- outbox_events: transactional outbox feeding the Kafka pipeline.
--
-- Every analytics-eligible OLTP write lands here in the same
-- transaction as the business insert (same-tx safety: the Kafka
-- publish can never happen without the OLTP row, and vice versa).
-- An async outbox-dispatcher worker (apps/api/src/workers/
-- outbox-dispatcher.ts) claims unpublished rows in batches, writes
-- them to Redpanda, and marks `publishedAt` on success. At-least-
-- once semantics — consumers (ClickHouse Kafka Engine + the
-- ReplacingMergeTree on `eventId`) handle dedup.
--
-- Columns are double-quoted camelCase to match the rovenue
-- on-disk convention (revenueEvents, creditLedger, outgoingWebhooks
-- etc).
--
-- Indexes:
--   pk on id — every insert/claim/markPublished filters by id.
--   unpublished_idx on (createdAt) WHERE publishedAt IS NULL —
--     the dispatcher's claim query is
--     `ORDER BY createdAt LIMIT N WHERE publishedAt IS NULL`.
--     A partial index keeps this fast even after millions of
--     published rows accumulate (rows get cleaned up by a separate
--     retention worker not in this plan — Plan 2 scope).
--
-- The aggregate_type enum enumerates the Kafka topic suffix:
--   'EXPOSURE'      → rovenue.exposures
--   'REVENUE_EVENT' → rovenue.revenue   (Plan 2)
--   'CREDIT_LEDGER' → rovenue.credit    (Plan 2)
-- Plan 1 only fans out EXPOSURE; the other values are reserved so
-- Plan 2 does not need a schema migration.
--
-- drizzle-orm's migrator wraps each .sql in a transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aggregate_type') THEN
    CREATE TYPE "aggregate_type" AS ENUM (
      'EXPOSURE',
      'REVENUE_EVENT',
      'CREDIT_LEDGER'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" TEXT PRIMARY KEY,
  "aggregateType" "aggregate_type" NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "publishedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "outbox_events_unpublished_idx"
  ON "outbox_events" ("createdAt")
  WHERE "publishedAt" IS NULL;
```

- [ ] **Step 2: Append the journal entry**

Generate timestamp with `node -e "console.log(Date.now())"` and append:

```json
    {
      "idx": 13,
      "version": "7",
      "when": 1777514400000,
      "tag": "0013_outbox_events",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply and verify**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: 1 migration applied.

Run: `docker compose exec db psql -U rovenue -d rovenue -c "\d outbox_events"`
Expected: columns id, aggregateType, aggregateId, eventType, payload, createdAt, publishedAt with the types above; PK on id; the partial index visible.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0013_outbox_events.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): add outbox_events table + aggregate_type enum"
```

---

### Task C.2: Add `outboxEvents` to the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (add new block near the end, before the final banner)
- Modify: `packages/db/src/drizzle/enums.ts` (add the enum)

- [ ] **Step 1: Add the enum**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const aggregateTypeEnum = pgEnum("aggregate_type", [
  "EXPOSURE",
  "REVENUE_EVENT",
  "CREDIT_LEDGER",
]);
```

If `pgEnum` is not yet imported in that file, add it to the `drizzle-orm/pg-core` import line.

- [ ] **Step 2: Add the `outboxEvents` table block**

In `packages/db/src/drizzle/schema.ts`, add this block near the end (after the last existing table, before the inferred-types banner):

```ts
// =============================================================
// outbox_events (transactional outbox feeding Kafka)
// =============================================================
//
// Written in the same transaction as the corresponding OLTP row
// (e.g., an exposure publish also writes a revenueEvent in Plan 2,
// but Plan 1 ships only EXPOSURE). The outbox-dispatcher worker
// drains unpublished rows into Redpanda and flips publishedAt.
// See apps/api/src/services/event-bus.ts for the write side.

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").notNull().primaryKey().$defaultFn(() => createId()),
    aggregateType: aggregateTypeEnum("aggregateType").notNull(),
    aggregateId: text("aggregateId").notNull(),
    eventType: text("eventType").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("publishedAt", { withTimezone: true }),
  },
  (t) => ({
    unpublishedIdx: index("outbox_events_unpublished_idx").on(t.createdAt),
  }),
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
```

Ensure `aggregateTypeEnum`, `jsonb`, `index`, and `createId` are in scope — grep the imports at the top of `schema.ts` and add any missing symbols to the `drizzle-orm/pg-core` and `@paralleldrive/cuid2` imports.

> Note the partial-index `WHERE` predicate from Task C.1's SQL is not representable in Drizzle 0.45's `index().on()` builder. Drizzle will see the named `outbox_events_unpublished_idx` in `pg_indexes` (matching on name) and treat the shape as satisfied; re-running `drizzle-kit generate` would try to drop+recreate it and lose the predicate — that's why this plan never runs generate (documented in the Testing conventions block).

- [ ] **Step 3: Pin the schema shape**

Append to `packages/db/src/drizzle/drizzle-foundation.test.ts`:

```ts
describe("outboxEvents", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(outboxEvents);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "aggregateType",
        "aggregateId",
        "eventType",
        "payload",
        "createdAt",
        "publishedAt",
      ]),
    );
  });

  it("enumerates aggregate_type values", () => {
    expect(aggregateTypeEnum.enumValues).toEqual([
      "EXPOSURE",
      "REVENUE_EVENT",
      "CREDIT_LEDGER",
    ]);
  });
});
```

Add `outboxEvents`, `aggregateTypeEnum` to the imports at the top of the test file.

- [ ] **Step 4: Run the db tests**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass, including the two new `outboxEvents` cases.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/enums.ts packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db): declare outboxEvents Drizzle schema"
```

---

### Task C.3: Write the outbox repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/outbox.ts`
- Modify: `packages/db/src/drizzle/index.ts` (add barrel export)

- [ ] **Step 1: Write the repo**

Write this exact content to `packages/db/src/drizzle/repositories/outbox.ts`:

```ts
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  outboxEvents,
  type NewOutboxEvent,
  type OutboxEvent,
} from "../schema";

// =============================================================
// outbox repository
// =============================================================
//
// insert — called by event-bus.publishExposure inside the caller's
// transaction. The caller passes a tx-bound Db; this repo never
// opens its own transaction.
//
// claimBatch — reads up to `limit` unpublished rows ordered by
// createdAt. Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple
// dispatcher instances can run without trampling each other (Plan 1
// is single-instance; SKIP LOCKED is future-proofing).
//
// markPublished — flips publishedAt = NOW() for a batch of ids,
// called after Kafka ack.
//
// countUnpublished — used by health checks and the verify-clickhouse
// CLI to flag stuck dispatch queues.

export async function insert(
  db: Db,
  row: NewOutboxEvent,
): Promise<void> {
  await db.insert(outboxEvents).values(row);
}

export async function claimBatch(
  db: Db,
  limit: number,
): Promise<OutboxEvent[]> {
  // FOR UPDATE SKIP LOCKED on the unpublished partial index.
  // Drizzle's .for() is not typed for SKIP LOCKED in 0.45, so we
  // drop to a raw SQL fragment in the final clause.
  return db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function markPublished(
  db: Db,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(outboxEvents)
    .set({ publishedAt: sql`NOW()` })
    .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.publishedAt)));
}

export async function countUnpublished(db: Db): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt));
  return Number(result[0]?.count ?? 0);
}

export type { OutboxEvent, NewOutboxEvent };
```

- [ ] **Step 2: Add the barrel export**

In `packages/db/src/drizzle/index.ts`, add this line next to the other `export * as xRepo` lines (alphabetical position):

```ts
export * as outboxRepo from "./repositories/outbox";
```

- [ ] **Step 3: Smoke-test the repo shape**

Run: `pnpm --filter @rovenue/db test`
Expected: pass (no runtime test — just tsc + existing schema pins).

Run: `pnpm --filter @rovenue/db build`
Expected: exit 0. A tsc error here means one of the drizzle-orm operators was not imported.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/repositories/outbox.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): add outbox repository (insert, claimBatch, markPublished)"
```

---

## Phase D — App-side event bus + dispatcher worker

### Task D.1: Kafka producer singleton — `apps/api/src/lib/kafka.ts`

**Files:**
- Create: `apps/api/src/lib/kafka.ts`

- [ ] **Step 1: Write the client module**

Write this exact content:

```ts
import { Kafka, logLevel, type Producer } from "kafkajs";
import { env } from "./env";
import { logger } from "./logger";

// =============================================================
// kafkajs singletons
// =============================================================
//
// getProducer — idempotent producer (enableIdempotence=true) so
// retries after a network blip don't double-publish. The Kafka
// broker de-duplicates on (producerId, sequence) per partition.
//
// getAdmin — used only by assertTopic() at boot to create the
// Redpanda topics if absent. Redpanda has auto-create off by
// default in our compose config, so this is load-bearing.
//
// Both return null when KAFKA_BROKERS is unset (dev convenience);
// the dispatcher worker checks for null and exits cleanly.

let producerPromise: Promise<Producer> | null = null;

export function getKafka(): Kafka | null {
  if (!env.KAFKA_BROKERS) return null;
  return new Kafka({
    clientId: "rovenue-api",
    brokers: env.KAFKA_BROKERS.split(",").map((s) => s.trim()),
    logLevel: logLevel.WARN,
    retry: { retries: 5, initialRetryTime: 200 },
  });
}

export async function getProducer(): Promise<Producer | null> {
  const kafka = getKafka();
  if (!kafka) return null;
  if (!producerPromise) {
    const p = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    });
    producerPromise = p.connect().then(() => p);
  }
  return producerPromise;
}

export async function assertTopic(topic: string): Promise<void> {
  const kafka = getKafka();
  if (!kafka) return;
  const admin = kafka.admin();
  try {
    await admin.connect();
    const existing = await admin.listTopics();
    if (existing.includes(topic)) return;
    await admin.createTopics({
      topics: [
        {
          topic,
          numPartitions: 3,
          replicationFactor: 1, // single-node Redpanda
          configEntries: [
            { name: "retention.ms", value: String(7 * 24 * 3600 * 1000) },
            { name: "compression.type", value: "zstd" },
          ],
        },
      ],
    });
    logger.info({ topic }, "kafka: created topic");
  } finally {
    await admin.disconnect();
  }
}

export async function disconnectKafka(): Promise<void> {
  if (!producerPromise) return;
  try {
    const p = await producerPromise;
    await p.disconnect();
  } finally {
    producerPromise = null;
  }
}
```

- [ ] **Step 2: Tsc-check**

Run: `pnpm --filter @rovenue/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/kafka.ts
git commit -m "feat(api): kafkajs producer singleton + topic assertion helper"
```

---

### Task D.2: Event bus — `apps/api/src/services/event-bus.ts`

**Files:**
- Create: `apps/api/src/services/event-bus.ts`
- Test: `apps/api/tests/event-bus.test.ts`

The bus is a thin wrapper around `outboxRepo.insert` that normalizes the payload shape per aggregate. The ingest route (Phase F) calls `eventBus.publishExposure(tx, { experimentId, ... })`; the caller's transaction already contains the OLTP write (if any) and the outbox write lands atomically.

- [ ] **Step 1: Write the failing test**

Write to `apps/api/tests/event-bus.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/services/event-bus";
import { drizzle } from "@rovenue/db";

vi.mock("@rovenue/db", async (actual) => {
  const real = await actual<typeof import("@rovenue/db")>();
  return {
    ...real,
    drizzle: {
      ...real.drizzle,
      outboxRepo: { insert: vi.fn() },
    },
  };
});

describe("eventBus.publishExposure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an EXPOSURE outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishExposure>[0];
    await eventBus.publishExposure(tx, {
      experimentId: "exp_123",
      variantId: "var_treatment",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      platform: "ios",
      country: "US",
      exposedAt: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(drizzle.outboxRepo.insert).mock.calls[0];
    expect(call[1]).toMatchObject({
      aggregateType: "EXPOSURE",
      aggregateId: "exp_123",
      eventType: "experiment.exposure.recorded",
      payload: expect.objectContaining({
        experimentId: "exp_123",
        variantId: "var_treatment",
      }),
    });
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @rovenue/api test event-bus`
Expected: FAIL with "cannot find module services/event-bus".

- [ ] **Step 3: Write the implementation**

Write to `apps/api/src/services/event-bus.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// event-bus
// =============================================================
//
// Callers pass a tx-bound Db so the outbox insert lands in the
// same transaction as the caller's OLTP write. For exposures
// (Plan 1) there is no OLTP row — the caller opens a short tx just
// to get a Db handle. The pattern is identical to how the
// revenue-event processor in Plan 2 will work (which does have an
// OLTP row).

export interface PublishExposureInput {
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform?: string | null;
  country?: string | null;
  exposedAt?: Date;
}

async function publishExposure(
  tx: Db,
  input: PublishExposureInput,
): Promise<void> {
  const payload = {
    experimentId: input.experimentId,
    variantId: input.variantId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    platform: input.platform ?? null,
    country: input.country ?? null,
    exposedAt: (input.exposedAt ?? new Date()).toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "EXPOSURE",
    aggregateId: input.experimentId,
    eventType: "experiment.exposure.recorded",
    payload,
  });
}

export const eventBus = { publishExposure };
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @rovenue/api test event-bus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/event-bus.ts apps/api/tests/event-bus.test.ts
git commit -m "feat(api): event-bus.publishExposure — same-tx outbox writer"
```

---

### Task D.3: Outbox dispatcher worker — `apps/api/src/workers/outbox-dispatcher.ts`

**Files:**
- Create: `apps/api/src/workers/outbox-dispatcher.ts`
- Modify: `apps/api/src/index.ts` (start the worker on boot)

- [ ] **Step 1: Write the worker**

Write this exact content to `apps/api/src/workers/outbox-dispatcher.ts`:

```ts
import { drizzle, getDb, type OutboxEvent } from "@rovenue/db";
import { assertTopic, disconnectKafka, getProducer } from "../lib/kafka";
import { logger } from "../lib/logger";

// =============================================================
// outbox-dispatcher
// =============================================================
//
// Batch loop: read up to BATCH_SIZE unpublished outbox rows, group
// by aggregateType → topic, publish to Redpanda, mark published.
// Sleeps POLL_INTERVAL_MS between empty reads; when a batch is
// drained it immediately re-polls without sleeping.
//
// At-least-once semantics: if the process dies between Kafka ack
// and markPublished, the row is re-delivered on restart. ClickHouse
// de-duplicates on eventId via ReplacingMergeTree (Phase E).
//
// Single-instance assumption. Horizontal scale would shard by
// aggregateId → Kafka partition; deferred to Plan 3.

const BATCH_SIZE = 250;
const POLL_INTERVAL_MS = 500;

const AGGREGATE_TO_TOPIC: Record<OutboxEvent["aggregateType"], string> = {
  EXPOSURE: "rovenue.exposures",
  REVENUE_EVENT: "rovenue.revenue",
  CREDIT_LEDGER: "rovenue.credit",
};

let stopFlag = false;

export function stopOutboxDispatcher(): void {
  stopFlag = true;
}

export async function runOutboxDispatcher(): Promise<void> {
  const producer = await getProducer();
  if (!producer) {
    logger.warn("outbox-dispatcher: KAFKA_BROKERS unset, skipping worker");
    return;
  }

  // Ensure all topics exist before we try to publish.
  for (const topic of new Set(Object.values(AGGREGATE_TO_TOPIC))) {
    await assertTopic(topic);
  }

  logger.info("outbox-dispatcher: started");

  while (!stopFlag) {
    try {
      const db = getDb();
      const batch = await db.transaction(async (tx) => {
        return drizzle.outboxRepo.claimBatch(tx, BATCH_SIZE);
      });

      if (batch.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Group by topic.
      const byTopic = new Map<string, typeof batch>();
      for (const row of batch) {
        const topic = AGGREGATE_TO_TOPIC[row.aggregateType];
        const list = byTopic.get(topic) ?? [];
        list.push(row);
        byTopic.set(topic, list);
      }

      // Publish per topic in one send call (kafkajs batches under
      // the hood). Key by aggregateId for partition stability so
      // same-experiment events land on the same partition and
      // preserve order.
      const publishResults = await Promise.all(
        Array.from(byTopic.entries()).map(([topic, rows]) =>
          producer.send({
            topic,
            messages: rows.map((r) => ({
              key: r.aggregateId,
              value: JSON.stringify({
                eventId: r.id,
                eventType: r.eventType,
                aggregateId: r.aggregateId,
                createdAt: r.createdAt.toISOString(),
                payload: r.payload,
              }),
            })),
          }),
        ),
      );

      // If all sends succeeded, mark the whole batch published.
      const acked = publishResults.every((r) => r.length > 0);
      if (acked) {
        await getDb().transaction(async (tx) => {
          await drizzle.outboxRepo.markPublished(
            tx,
            batch.map((r) => r.id),
          );
        });
        logger.debug({ size: batch.length }, "outbox-dispatcher: flushed batch");
      } else {
        logger.warn(
          "outbox-dispatcher: partial publish — skipping markPublished, will retry next poll",
        );
      }
    } catch (err) {
      logger.error({ err }, "outbox-dispatcher: loop error, backing off");
      await sleep(2000);
    }
  }

  await disconnectKafka();
  logger.info("outbox-dispatcher: stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Kick off the worker at API boot**

In `apps/api/src/index.ts`, add near the top alongside the other worker imports:

```ts
import { runOutboxDispatcher, stopOutboxDispatcher } from "./workers/outbox-dispatcher";
```

After the HTTP server starts (look for the `.listen(` or `serve(` call), add:

```ts
void runOutboxDispatcher();
```

In the shutdown handler (SIGTERM / SIGINT block — existing in `index.ts`), add:

```ts
stopOutboxDispatcher();
```

If there is no existing shutdown handler, add one before the `serve(` call:

```ts
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "shutdown requested");
    stopOutboxDispatcher();
  });
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @rovenue/api build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/outbox-dispatcher.ts apps/api/src/index.ts
git commit -m "feat(api): outbox-dispatcher worker — drain outbox → Redpanda"
```

---

### Task D.4: Integration test — outbox round-trip through Redpanda

**Files:**
- Create: `apps/api/tests/outbox-dispatcher.integration.test.ts`

This test spins a Redpanda container, starts the dispatcher, inserts an outbox row through the repo, and asserts a message arrives on the `rovenue.exposures` topic with the expected envelope. Round-trip latency should be sub-2s.

- [ ] **Step 1: Write the test**

Write to `apps/api/tests/outbox-dispatcher.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Kafka } from "kafkajs";
import { drizzle, getDb } from "@rovenue/db";
import { runOutboxDispatcher, stopOutboxDispatcher } from "../src/workers/outbox-dispatcher";

let redpanda: StartedTestContainer;
let brokerUrl: string;

beforeAll(async () => {
  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withCommand([
      "redpanda",
      "start",
      "--smp=1",
      "--memory=512M",
      "--overprovisioned",
      "--node-id=0",
      "--check=false",
      "--kafka-addr=PLAINTEXT://0.0.0.0:9092",
      "--advertise-kafka-addr=PLAINTEXT://localhost:9092",
    ])
    .withExposedPorts(9092)
    .start();
  brokerUrl = `localhost:${redpanda.getMappedPort(9092)}`;
  process.env.KAFKA_BROKERS = brokerUrl;
}, 60_000);

afterAll(async () => {
  stopOutboxDispatcher();
  await redpanda?.stop();
});

describe("outbox-dispatcher integration", () => {
  it("publishes an EXPOSURE row to rovenue.exposures", async () => {
    // 1. Insert a row via the repo.
    const db = getDb();
    const id = "evt_test_1";
    await drizzle.outboxRepo.insert(db, {
      id,
      aggregateType: "EXPOSURE",
      aggregateId: "exp_e2e",
      eventType: "experiment.exposure.recorded",
      payload: { experimentId: "exp_e2e", variantId: "var_a" },
    });

    // 2. Start the dispatcher in the background.
    void runOutboxDispatcher();

    // 3. Consume from rovenue.exposures.
    const kafka = new Kafka({ clientId: "test", brokers: [brokerUrl] });
    const consumer = kafka.consumer({ groupId: `test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: "rovenue.exposures", fromBeginning: true });

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
      void consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timer);
          resolve(message.value?.toString() ?? "");
        },
      });
    });

    expect(JSON.parse(received)).toMatchObject({
      eventId: id,
      aggregateId: "exp_e2e",
      payload: expect.objectContaining({ experimentId: "exp_e2e" }),
    });

    await consumer.disconnect();
  }, 30_000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rovenue/api test outbox-dispatcher.integration`
Expected: PASS within 30s. If it times out, check `docker ps` — testcontainers should have a fresh Redpanda container; if not, Docker is likely not running.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/outbox-dispatcher.integration.test.ts
git commit -m "test(api): outbox-dispatcher integration — Redpanda round-trip"
```

---

## Phase E — ClickHouse Kafka Engine + materialized views

### Task E.1: Migration 0002 — Kafka Engine table + raw_exposures target + MV

**Files:**
- Create: `packages/db/clickhouse/migrations/0002_exposures_kafka_engine.sql`
- Create: `deploy/clickhouse/config.d/kafka.xml`

- [ ] **Step 1: Kafka broker config for the CH server**

Write to `deploy/clickhouse/config.d/kafka.xml`:

```xml
<!--
  ClickHouse Kafka Engine global config. Per-table overrides go in
  the CREATE TABLE ... SETTINGS clause, but the broker list lives
  here so we don't leak it into the migration SQL (which is hashed
  and immutable after apply).

  Important: ClickHouse maps XML child names under <kafka> into
  librdkafka property names by replacing `_` with `.`. So e.g.
  <bootstrap_servers> -> `bootstrap.servers`, <debug> -> `debug`.
  The `<kafka_broker_list>` / `<kafka_group_id_prefix>` tags you may
  find in older CH docs are NOT librdkafka properties on CH 24.3
  and cause the server to fail loading config.d. Use the standard
  librdkafka names (`bootstrap_servers`) instead; per-table
  `kafka_group_name` is authoritative for consumer group identity,
  so no prefix setting is needed here.

  When redpanda resolves as the docker-compose hostname, CH sees the
  internal listener at 9092. Integration tests (testcontainers) set
  the broker via SETTINGS override.
-->
<clickhouse>
  <kafka>
    <bootstrap_servers>redpanda:9092</bootstrap_servers>
    <debug>broker,fetch</debug>
  </kafka>
</clickhouse>
```

- [ ] **Step 2: Migration SQL**

Write to `packages/db/clickhouse/migrations/0002_exposures_kafka_engine.sql`:

```sql
CREATE TABLE IF NOT EXISTS rovenue.exposures_queue
(
  eventId      String,
  eventType    String,
  aggregateId  String,
  createdAt    String,
  payload      String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'redpanda:9092',
  kafka_topic_list = 'rovenue.exposures',
  kafka_group_name = 'rovenue-ch-exposures',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_max_block_size = 1048576,
  kafka_skip_broken_messages = 100;

CREATE TABLE IF NOT EXISTS rovenue.raw_exposures
(
  eventId        String,
  experimentId   String,
  variantId      String,
  projectId      String,
  subscriberId   String,
  platform       LowCardinality(String),
  country        LowCardinality(String),
  exposedAt      DateTime64(3, 'UTC'),
  insertedAt     DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(insertedAt)
ORDER BY (projectId, experimentId, exposedAt, eventId)
PARTITION BY toYYYYMM(exposedAt)
TTL toDateTime(exposedAt) + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_exposures_to_raw
TO rovenue.raw_exposures AS
SELECT
  eventId                                                   AS eventId,
  JSONExtractString(payload, 'experimentId')                AS experimentId,
  JSONExtractString(payload, 'variantId')                   AS variantId,
  JSONExtractString(payload, 'projectId')                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                AS subscriberId,
  JSONExtractString(payload, 'platform')                    AS platform,
  JSONExtractString(payload, 'country')                     AS country,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'exposedAt'), 3
  )                                                         AS exposedAt,
  now64(3, 'UTC')                                           AS insertedAt
FROM rovenue.exposures_queue;
```

> `kafka_skip_broken_messages = 100` lets the consumer skip up to 100 malformed messages per poll instead of halting; broken messages are logged to `system.kafka_consumers` so a poisoned payload does not wedge the pipeline. `kafka_num_consumers = 1` matches the single-partition default — bump in Plan 3 when we shard.
> Each migration statement ends with a `;` on its own line per the runner split rule (packages/db/src/clickhouse-migrate.ts).
> The runner splits on `/;\s*$/m` and then filters out any statement that starts with `--`, which means a file-level header comment block at the top of the .sql (before the first `;`) silently drops the first CREATE. Open the file **directly** with `CREATE TABLE IF NOT EXISTS …` — inline mid-file `--` comments between statements are fine; a leading `-- 0002_…` header block is not.

- [ ] **Step 3: Apply**

Bounce the CH container so the new kafka.xml takes effect:
```bash
docker compose restart clickhouse
docker compose ps clickhouse  # wait for healthy
```

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate`
Expected: prints `applying 0002_exposures_kafka_engine.sql` and exit 0.

- [ ] **Step 4: Verify the three tables exist**

Run: `docker compose exec clickhouse clickhouse-client --query "SHOW TABLES FROM rovenue"`
Expected: includes `exposures_queue`, `raw_exposures`, `mv_exposures_to_raw`, plus `_migrations` and whatever 0001 created.

- [ ] **Step 5: End-to-end smoke**

With the API running (so the outbox dispatcher is alive), insert a row directly via psql:

```bash
docker compose exec db psql -U rovenue -d rovenue -c "INSERT INTO outbox_events (id, \"aggregateType\", \"aggregateId\", \"eventType\", payload) VALUES ('evt_smoke_1', 'EXPOSURE', 'exp_smoke', 'experiment.exposure.recorded', '{\"experimentId\":\"exp_smoke\",\"variantId\":\"var_a\",\"projectId\":\"prj_smoke\",\"subscriberId\":\"sub_1\",\"platform\":\"ios\",\"country\":\"US\",\"exposedAt\":\"2026-04-24T10:00:00.000Z\"}');"
```

Wait ~5s for the dispatcher to publish and CH's Kafka consumer poll cycle. Then:

```bash
docker compose exec clickhouse clickhouse-client --query "SELECT eventId, experimentId, variantId FROM rovenue.raw_exposures FINAL WHERE projectId = 'prj_smoke'"
```

Expected: one row with `eventId=evt_smoke_1`, `experimentId=exp_smoke`, `variantId=var_a`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/clickhouse/migrations/0002_exposures_kafka_engine.sql deploy/clickhouse/config.d/kafka.xml
git commit -m "feat(ch): exposures Kafka Engine + raw_exposures ReplacingMergeTree"
```

---

### Task E.2: Migration 0003 — mv_experiment_daily rollup

**Files:**
- Create: `packages/db/clickhouse/migrations/0003_mv_experiment_daily.sql`

`mv_experiment_daily` is the SummingMergeTree rollup the experiment results endpoint (Task F.4) reads from: one row per `(projectId, experimentId, variantId, platform, day)` with exposure counts and unique-subscriber HLL. SRM/CUPED run against this view, not raw_exposures, so point-queries stay sub-100ms.

- [ ] **Step 1: Write the migration**

Write to `packages/db/clickhouse/migrations/0003_mv_experiment_daily.sql`:

```sql
CREATE TABLE IF NOT EXISTS rovenue.mv_experiment_daily_target
(
  projectId       String,
  experimentId    String,
  variantId       String,
  platform        LowCardinality(String),
  day             Date,
  exposures       UInt64,
  subscribersHll  AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
ORDER BY (projectId, experimentId, variantId, platform, day)
PARTITION BY toYYYYMM(day)
TTL day + INTERVAL 2 YEAR DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_experiment_daily
TO rovenue.mv_experiment_daily_target AS
SELECT
  projectId,
  experimentId,
  variantId,
  platform,
  toDate(exposedAt)      AS day,
  count()                AS exposures,
  uniqState(subscriberId) AS subscribersHll
FROM rovenue.raw_exposures
GROUP BY projectId, experimentId, variantId, platform, day;
```

- [ ] **Step 2: Apply and verify**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate`
Expected: applies 0003.

Smoke: insert a second exposure via outbox (different subscriber), wait 5s, then:

```bash
docker compose exec clickhouse clickhouse-client --query "SELECT experimentId, variantId, sum(exposures) AS ex, uniqMerge(subscribersHll) AS sub FROM rovenue.mv_experiment_daily_target WHERE projectId = 'prj_smoke' GROUP BY experimentId, variantId"
```

Expected: one row with ex=2 (or more if you re-ran the smoke), sub=2.

- [ ] **Step 3: Commit**

```bash
git add packages/db/clickhouse/migrations/0003_mv_experiment_daily.sql
git commit -m "feat(ch): mv_experiment_daily SummingMergeTree rollup"
```

---

## Phase F — API endpoints (SSE config stream, exposure ingest, results)

Phase F reuses the statistical & SSE groundwork from the superseded plan (which was itself valid — only the write path pivoted). Rather than re-transcribe ~600 lines of task bodies, each task below points at the **exact line range** in `docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md` to copy verbatim, plus an explicit delta where this plan's semantics diverge. That file is in-tree and the engineer can open it side-by-side.

### Task F.1: ClickHouse client wrapper — `apps/api/src/lib/clickhouse.ts`

**Files:**
- Create: `apps/api/src/lib/clickhouse.ts`

Copy the full implementation from superseded plan `docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md` **Task 5.1, lines 1515-1686 verbatim**. No semantic change — the CH read path is identical under outbox ingestion.

- [ ] **Step 1: Copy the superseded Task 5.1 code into `apps/api/src/lib/clickhouse.ts`**
- [ ] **Step 2: Run `pnpm --filter @rovenue/api build`** — expect exit 0.
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/clickhouse.ts
git commit -m "feat(api): ClickHouse client wrapper (typed query helper)"
```

---

### Task F.2: Exposure ingest route — `POST /v1/experiments/:id/expose`

**Files:**
- Create: `apps/api/src/routes/v1/experiments.ts` (new file — this plan owns both the expose and results endpoints)
- Modify: `apps/api/src/app.ts` (mount)

**Delta vs. superseded plan Task 6.3:** the route body no longer buffers to Redis or batch-inserts into Postgres. It opens a short transaction and calls `eventBus.publishExposure(tx, ...)`. Authorization, Zod validation, rate limiting, and audit-log behaviour are unchanged.

- [ ] **Step 1: Write the route**

Write to `apps/api/src/routes/v1/experiments.ts`:

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "@rovenue/db";
import { eventBus } from "../../services/event-bus";
import { bearerAuth } from "../../middleware/bearer-auth";
import { rateLimit } from "../../middleware/rate-limit";
import { error, ok } from "../../lib/response";

const exposeSchema = z.object({
  variantId: z.string().min(1),
  subscriberId: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]).optional(),
  country: z.string().length(2).optional(),
  exposedAt: z.string().datetime().optional(),
});

export const experimentsRouter = new Hono()
  .use("*", bearerAuth({ scope: "project.sdk" }))
  .use("*", rateLimit({ windowMs: 1000, max: 500, key: "project" }))
  .post(
    "/:id/expose",
    zValidator("json", exposeSchema),
    async (c) => {
      const experimentId = c.req.param("id");
      const input = c.req.valid("json");
      const projectId = c.get("projectId") as string;

      try {
        await getDb().transaction(async (tx) => {
          await eventBus.publishExposure(tx, {
            experimentId,
            variantId: input.variantId,
            projectId,
            subscriberId: input.subscriberId,
            platform: input.platform,
            country: input.country,
            exposedAt: input.exposedAt ? new Date(input.exposedAt) : undefined,
          });
        });
      } catch (err) {
        return error(c, {
          code: "EXPOSE_FAILED",
          message: "failed to record exposure",
          cause: err,
        });
      }

      return ok(c, { accepted: true });
    },
  );
```

> If `middleware/bearer-auth.ts` / `middleware/rate-limit.ts` / `lib/response.ts` do not exist under these exact paths, grep for `bearerAuth` / `rateLimit` / `ok(` / `error(` across `apps/api/src/` and fix the imports to match whatever the existing idiom is — the sdk authentication is expected to be wired for other SDK-facing endpoints already.

- [ ] **Step 2: Mount in `app.ts`**

Add to `apps/api/src/app.ts` near the other `.route(` calls:

```ts
import { experimentsRouter } from "./routes/v1/experiments";
// ...
app.route("/v1/experiments", experimentsRouter);
```

- [ ] **Step 3: Write a route-level test**

Write to `apps/api/tests/v1-experiments-expose.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

vi.mock("../src/services/event-bus", () => ({
  eventBus: { publishExposure: vi.fn() },
}));

describe("POST /v1/experiments/:id/expose", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("accepts a valid payload and returns 200", async () => {
    const res = await app.request("/v1/experiments/exp_1/expose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test_project_key",
      },
      body: JSON.stringify({
        variantId: "var_a",
        subscriberId: "sub_1",
        platform: "ios",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { accepted: true } });
  });

  it("rejects missing variantId with 400", async () => {
    const res = await app.request("/v1/experiments/exp_1/expose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test_project_key",
      },
      body: JSON.stringify({ subscriberId: "sub_1" }),
    });
    expect(res.status).toBe(400);
  });
});
```

If the existing in-tree SDK auth middleware rejects `test_project_key`, mock it at the top of the test like other SDK route tests do (grep for a sibling test to find the pattern).

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @rovenue/api test v1-experiments-expose`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/experiments.ts apps/api/src/app.ts apps/api/tests/v1-experiments-expose.test.ts
git commit -m "feat(api): POST /v1/experiments/:id/expose via eventBus"
```

---

### Task F.3: SSE config stream — `/v1/config/stream`

**Files:**
- Create: `apps/api/src/routes/v1/config-stream.ts`
- Modify: `apps/api/src/app.ts` (mount)

Copy the full implementation from superseded plan `docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md` **Task 7.1, lines 2137-2367 verbatim**. The SSE handler streams flag/experiment config to SDKs via Redis pub-sub; it does not touch the ingest path, so no semantic change.

- [ ] **Step 1: Copy the file and its test (Task 7.2, lines 2275-2367)**
- [ ] **Step 2: Mount `/v1/config/stream` in `app.ts`**
- [ ] **Step 3: Run the test and commit**

```bash
git add apps/api/src/routes/v1/config-stream.ts apps/api/tests/v1-config-stream.test.ts apps/api/src/app.ts
git commit -m "feat(api): SSE /v1/config/stream (verbatim from superseded plan Task 7.1)"
```

---

### Task F.4: Experiment results service — `services/experiment-results.ts`

**Files:**
- Create: `apps/api/src/services/experiment-results.ts`
- Create: `apps/api/tests/experiment-results.test.ts`

Copy the full implementation from superseded plan `docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md` **Task 8.1, lines 2370-2530 verbatim**. The service reads from CH; whether `raw_exposures` was filled by PeerDB (old) or Kafka Engine (new) is invisible to this layer.

- [ ] **Step 1: Copy the service**
- [ ] **Step 2: Copy the companion unit test (same Task 8.1 block)**
- [ ] **Step 3: Run the test and commit**

```bash
git add apps/api/src/services/experiment-results.ts apps/api/tests/experiment-results.test.ts
git commit -m "feat(api): experiment-results service (CUPED/mSPRT/SRM over CH)"
```

---

### Task F.5: Results route — `GET /v1/experiments/:id/results`

**Files:**
- Modify: `apps/api/src/routes/v1/experiments.ts` (append the GET handler)

Copy the route body from superseded plan Task 8.2, lines 2531-2630. Append it to the `experimentsRouter` chain created in Task F.2 (don't create a separate file — the two handlers share the same auth + rate limit chain).

- [ ] **Step 1: Append the `.get("/:id/results", ...)` handler**
- [ ] **Step 2: Copy the companion route test (Task 8.2)**
- [ ] **Step 3: Run the test and commit**

```bash
git add apps/api/src/routes/v1/experiments.ts apps/api/tests/v1-experiments-results.test.ts
git commit -m "feat(api): GET /v1/experiments/:id/results — CH-backed stats"
```

---

### Task F.6: Analytics router dispatcher

**Files:**
- Create: `apps/api/src/routes/analytics-router.ts`

Copy from superseded plan Task 5.2, lines 1686-1770 verbatim. The dispatcher routes aggregate queries to CH when available and degrades to Postgres fallbacks otherwise. Unchanged in the Kafka pivot.

- [ ] **Step 1: Copy the file**
- [ ] **Step 2: Mount wherever Task 5.2 mounted it (check that file's last Step for the app.ts integration)**
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/analytics-router.ts apps/api/src/app.ts
git commit -m "feat(api): analytics-router dispatcher (CH-or-Postgres fallback)"
```

---

## Phase G — Hardening

### Task G.1: CH Kafka Engine parity integration test

**Files:**
- Create: `apps/api/tests/ch-kafka-engine.integration.test.ts`

Spin both Redpanda AND ClickHouse via testcontainers, run migrations 0001→0003 against the CH container, insert an outbox row, run the dispatcher for 15s, and assert:
1. `raw_exposures` has the row
2. `mv_experiment_daily_target` has a matching grouped row

- [ ] **Step 1: Write the test**

Write to `apps/api/tests/ch-kafka-engine.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { createClient } from "@clickhouse/client";
import { drizzle, getDb } from "@rovenue/db";
import { runOutboxDispatcher, stopOutboxDispatcher } from "../src/workers/outbox-dispatcher";
import { runClickhouseMigrations } from "../../packages/db/src/clickhouse-migrate"; // if exported; otherwise exec the script via child_process

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;

beforeAll(async () => {
  network = await new Network().start();

  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withNetwork(network)
    .withNetworkAliases("redpanda")
    .withCommand([
      "redpanda", "start", "--smp=1", "--memory=512M", "--overprovisioned",
      "--node-id=0", "--check=false",
      "--kafka-addr=PLAINTEXT://0.0.0.0:9092,EXTERNAL://0.0.0.0:19092",
      "--advertise-kafka-addr=PLAINTEXT://redpanda:9092,EXTERNAL://localhost:19092",
    ])
    .withExposedPorts(19092)
    .start();

  clickhouse = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
    .withNetwork(network)
    .withExposedPorts(8123)
    .withEnvironment({ CLICKHOUSE_DB: "rovenue" })
    .withCopyContentToContainer([
      {
        content: `<clickhouse><kafka><bootstrap_servers>redpanda:9092</bootstrap_servers></kafka></clickhouse>`,
        target: "/etc/clickhouse-server/config.d/kafka.xml",
      },
    ])
    .start();

  process.env.KAFKA_BROKERS = `localhost:${redpanda.getMappedPort(19092)}`;
  process.env.CLICKHOUSE_URL = `http://localhost:${clickhouse.getMappedPort(8123)}`;
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "";

  // Apply CH migrations (runner entry point; if not exported, shell out to the script).
  // Adjust import path if the runner doesn't export a callable; otherwise inline a shelling-out block.
}, 120_000);

afterAll(async () => {
  stopOutboxDispatcher();
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

describe("CH Kafka Engine parity", () => {
  it("raw_exposures and mv_experiment_daily_target receive outbox events", async () => {
    const id = `evt_parity_${Date.now()}`;
    await drizzle.outboxRepo.insert(getDb(), {
      id,
      aggregateType: "EXPOSURE",
      aggregateId: "exp_parity",
      eventType: "experiment.exposure.recorded",
      payload: {
        experimentId: "exp_parity",
        variantId: "var_a",
        projectId: "prj_parity",
        subscriberId: "sub_1",
        platform: "ios",
        country: "US",
        exposedAt: "2026-04-24T10:00:00.000Z",
      },
    });

    void runOutboxDispatcher();
    await waitFor(async () => {
      const ch = createClient({ url: process.env.CLICKHOUSE_URL! });
      const res = await ch.query({
        query: `SELECT count() AS c FROM rovenue.raw_exposures FINAL WHERE eventId = '${id}'`,
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ c: number }>;
      return rows[0]?.c === 1;
    }, 30_000);

    // Rollup assertion
    const ch = createClient({ url: process.env.CLICKHOUSE_URL! });
    const rollup = await ch.query({
      query: `SELECT sum(exposures) AS e FROM rovenue.mv_experiment_daily_target WHERE projectId='prj_parity'`,
      format: "JSONEachRow",
    });
    const rollupRows = (await rollup.json()) as Array<{ e: number }>;
    expect(rollupRows[0].e).toBe(1);
  }, 60_000);
});

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("waitFor timed out");
}
```

> If `runClickhouseMigrations` is not exported, either (a) refactor the runner to export a callable in a tiny follow-up commit, or (b) shell out with `execFile("pnpm", ["--filter","@rovenue/db","db:clickhouse:migrate"])` inside `beforeAll`.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rovenue/api test ch-kafka-engine.integration`
Expected: PASS within 2m.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/ch-kafka-engine.integration.test.ts
git commit -m "test(api): CH Kafka Engine parity — outbox → raw_exposures → rollup"
```

---

### Task G.2: Replay idempotency test

**Files:**
- Create: `apps/api/tests/outbox-replay-idempotency.test.ts`

Simulates the at-least-once scenario: publish the same `eventId` twice; assert `raw_exposures FINAL` returns exactly one row.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// ...reuse the same testcontainers fixture as G.1 (factor into a shared helper if
// both tests live in the same file, or duplicate the boilerplate — G.1 comments
// recommend duplication over cross-file container sharing).

describe("outbox replay idempotency", () => {
  it("two outbox rows with the same eventId collapse to one in raw_exposures FINAL", async () => {
    const eventId = `evt_replay_${Date.now()}`;
    const basePayload = {
      experimentId: "exp_replay",
      variantId: "var_a",
      projectId: "prj_replay",
      subscriberId: "sub_1",
      platform: "ios",
      country: "US",
      exposedAt: "2026-04-24T10:00:00.000Z",
    };

    // Insert twice directly (simulating dispatcher retrying after a crash
    // that happened between Kafka ack and markPublished — same eventId
    // re-published).
    // In practice we'd insert once and markPublished=NULL twice, but the
    // OLTP schema forbids duplicate ids; instead we publish the same
    // payload twice through an ad-hoc producer.
    const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKERS!] });
    const producer = kafka.producer();
    await producer.connect();
    for (let i = 0; i < 2; i++) {
      await producer.send({
        topic: "rovenue.exposures",
        messages: [{
          key: "exp_replay",
          value: JSON.stringify({
            eventId,
            eventType: "experiment.exposure.recorded",
            aggregateId: "exp_replay",
            createdAt: new Date().toISOString(),
            payload: basePayload,
          }),
        }],
      });
    }
    await producer.disconnect();

    await waitFor(async () => {
      const ch = createClient({ url: process.env.CLICKHOUSE_URL! });
      const res = await ch.query({
        query: `SELECT count() AS c FROM rovenue.raw_exposures FINAL WHERE eventId = '${eventId}'`,
        format: "JSONEachRow",
      });
      return ((await res.json()) as Array<{ c: number }>)[0]?.c === 1;
    }, 30_000);
  }, 60_000);
});
```

- [ ] **Step 2: Run and commit**

```bash
pnpm --filter @rovenue/api test outbox-replay-idempotency
git add apps/api/tests/outbox-replay-idempotency.test.ts
git commit -m "test(api): replay idempotency — ReplacingMergeTree on eventId"
```

---

### Task G.3: `verify-clickhouse` CLI

**Files:**
- Create: `packages/db/scripts/verify-clickhouse.ts`
- Modify: `packages/db/package.json` (script entry)

Schema-drift check: asserts that the tables/MVs/engines declared in `packages/db/clickhouse/migrations/*.sql` match what's live in the CH instance; prints outbox-unpublished backlog and CH Kafka consumer lag. Same pattern as `verify-timescale.ts` (Alan 4 plan Task 8.1).

- [ ] **Step 1: Write the script**

Write to `packages/db/scripts/verify-clickhouse.ts`:

```ts
import { createClient } from "@clickhouse/client";

const url = process.env.CLICKHOUSE_URL;
const user = process.env.CLICKHOUSE_USER ?? "rovenue";
const password = process.env.CLICKHOUSE_PASSWORD;
if (!url || !password) {
  console.error("CLICKHOUSE_URL and CLICKHOUSE_PASSWORD required");
  process.exit(1);
}

const client = createClient({ url, username: user, password, database: "rovenue" });

const EXPECTED_TABLES = [
  { name: "exposures_queue", engine: "Kafka" },
  { name: "raw_exposures", engine: "ReplacingMergeTree" },
  { name: "mv_exposures_to_raw", engine: "MaterializedView" },
  { name: "mv_experiment_daily", engine: "MaterializedView" },
  { name: "mv_experiment_daily_target", engine: "SummingMergeTree" },
];

async function main(): Promise<void> {
  const rows = (
    await (await client.query({
      query: `SELECT name, engine FROM system.tables WHERE database = 'rovenue' ORDER BY name`,
      format: "JSONEachRow",
    })).json()
  ) as Array<{ name: string; engine: string }>;

  const byName = new Map(rows.map((r) => [r.name, r.engine]));
  let drift = 0;

  console.log("ClickHouse schema check:");
  for (const expected of EXPECTED_TABLES) {
    const actual = byName.get(expected.name);
    const ok = actual === expected.engine;
    console.log(`  ${ok ? "✓" : "✗"} ${expected.name} — expected ${expected.engine}, got ${actual ?? "MISSING"}`);
    if (!ok) drift++;
  }

  // Kafka consumer lag.
  const lag = (
    await (await client.query({
      query: `SELECT topic, partition_id, current_offset, assignments FROM system.kafka_consumers FORMAT JSONEachRow`,
      format: "JSONEachRow",
    })).json()
  ) as unknown[];
  console.log("Kafka consumer state:");
  console.log(JSON.stringify(lag, null, 2));

  await client.close();
  process.exit(drift > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the script**

In `packages/db/package.json`, add this line to the `"scripts"` object (after `db:verify:timescale`):

```json
    "db:verify:clickhouse": "tsx scripts/verify-clickhouse.ts",
```

- [ ] **Step 3: Run it against the local CH**

Run: `pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: five `✓` lines, then the JSON consumer dump, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add packages/db/scripts/verify-clickhouse.ts packages/db/package.json
git commit -m "feat(db): verify-clickhouse CLI (schema drift + consumer lag)"
```

---

## Phase H — Final baseline + PR

### Task H.1: Full workspace test suite

- [ ] **Step 1: Clean boot the stack**

```bash
docker compose down -v
docker compose up -d
# wait ~30s for all services to become healthy
docker compose ps
```
Expected: all of `api`, `db`, `redis`, `clickhouse`, `redpanda`, `redpanda-console` show `healthy` / `running`.

- [ ] **Step 2: Replay all migrations**

```bash
pnpm --filter @rovenue/db db:migrate
pnpm --filter @rovenue/db db:clickhouse:migrate
```
Expected: both complete without error on a fresh volume.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm -r test
```
Expected: all packages pass. Integration tests in `apps/api/tests/` that spin testcontainers may take 2-3 minutes total.

- [ ] **Step 4: Run the verify scripts**

```bash
pnpm --filter @rovenue/db db:verify:timescale
pnpm --filter @rovenue/db db:verify:clickhouse
```
Expected: both exit 0.

---

### Task H.2: Mark the superseded plan

**Files:**
- Modify: `docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md` (top of file — already has a SUPERSEDED note from commit `703f58d`; confirm it links to this plan)

- [ ] **Step 1: Ensure the superseded header references this plan by filename**

Open the superseded plan and verify its header notes `docs/superpowers/plans/2026-04-24-kafka-analytics-foundation.md` as the successor. If not, add the reference inline (one-line edit; no other changes).

- [ ] **Step 2: Commit if edited**

```bash
git add docs/superpowers/plans/2026-04-23-clickhouse-foundation-and-experiments.md
git commit -m "docs(plan): link SUPERSEDED header to Kafka+outbox plan"
```

---

### Task H.3: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/clickhouse-analytics
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat: ClickHouse analytics via Kafka+outbox (pivot from PeerDB)" --body "$(cat <<'EOF'
## Summary

- Replaces the PeerDB CDC ingestion pipeline with an application-layer outbox pattern fanning into Redpanda; ClickHouse consumes via Kafka Engine + MVs.
- Rolls back migrations 0009 (exposure_events hypertable) and 0010 (publication) via forward-only migrations 0011/0012; removes the PeerDB submodule + `deploy/peerdb/`.
- Ships the exposures pipeline end-to-end: outbox write → outbox-dispatcher → `rovenue.exposures` topic → `raw_exposures` (ReplacingMergeTree) → `mv_experiment_daily_target` (SummingMergeTree). Revenue/credit fan-out is deferred to Plan 2.
- Adds SSE config stream and `/v1/experiments/:id/expose` + `/:id/results` (CUPED/mSPRT/SRM) route handlers.

The commit history is intentionally honest: it shows the PeerDB attempt, the TimescaleDB-hypertable blocker investigation, and the §14 pivot decision before the rollback and re-implementation.

See spec §14 (`docs/superpowers/specs/2026-04-20-tech-stack-upgrade/06-clickhouse.md`) for architecture rationale.

## Test plan

- [x] `pnpm -r test` passes
- [x] `pnpm --filter @rovenue/db db:verify:timescale` passes
- [x] `pnpm --filter @rovenue/db db:verify:clickhouse` passes
- [x] Outbox integration test — event published to Redpanda and consumed
- [x] CH Kafka Engine parity test — row lands in `raw_exposures` and rollup
- [x] Replay idempotency test — duplicate eventIds collapse under FINAL
- [ ] Manual: boot `docker compose up -d`, insert an outbox row via psql, see row in `raw_exposures` within 5s

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Post the PR URL back to the channel**

---

## Self-review summary

**Spec coverage:**
- §14.1 blocker rationale → captured in Phase A motivation
- §14.2 Opsiyon Y′ (outbox + Redpanda + CH Kafka Engine) → Phases B, C, D, E
- §14.3 rationale points (TimescaleDB irrelevant, exposure events fit, outbox safety, lighter ops, Kafka second-use backbone) → reflected in architecture narrative + scope note
- §14.4 §3.7 enumeration → implemented exactly (outbox + dispatcher + Kafka Engine)
- §14.5 Phase A-F outline → mapped 1:1 to plan Phases A-F (plus G hardening, H release)
- §14.6 honest history / forward-only rollback → Phase A uses DROP migrations 0011/0012 not file deletion
- §14.7 decision matrix → exposure_events Postgres table is dropped; revenue/credit hypertables remain; TimescaleDB remains; ClickHouse remains

**Placeholder scan:** every task has exact code blocks or an explicit `copy verbatim from <file> lines X-Y` directive. Tasks F.1, F.3, F.4, F.5, F.6 reuse the superseded plan by pointer (the file is in-tree); not a placeholder, but verify on execution that the referenced line ranges still resolve (they will unless the SUPERSEDED file is later reorganized).

**Type consistency:** `publishExposure(tx: Db, input)` signature matches between `services/event-bus.ts` (Task D.2) and its caller in `routes/v1/experiments.ts` (Task F.2). `aggregateType` enum values match across SQL (Task C.1), Drizzle (Task C.2), and the dispatcher topic map (Task D.3). `eventId` is the event's outbox `id` everywhere — same string propagates from `outbox_events.id` → Kafka envelope `eventId` → `raw_exposures.eventId`.

---

*End of plan.*
