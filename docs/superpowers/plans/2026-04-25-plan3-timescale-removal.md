# Plan 3 — TimescaleDB Tear-out + ClickHouse-Exclusive Read Path

Status: draft
Created: 2026-04-25
Branch: `plan/timescale-removal`
Follows: [Plan 2 — Revenue + Credit Outbox Fan-out](./2026-04-24-plan2-revenue-credit-outbox.md)
Deprecates: `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/04-timescaledb.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Reviewer note (2026-04-25):** This plan executes a strategic decision that has real downsides — the trade-off was discussed and accepted. Specifically: we lose Timescale's columnar compression (~10-20× on `revenue_events`), trade the `daily_mrr` continuous aggregate's sub-minute incremental refresh for the outbox-dispatcher's seconds-to-minutes Kafka lag, and accept a 2–3 week cutover with an irreversible Phase D. The win is a simpler stack (vanilla `postgres:16-alpine`, no TSL license boundary, fewer Docker image variants) and a single mental model: PG = OLTP system-of-record, ClickHouse = analytics read path, no third "time-series" layer in between. Don't merge phases out of order; the gate at Phase 0 is non-negotiable.

## Context

Plan 1 shipped the EXPOSURE pipeline end-to-end via outbox + Redpanda + ClickHouse Kafka Engine. Plan 2 extended the same pipeline to `REVENUE_EVENT` and `CREDIT_LEDGER`, shipped CH materialized views (`mv_mrr_daily_target`, `mv_credit_balance_target`, `mv_credit_consumption_daily_target`), and put the dashboard MRR endpoint behind a `MRR_READ_SOURCE` flag with `dual` mode for drift observation.

Plan 3 finishes the migration:

1. Validates the Plan 2 cutover gate in production (14d dual-read + 7d sub-1¢ drift). **Gate is a prerequisite, not a phase.**
2. Cuts the dashboard MRR endpoint over to CH-exclusive reads (deletes the `timescale` and `dual` branches of the adapter).
3. Migrates the remaining read paths flagged "Plan 3" in Plan 2's scope (subscriber-detail credit history, top-spender / consumption leaderboards) to ClickHouse.
4. Drops the `daily_mrr` continuous aggregate.
5. Converts `revenue_events`, `credit_ledger`, `outgoing_webhooks` from TimescaleDB hypertables to vanilla Postgres declarative range-partitioned tables (monthly partitions on the existing partition column).
6. Drops the TimescaleDB extension, all compression policies, all retention policies.
7. Installs `pg_partman` for partition lifecycle (premake forward, drop after 7 years per VUK).
8. Switches the Docker image from `timescale/timescaledb:2.17.2-pg16` to a custom `postgres:16-bookworm` image with `pg_partman` apt-installed.
9. Ships the deferred `outbox_events` cleanup worker (was Plan 2 non-goal).
10. Cleans up: deletes `verify-timescale.ts`, the `dailyMrr` Drizzle view binding, and all flag plumbing.

After Plan 3 the stack is: `postgres:16-bookworm` (custom image, pg_partman only) + `clickhouse:24.3-alpine` + `redpanda:v24.2.13` + `redis:7-alpine` + `api`.

## Goals

1. Zero Timescale-specific SQL in any migration that the new clean install runs (forward-only history; legacy migrations stay in `_journal.json` but their effects are fully reversed).
2. Dashboard MRR endpoint, subscriber-detail credit history, leaderboards all read from ClickHouse exclusively. No code path touches the OLTP store for analytics reads.
3. `revenue_events` and `credit_ledger` retain their VUK 7-year retention via pg_partman-managed partition drop. Verified by a 7-year synthetic test in Phase F.
4. `docker compose up` on a fresh checkout boots the full stack and applies all migrations clean — no `CREATE EXTENSION timescaledb` anywhere, no `CREATE INDEX CONCURRENTLY` outside transactions, no manual ops.
5. `pnpm test` green across the workspace; all Timescale fixtures replaced or deleted.

### Non-goals (deferred to later plans)

- **Credit balance read path migration.** `creditLedger.balance` (current snapshot per subscriber) **stays OLTP** — required for transactional spend/grant decisions in the same tx as the ledger row insert. CQRS split per Plan 2.
- **Audit-log read path migration.** Audit reads are admin-side, infrequent, low cardinality; PG is fine forever.
- **Compression replacement.** Vanilla PG has no chunk-level compression. We accept the storage growth (sketched ~50GB/year on `revenue_events`, ~350GB at 7y steady state). If we cross 200GB on a single node, evaluate `timescaledb-toolkit` (Apache 2.0, no TSL) or cold-tier S3 partitions via FDW. Out of scope here.
- **CH retention extension to 7y.** CH `raw_*` tables stay at 2-year TTL per Plan 2 ADR B.0. PG is the 7-year authoritative store. If deeper CH history needed, backfill from PG via `INSERT ... SELECT FROM postgres_fdw`.
- **Multi-tenant partition routing / hash partitioning.** Range partitioning by date is sufficient for current scale; revisit if a single project's monthly partition exceeds 50M rows.
- **Backup strategy swap.** `pgbackrest` config update (timescale image had it bundled) lands in a separate ops PR, not this plan. Document the gap in the runbook; ship before the maintenance window.

## Source-of-truth strategy

Identical to Plan 2's CQRS pattern, with the time-series layer removed:

| Aggregate | OLTP system of record (read + write) | Analytics read path |
| --- | --- | --- |
| `revenue_events` | Vanilla PG, monthly range-partitioned by `event_date`, 7-year retention via pg_partman | CH `raw_revenue_events` + `mv_mrr_daily_target` (2y TTL) |
| `credit_ledger` | Vanilla PG, monthly range-partitioned by `created_at`, 7-year retention via pg_partman | CH `raw_credit_ledger` + `mv_credit_balance_target` + `mv_credit_consumption_daily_target` (2y TTL) |
| `outgoing_webhooks` | Vanilla PG, monthly range-partitioned by `next_retry_at`, 90-day retention via existing webhook-retention worker (NOT pg_partman — predicate is composite) | n/a (not analytics) |
| `outbox_events` | Vanilla PG, NOT partitioned, ~24h hot retention via new cleanup worker | n/a (transient queue) |

**Hard rule (unchanged from Plan 2):** every analytics-bound OLTP write lands in `revenue_events` or `credit_ledger` first, in the same transaction as the outbox row. ClickHouse is never written to directly. The PG hypertable goes away; the PG **table** stays — same name, same columns, different storage shape underneath.

## File structure after Plan 3

```
packages/db/
├── clickhouse/migrations/         # unchanged from Plan 2
├── drizzle/migrations/
│   ├── 0001_timescaledb_extension.sql       # legacy — stays in journal, effect reversed by 0018
│   ├── 0002_hypertable_revenue_events.sql   # legacy — effect reversed by 0015
│   ├── 0003_hypertable_credit_ledger.sql    # legacy — effect reversed by 0016
│   ├── 0004_hypertable_outgoing_webhooks.sql # legacy — effect reversed by 0017
│   ├── 0005_cagg_daily_mrr.sql              # legacy — effect reversed by 0014
│   ├── 0006_compression_policies.sql        # legacy — effect reversed by 0018
│   ├── 0007_retention_policies.sql          # legacy — effect reversed by 0018
│   ├── ... (0008–0013 unchanged)
│   ├── 0014_drop_daily_mrr_cagg.sql         # NEW — Phase C
│   ├── 0015_partition_revenue_events.sql    # NEW — Phase D
│   ├── 0016_partition_credit_ledger.sql     # NEW — Phase D
│   ├── 0017_partition_outgoing_webhooks.sql # NEW — Phase D
│   ├── 0018_drop_timescaledb_extension.sql  # NEW — Phase E
│   └── 0019_install_pg_partman.sql          # NEW — Phase F
├── scripts/
│   ├── verify-clickhouse.ts                 # MODIFY — Phase G (drop timescale-cross-check assertions if any)
│   ├── verify-timescale.ts                  # DELETE — Phase G
│   └── migrate-hypertable-to-partitioned.ts # NEW — Phase D (copy-and-swap helper, runs outside the migration)
├── src/drizzle/
│   ├── schema.ts                            # MODIFY — Phase D (composite PKs include partition key)
│   ├── views.ts                             # MODIFY — Phase C (drop dailyMrr)
│   ├── repositories/metrics.ts              # MODIFY — Phase C (drop cagg-bound helpers)
│   └── drizzle-foundation.test.ts           # MODIFY — Phase D (replace hypertable assertions with partition assertions)

apps/api/src/
├── lib/env.ts                               # MODIFY — Phase A (drop MRR_READ_SOURCE enum)
├── routes/dashboard/metrics.ts              # MODIFY — Phase A (drop flag dispatch)
├── routes/dashboard/subscribers.ts          # MODIFY — Phase B (credit history → CH)
├── routes/dashboard/leaderboards.ts         # MODIFY or NEW — Phase B
├── services/metrics/
│   ├── mrr-adapter.ts                       # DELETE — Phase A (logic merges into mrr.ts)
│   └── mrr.ts                               # NEW — Phase A (CH-only)
├── services/credit-history.ts               # NEW — Phase B
└── workers/
    ├── outbox-cleanup.ts                    # NEW — Phase F
    └── partition-maintenance.ts             # NEW — Phase F

apps/api/tests/
├── dashboard-mrr-dual-read.test.ts          # DELETE — Phase A
├── mrr-correlation.integration.test.ts      # DELETE — Phase A (gate has passed)
├── mrr-clickhouse-only.integration.test.ts  # NEW — Phase A
├── credit-history-ch.integration.test.ts    # NEW — Phase B
├── partition-maintenance.integration.test.ts # NEW — Phase F
└── outbox-cleanup.integration.test.ts       # NEW — Phase F

deploy/
└── postgres/
    ├── Dockerfile                           # NEW — Phase G (postgres:16-bookworm + pg_partman)
    └── init.sql                             # NEW — Phase G (CREATE EXTENSION pg_partman in template1)

docker-compose.yml                            # MODIFY — Phase G (db image swap, drop timescale shared_preload_libraries)
.env.example                                  # MODIFY — Phase G (drop MRR_READ_SOURCE)
CLAUDE.md                                     # MODIFY — Phase G (Postgres 16 vanilla, no Timescale)
```

## Cross-plan conventions (inherited from Plans 1–2)

Settled, do not re-litigate:

- **Forward-only migrations.** Don't delete legacy migration files; reverse their effects with new migrations. Honest history per spec §14.6.
- **Same-tx safety.** Every caller of `eventBus.publish*` passes a `tx: Db` binding. Business row + outbox row commit together or neither commits.
- **Migration numbering.** Drizzle migrations sequential, zero-padded to 4 digits. Plan 2 ended at 0013; Plan 3 uses 0014–0019.
- **Hand-authored SQL + journal entry.** Same contract as Plans 1–2.
- **Test containers per file.** Don't share containers across files — isolation beats speed. Reuse `apps/api/tests/_helpers` fixtures.

## Testing conventions (additions for Plan 3)

- **Phase D dry-run is mandatory.** No Phase D migration ships without a green run of `migrate-hypertable-to-partitioned.ts` against a Timescale-seeded testcontainer with ≥30 days of synthetic data, verifying post-migration row counts byte-for-byte match pre-migration counts.
- **VUK 7-year retention is verified, not assumed.** Phase F includes an integration test that seeds an 8-year-old row, runs the partition-maintenance worker, and asserts both the partition and the row are dropped. This is the single load-bearing compliance test for the new path.
- **CH-only freshness budget assertion.** Phase A's new `mrr-clickhouse-only.integration.test.ts` measures end-to-end latency from outbox INSERT to dashboard endpoint visibility. Budget: p95 ≤ 5s, p99 ≤ 30s on the testcontainer fixture. If either is exceeded, the dispatcher poll interval or batch size needs tuning before merge.

---

## Phase 0 — Cutover gate validation (PRODUCTION, before any code in this plan)

This phase ships no code. It runs on the existing Plan 2 deployment.

- [ ] **0.1** Confirm `MRR_READ_SOURCE=dual` is set in the production environment. Log timestamp of the flip.
- [ ] **0.2** **Time gate:** wait ≥ 14 calendar days from 0.1.
- [ ] **0.3** **Drift gate:** capture `mrr.dual.drift` log values per project per day. Assert `|CH_MRR − Timescale_MRR| < 1¢` for **7 consecutive days** at the *end* of the 14-day window. Older drift within the window is fine (catch-up after deployment).
- [ ] **0.4** **Completeness gate:** zero `mrr.dual.missing-in-clickhouse` warnings in the same 7-day window. (`missing-in-timescale` is fine — Timescale lagging is acceptable since we're cutting over away from it.)
- [ ] **0.5** Document gate-pass timestamp + raw drift numbers in the Plan 3 PR body. Production observation, not testcontainer numbers.

If any gate fails: STOP. File a bug under "CH ingestion drift" and resolve before reopening Plan 3. The whole plan is gated on this — no exceptions, no `BYPASS_GATE` flag in production.

For local + staging testing during plan execution: `PLAN3_BYPASS_GATE=1` env var skips Phase 0 in non-prod environments. The env loader logs `[plan3] gate bypassed — non-prod only` on startup; if this log appears in prod, fail the deploy.

## Phase A — Cut over MRR endpoint to CH-exclusive

**Goal:** delete every code path that reads MRR from Timescale. The endpoint shape doesn't change; only the underlying source.

### Task A.1: Replace mrr-adapter with CH-only mrr service

**Files:**
- Create: `apps/api/src/services/metrics/mrr.ts`
- Delete: `apps/api/src/services/metrics/mrr-adapter.ts`

Tasks:
- [ ] Move `clickhouseListDailyMrr` from `mrr-adapter.ts` to `mrr.ts` as the default export `listDailyMrr`. Drop the `mode` parameter; signature is `(input: ListDailyMrrInput) => Promise<ListDailyMrrOutput[]>`.
- [ ] Drop `timescaleListDailyMrr`. Delete the `mrr.dual.drift`, `mrr.dual.missing-in-timescale`, `mrr.dual.missing-in-clickhouse` log calls (they're meaningless when only one source exists).
- [ ] Drop the `dual` branch's `Promise.all(...)` and reconciliation logic.
- [ ] Update import in `apps/api/src/routes/dashboard/metrics.ts`: `import { listDailyMrr } from "../../services/metrics/mrr"`.

### Task A.2: Remove the MRR_READ_SOURCE env flag

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`

Tasks:
- [ ] Delete the `MRR_READ_SOURCE` zod field.
- [ ] Delete the comment block above it explaining `timescale | clickhouse | dual`.
- [ ] Delete the `MRR_READ_SOURCE=` line from `.env.example`.
- [ ] Grep-verify no other consumers: `rg MRR_READ_SOURCE apps packages` returns zero hits.

### Task A.3: Replace dual-read tests with CH-only test

**Files:**
- Delete: `apps/api/tests/dashboard-mrr-dual-read.test.ts`
- Delete: `apps/api/tests/mrr-correlation.integration.test.ts`
- Create: `apps/api/tests/mrr-clickhouse-only.integration.test.ts`

The new test asserts:
1. Response shape unchanged from the dual-read snapshot (same JSON).
2. End-to-end freshness: outbox INSERT → endpoint visibility within p95 ≤ 5s, p99 ≤ 30s.
3. Empty-result behavior: a project with zero revenue events returns `[]`, not an error.

The deleted correlation test served its purpose (drift gate); preserving it post-cutover is dead weight.

## Phase B — Migrate remaining "Plan 3" read paths to CH

**Goal:** subscriber-detail credit history pagination + leaderboards land on `raw_credit_ledger` and `mv_credit_consumption_daily_target` respectively. After this phase, the OLTP store has zero analytics queries pointed at it.

### Task B.1: Subscriber credit history → CH `raw_credit_ledger`

**Files:**
- Create: `apps/api/src/services/credit-history.ts`
- Modify: `apps/api/src/routes/dashboard/subscribers.ts` — `GET /:id/credit-history`

The new service:
- Reads from CH `raw_credit_ledger` filtered by `(projectId, subscriberId)`.
- Keyset pagination on `(createdAt DESC, id DESC)`. NO offset pagination — `raw_credit_ledger` is a `ReplacingMergeTree`, offset breaks under merges.
- Document the eventual-consistency window in the response header: `X-Read-Lag: <p95-seconds>` (informational; client doesn't need to parse).
- If a row was just written to PG and isn't yet in CH (within the dispatcher poll window), the response will not include it. This is the documented trade-off.

Tasks:
- [ ] Write the service.
- [ ] Wire the route. Drop the existing PG-backed query and its repository.
- [ ] Integration test: `credit-history-ch.integration.test.ts`. Seed via outbox, wait for CH convergence, assert paginated response. Test pagination boundary cases (page boundary equals row count; empty page after last row).

### Task B.2: Top spenders / consumption leaderboards → CH `mv_credit_consumption_daily_target`

**Files:**
- Modify or create: `apps/api/src/routes/dashboard/leaderboards.ts`

Tasks:
- [ ] Top-N query: `SELECT subscriberId, sum(debited_credits) FROM mv_credit_consumption_daily_target WHERE projectId = ? AND day BETWEEN ? AND ? GROUP BY subscriberId ORDER BY sum(debited_credits) DESC LIMIT ?`.
- [ ] Document the freshness budget in the route comment (≤2s p99 from dispatcher).
- [ ] Test against testcontainer.

## Phase C — Drop the daily_mrr continuous aggregate

**Goal:** with all reads off Timescale (Phases A–B), the `daily_mrr` cagg has zero consumers. Drop it and its policy. Must run before Phase E (extension drop).

### Task C.1: Migration 0014 — drop the cagg

**Files:**
- Create: `packages/db/drizzle/migrations/0014_drop_daily_mrr_cagg.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

```sql
-- 0014_drop_daily_mrr_cagg.sql
-- Removes the daily_mrr continuous aggregate created in 0005 and its
-- refresh policy. Pre-req: Phase A + B shipped — no consumers remain.
-- Pre-req: Phase 0 cutover gate passed.

-- The policy must be removed before the cagg can be dropped.
SELECT remove_continuous_aggregate_policy('daily_mrr', if_exists => true);

DROP MATERIALIZED VIEW IF EXISTS daily_mrr CASCADE;
```

### Task C.2: Drop Drizzle bindings

**Files:**
- Modify: `packages/db/src/drizzle/views.ts` — delete the `dailyMrr` `pgMaterializedView` export and the comment block above it.
- Modify: `packages/db/src/drizzle/repositories/metrics.ts` — delete any helpers that referenced the view directly. The CH-side equivalents in `mv_mrr_daily_target` are already in place.
- Modify: `packages/db/src/drizzle/index.ts` — drop the re-export.
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts` — delete the cagg-existence assertion.

Tasks:
- [ ] Delete the bindings.
- [ ] `pnpm --filter @rovenue/db build` green.
- [ ] `rg dailyMrr apps packages` returns zero hits.

## Phase D — Convert hypertables to declarative range-partitioned tables

**Goal:** `revenue_events`, `credit_ledger`, `outgoing_webhooks` become vanilla PG range-partitioned tables. Same names, same columns, different storage. **This phase is irreversible past the legacy table drop step.**

### ADR D.0: Why copy-and-swap, not in-place conversion

There is no `ALTER TABLE ... PARTITION BY` in PostgreSQL. Converting a non-partitioned table (or a Timescale hypertable) to a declarative-partitioned table requires:
1. Create a new table with the desired partitioning.
2. Copy data into it.
3. Atomically rename old → legacy, new → original.
4. Drop legacy after row-count verification.

This is a well-trodden pattern. Risks: requires a maintenance window with the table read-only (or briefly write-locked); Timescale's chunk metadata needs care during the COPY (we read from the hypertable as a plain table — Timescale exposes it as one — and write into the new partitioned table). The copy-and-swap helper script runs outside the migration to avoid wrapping the entire copy in a single transaction (which could lock the table for hours and pile up WAL).

### Task D.1: Write the migration helper

**Files:**
- Create: `packages/db/scripts/migrate-hypertable-to-partitioned.ts`

The helper:
- Takes `--table <name> --partition-column <col> --interval month --start <YYYY-MM> --end <YYYY-MM>` flags.
- Reads min/max of the partition column from the existing hypertable to determine the historical range. Errors if the user-supplied range doesn't cover it.
- Generates monthly partition `CREATE TABLE` statements for the historical range + 12 months ahead.
- Copies data per-partition: `INSERT INTO new_partition SELECT * FROM legacy WHERE col >= ? AND col < ?` — one transaction per partition, not one for the whole copy.
- Verifies row counts match per partition. Errors loudly on mismatch — does NOT proceed to drop the legacy table.
- Logs progress in JSON to stdout for log shipping.

Tasks:
- [ ] Write the helper.
- [ ] Unit-style smoke test on a Timescale-seeded testcontainer with 30 days of synthetic data across 3 months. Assert: row count match, all queries against the new table return identical results to the legacy hypertable.

### Task D.2: Migration 0015 — partition `revenue_events`

**Files:**
- Create: `packages/db/drizzle/migrations/0015_partition_revenue_events.sql`

```sql
-- 0015_partition_revenue_events.sql
-- Pre-req: Phase 0 cutover gate passed. Phase C migration applied.
-- Pre-req: migrate-hypertable-to-partitioned.ts dry-run passed in staging.
-- The migration only does the rename + create + setup. The data copy
-- runs OUTSIDE the migration via the script (see runbook). The legacy
-- table drop is a SEPARATE follow-up migration after row-count verification.

BEGIN;

-- 1. Rename the existing hypertable. Drizzle migrator runs as a single tx;
--    the rename here is fine. Inserts continue to land on the renamed
--    table until the API is paused for the swap window.
ALTER TABLE revenue_events RENAME TO revenue_events_legacy_hypertable;

-- 2. Create the new partitioned parent. Schema MUST mirror the legacy
--    table exactly. The composite PK includes event_date (already true
--    for the hypertable's PK — see schema.ts:217 comment).
CREATE TABLE revenue_events (
  id              text NOT NULL,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subscriber_id   text REFERENCES subscribers(id) ON DELETE SET NULL,
  event_type      text NOT NULL,
  amount_micros   bigint NOT NULL,
  currency        text NOT NULL,
  event_date      timestamptz NOT NULL,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, event_date)
) PARTITION BY RANGE (event_date);

-- 3. Indexes mirrored on the parent — propagate to all partitions.
CREATE INDEX idx_revenue_events_project_date ON revenue_events (project_id, event_date DESC);
CREATE INDEX idx_revenue_events_subscriber ON revenue_events (subscriber_id) WHERE subscriber_id IS NOT NULL;

-- 4. Initial empty partitions covering the historical range.
--    The script will INSERT into these. Adjust the range per the legacy
--    table's actual min(event_date) — runbook captures this number.
-- (Generated by migrate-hypertable-to-partitioned.ts; commit the SQL it emits.)
-- Example for 2024-01 through 2027-04:
CREATE TABLE revenue_events_2024_01 PARTITION OF revenue_events
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
-- ... repeat per month ...

COMMIT;
```

After the migration: run `migrate-hypertable-to-partitioned.ts --table revenue_events --partition-column event_date ...` to copy the data. Verify row counts. THEN run a follow-up migration `0015a_drop_revenue_events_legacy.sql` (committed alongside this one but applied separately) that does `DROP TABLE revenue_events_legacy_hypertable;`.

Tasks:
- [ ] Write 0015 (rename + create + initial partitions).
- [ ] Write 0015a (legacy drop, applied AFTER copy verification — gated on a `PLAN3_LEGACY_DROP_VERIFIED=1` env var that the migrator checks).
- [ ] Update `schema.ts` for the new partitioned table — `pgTable("revenue_events", ...)` definition stays valid (Drizzle treats it as a normal table); composite PK comment updated to reflect declarative partitioning rationale instead of hypertable rationale.

### Task D.3: Migration 0016 — partition `credit_ledger`

Same shape as D.2, partition column `created_at`, same monthly intervals.

Tasks:
- [ ] Write 0016 + 0016a (legacy drop).
- [ ] Update `schema.ts`.

### Task D.4: Migration 0017 — partition `outgoing_webhooks`

Partition column `next_retry_at`. **Note:** the existing webhook-retention worker (90-day delete sweep) runs unchanged; pg_partman will NOT manage this table because the retention predicate is composite (status + age), not pure age.

Tasks:
- [ ] Write 0017 + 0017a (legacy drop).
- [ ] Update `schema.ts`.

### Task D.5: Update Drizzle foundation tests

**Files:**
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

Tasks:
- [ ] Replace `it("revenueEvents uses a composite (id, eventDate) primary key for hypertable partitioning", ...)` with `it("revenueEvents uses a composite (id, eventDate) primary key for declarative range partitioning", ...)`. Same assertion (composite PK), updated rationale.
- [ ] Same for `creditLedger`.
- [ ] Add: `it("revenue_events parent has child partitions covering the historical range", ...)` — queries `pg_inherits` to assert ≥ N child partitions exist after migration.

## Phase E — Drop TimescaleDB extension and policies

**Goal:** with all hypertables converted (Phase D legacy drops complete) and the cagg dropped (Phase C), the extension has nothing left to manage. Drop it.

### Task E.1: Migration 0018 — drop extension

**Files:**
- Create: `packages/db/drizzle/migrations/0018_drop_timescaledb_extension.sql`

```sql
-- 0018_drop_timescaledb_extension.sql
-- Pre-req: Phase C (0014) + Phase D (0015–0017 + legacy drops) applied.
-- After this migration, the database has no Timescale-specific objects.

-- Defensive removals — these should already be no-ops since the
-- hypertables and cagg are gone, but Timescale's metadata catalogs
-- may retain stale policy entries. CASCADE handles dependencies.
SELECT remove_compression_policy(hypertable, if_exists => true)
  FROM (VALUES ('revenue_events'), ('credit_ledger'), ('outgoing_webhooks')) AS h(hypertable);
SELECT remove_retention_policy(hypertable, if_exists => true)
  FROM (VALUES ('revenue_events'), ('credit_ledger'), ('outgoing_webhooks')) AS h(hypertable);

DROP EXTENSION IF EXISTS timescaledb CASCADE;
```

Tasks:
- [ ] Write the migration.
- [ ] Local: apply, then `\dx` shows no `timescaledb`. `\dt _timescaledb_catalog.*` errors with "schema does not exist".

### Task E.2: Update docker-compose for the migration window

The `timescaledb` extension is loaded via `shared_preload_libraries=timescaledb` in the Docker image's `postgresql.conf`. Even after the extension is dropped, the binary still tries to load the .so on startup. We must swap the image (Phase G) immediately after migration 0018; otherwise the next restart fails.

Document this dependency explicitly in the runbook: **migration 0018 + image swap is one atomic deploy unit**.

## Phase F — Install pg_partman, ship outbox-cleanup + partition-maintenance workers

### Task F.1: Migration 0019 — install pg_partman + configure parent tables

**Files:**
- Create: `packages/db/drizzle/migrations/0019_install_pg_partman.sql`

```sql
-- 0019_install_pg_partman.sql
-- Pre-req: Phase E (0018) applied. Phase G's image swap deployed
-- (postgres:16-bookworm with postgresql-16-partman apt-installed).

CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION pg_partman SCHEMA partman;

SELECT partman.create_parent(
  p_parent_table       => 'public.revenue_events',
  p_control            => 'event_date',
  p_type               => 'native',
  p_interval           => '1 month',
  p_premake            => 12,
  p_start_partition    => '2024-01-01'
);

UPDATE partman.part_config
SET retention                = '7 years',
    retention_keep_table     = false,
    retention_keep_index     = false,
    infinite_time_partitions = true
WHERE parent_table = 'public.revenue_events';

-- Same for credit_ledger.
SELECT partman.create_parent(
  p_parent_table       => 'public.credit_ledger',
  p_control            => 'created_at',
  p_type               => 'native',
  p_interval           => '1 month',
  p_premake            => 12,
  p_start_partition    => '2024-01-01'
);

UPDATE partman.part_config
SET retention                = '7 years',
    retention_keep_table     = false,
    retention_keep_index     = false,
    infinite_time_partitions = true
WHERE parent_table = 'public.credit_ledger';

-- outgoing_webhooks is NOT registered with pg_partman (90d retention runs
-- via the existing webhook-retention worker; predicate is composite).
-- Future partitions are created by the partition-maintenance worker (Task F.3).
```

Tasks:
- [ ] Write the migration.
- [ ] Verify: `SELECT * FROM partman.part_config` returns rows for both registered tables with `retention='7 years'`.

### Task F.2: Outbox cleanup worker

**Files:**
- Create: `apps/api/src/workers/outbox-cleanup.ts`
- Create: `apps/api/tests/outbox-cleanup.integration.test.ts`

The worker:
- BullMQ repeatable, runs every 1 hour.
- Deletes `outbox_events` rows where `published_at IS NOT NULL AND published_at < now() - interval '24 hours'`.
- Batched: `DELETE ... WHERE id IN (SELECT id ... LIMIT 10000)` in a loop. Logs per-batch counts.
- Stops the loop when a batch returns 0 rows.

Tasks:
- [ ] Write the worker.
- [ ] Wire it from `apps/api/src/index.ts` alongside the other workers.
- [ ] Integration test: seed 100 published rows older than 24h + 10 unpublished rows + 10 published-but-fresh rows. Run worker. Assert exactly 100 deleted, 20 remain.

### Task F.3: Partition maintenance worker

**Files:**
- Create: `apps/api/src/workers/partition-maintenance.ts`
- Create: `apps/api/tests/partition-maintenance.integration.test.ts`

The worker:
- BullMQ repeatable, runs daily at 03:00 UTC.
- Calls `SELECT partman.run_maintenance_proc()` — pg_partman's maintenance procedure that creates premake-window partitions and drops retention-aged partitions across all configured parents.
- Additionally: creates next-month partition for `outgoing_webhooks` (NOT pg_partman-managed) via direct SQL: `CREATE TABLE IF NOT EXISTS outgoing_webhooks_<YYYY_MM> PARTITION OF outgoing_webhooks FOR VALUES FROM (...) TO (...)`.
- Logs each created/dropped partition.

Tasks:
- [ ] Write the worker.
- [ ] Wire from `apps/api/src/index.ts`.
- [ ] Integration test:
  - Seed an 8-year-old row in `revenue_events`.
  - Run `partman.run_maintenance_proc()`.
  - Assert: the 8-year-old partition is dropped; the row is gone.
  - Assert: a partition for next month + 12 exists.
  - This test is the load-bearing VUK 7-year retention proof.

## Phase G — Cleanup + Docker image swap

### Task G.1: Custom Postgres Dockerfile

**Files:**
- Create: `deploy/postgres/Dockerfile`
- Create: `deploy/postgres/init.sql`

```dockerfile
# deploy/postgres/Dockerfile
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-partman \
 && rm -rf /var/lib/apt/lists/*

# pg_partman uses a background worker; preload it so partman.run_maintenance_proc()
# can be called via pg_cron later if desired (we ship our own BullMQ worker
# instead — see partition-maintenance.ts — so this is forward-compat only).
RUN echo "shared_preload_libraries='pg_partman_bgw'" >> /usr/share/postgresql/postgresql.conf.sample
```

```sql
-- deploy/postgres/init.sql — runs on container init via /docker-entrypoint-initdb.d/
-- pg_partman extension is created by migration 0019; this file is intentionally
-- minimal. It exists as a placeholder for future pre-migration setup.
SELECT 1;
```

### Task G.2: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

Tasks:
- [ ] Replace `image: timescale/timescaledb:2.17.2-pg16` with `build: ./deploy/postgres`.
- [ ] Drop any `command:` overrides that pass `-c shared_preload_libraries=timescaledb`.
- [ ] Confirm: `docker compose build db && docker compose up -d db && docker compose exec db psql -U postgres -c "\dx"` lists `pg_partman` only (after migration 0019).

### Task G.3: Delete verify-timescale.ts

**Files:**
- Delete: `packages/db/scripts/verify-timescale.ts`
- Modify: `packages/db/package.json` — drop the `db:verify:timescale` npm script.

Tasks:
- [ ] Delete the file + script entry.
- [ ] Grep-verify: `rg verify-timescale` returns zero hits.

### Task G.4: Update .env.example, CLAUDE.md, dashboard docs

**Files:**
- Modify: `.env.example` — drop `MRR_READ_SOURCE`, drop any Timescale-specific notes.
- Modify: `CLAUDE.md` — under "Database", drop `TimescaleDB` reference; under "Architecture Decisions", drop the cagg note. Update the `db` row in the docker-compose section.
- Modify: `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/04-timescaledb.md` — prepend a deprecation banner pointing to this plan and to the spec section that survives (none, but explicit).

### Task G.5: Update verify-clickhouse.ts

**Files:**
- Modify: `packages/db/scripts/verify-clickhouse.ts`

Tasks:
- [ ] Drop any cross-checks that compared CH MV row counts to Timescale's `daily_mrr` (the verify script may have grown those during Plan 2; if it did, they break the moment the cagg drops).
- [ ] Add a check: `outbox_backlog_warn_threshold` and `outbox_backlog_crit_threshold` still present (unchanged from Plan 2).

## Phase H — Verification

End-to-end smoke run on a fresh `docker compose up`:

- [ ] **H.1** Database: `docker compose exec db psql -U postgres -c "\dx"` lists `pg_partman` only — no `timescaledb`.
- [ ] **H.2** Database: `\d revenue_events` shows `Partition key: RANGE (event_date)` and a list of monthly child partitions.
- [ ] **H.3** Migrations: `pnpm --filter @rovenue/db db:migrate` applies cleanly from zero state. `pnpm --filter @rovenue/db db:verify:clickhouse` green.
- [ ] **H.4** Build: `pnpm build` and `pnpm typecheck` green workspace-wide.
- [ ] **H.5** Tests: `pnpm test` green. Spot-check no Timescale references in test output: `pnpm test 2>&1 | rg -i timescale` returns zero hits.
- [ ] **H.6** API smoke: `curl /dashboard/metrics/mrr` returns the same JSON shape as the pre-cutover snapshot (compare against the Plan 2 baseline).
- [ ] **H.7** API smoke: `curl /dashboard/subscribers/<id>/credit-history` returns paginated credit ledger entries from CH.
- [ ] **H.8** Worker smoke: outbox-cleanup logs at startup, partition-maintenance logs at startup, both register their BullMQ jobs.
- [ ] **H.9** Compliance smoke: run the partition-maintenance integration test against the real container; 8-year-old row is dropped.
- [ ] **H.10** PR body captures: pre/post Phase D row counts (per table), Phase 0 gate-pass timestamp, post-cutover dashboard MRR sample shape, post-cutover storage size delta.

## ADRs

### ADR 1: Postgres remains system of record (NOT ClickHouse)

ClickHouse is analytics-grade. `ReplacingMergeTree` dedup runs in background merges; `TTL ... DELETE` is silent. A VUK auditor asking "give me the row from 2024-Q3, projectId=X, eventId=Y" needs deterministic, transactional, immediate truth — Postgres delivers that, ClickHouse may still be merging. The outbox pattern itself requires Postgres as the durability anchor: the business row and the outbox row commit together. Removing Postgres is not on the table; what we remove is the *Timescale extension* on top of Postgres.

### ADR 2: Declarative range partitioning, monthly intervals

Native partitioning (production-ready since PG 11; we run 16) over hypertables. Monthly intervals balance:
- **Pruning efficiency** — a 12-month dashboard query touches 12 partitions; a single-day query touches 1.
- **Partition count manageability** — 7 years × 12 = 84 partitions per table at steady state. PG 16 handles tens of thousands of partitions, but query planning cost grows with partition count, so smaller is better.
- **Operational alignment** — monthly matches finance reporting cadence and the existing CH `mv_mrr_daily` aggregation period.

Quarterly was considered. Rejected: drop_chunks-equivalent (partition drop) granularity would be 90 days, and we'd retain too much data past the 7-year boundary if we wanted to avoid early drops.

### ADR 3: pg_partman for lifecycle ONLY, native partitioning for the data shape

We do NOT use pg_partman's `parent` abstraction layer or its template-table mechanism for schema. The data tables themselves use native `PARTITION BY RANGE`. `pg_partman` is invoked only to:
- Premake future partitions (12 months ahead).
- Drop partitions older than 7 years (`retention_keep_table=false`).

This split keeps our migration SQL readable (no partman-templated DDL) and reduces lock-in: if pg_partman ever becomes a problem, we replace its maintenance loop with our own, the data shape is unaffected.

### ADR 4: Drop the MRR_READ_SOURCE flag entirely

Once cut over, the flag is dead code. Keeping it as a knob "in case we need to flip back" creates a trap: someone in an incident flips it to `timescale`, but the Timescale path no longer exists — silent failure. Remove the option, remove the trap. If we ever need to re-introduce a read fallback, we'll do it deliberately, not with a vestigial flag.

### ADR 5: No compression replacement in this plan

Vanilla PG has no chunk-level compression. We accept the storage growth (~50GB/year on `revenue_events`, ~350GB at 7-year steady state — back-of-envelope, real numbers will be captured in Phase H.10's PR body). If we cross 200GB on a single node and storage becomes a real bottleneck, the next plan evaluates:
- `timescaledb-toolkit` (Apache 2.0, no TSL) — provides analytic functions, NOT chunk compression, but useful for the analytic query side.
- Cold-tier S3 partitions via `postgres_fdw` — partitioned foreign-data wrappers can route queries to S3-backed tables for old data.
- Re-introduce TimescaleDB Community for compression only, on a follow-up plan, if the trade-off changes.

This plan does not prematurely optimize; it removes a working dependency and accepts the storage trade-off. We come back if the math changes.

### ADR 6: 0015a / 0016a / 0017a "legacy drop" migrations are gated on env var

Phase D's data copy runs *between* the migration that creates the new partitioned table (0015) and the migration that drops the legacy hypertable (0015a). If 0015a runs before the copy is verified, we lose data. The migrator checks `PLAN3_LEGACY_DROP_VERIFIED=1` at apply time and refuses to run 0015a/0016a/0017a without it. The runbook documents the verification step as a literal command (`pnpm --filter @rovenue/db verify-row-counts --table revenue_events`) and a literal env-flip step. This is belt-and-suspenders for the irreversible window.

## Migration checklist (production)

This is irreversible past Phase D's legacy drops. Do it once, do it right.

1. **T-14d:** Confirm `MRR_READ_SOURCE=dual` in prod (already done end of Plan 2). Watch drift logs daily.
2. **T-7d:** All four Phase 0 gate conditions met. Document raw drift numbers in the Plan 3 PR body.
3. **T-3d:** Deploy Phases A + B (CH-only reads). At this point the dashboard reads exclusively from CH, but Timescale still receives writes. If CH falls over, the impact is dashboard reads — falls back to "data unavailable", NOT incorrect data.
4. **T-1d:** Stage Phase D dry-run on a copy of prod data (snapshot restore). Capture pre-migration row counts. Run the copy script. Verify post-migration counts match. Capture timing budget (extrapolate to prod data volume).
5. **T-0:** Maintenance window, 2-3 hours allocated. Sequence:
   - **API read-only mode.** Drop write traffic via the existing maintenance flag. Outbox dispatcher continues draining backlog.
   - **Apply migration 0014** (drop daily_mrr cagg). Brief read-path interruption — already on CH per step 3.
   - **Apply migrations 0015 / 0016 / 0017** (rename + create partitioned + initial empty partitions). All three in sequence, single tx each.
   - **Run migrate-hypertable-to-partitioned.ts** for each table, in row-count-ascending order (smallest first; if anything goes wrong, smaller blast radius). Verify row counts per table.
   - **Set `PLAN3_LEGACY_DROP_VERIFIED=1`. Apply 0015a / 0016a / 0017a** (drop legacy hypertables).
   - **Apply migration 0018** (drop TimescaleDB extension).
   - **Atomically deploy the new Postgres image** (`postgres:16-bookworm` + pg_partman). The container restart loads the new binary; no shared_preload_libraries=timescaledb in the new conf.
   - **Apply migration 0019** (install pg_partman, configure parents).
   - **Restart API.** Workers start; partition-maintenance runs its first cycle; outbox-cleanup runs its first cycle.
   - **Re-enable writes.** Outbox dispatcher catches up.
   - **Run smoke H.6 / H.7.** Compare against the pre-cutover snapshot.
6. **T+1d:** Phase G cleanup PR (delete verify-timescale.ts, drop env example entries, update CLAUDE.md). Independent PR — does not need a maintenance window.
7. **T+7d:** Capacity review. Disk usage delta on `revenue_events` and `credit_ledger`. If >2× the projection, raise the 200GB-per-node threshold conversation early.

**Rollback windows:**
- Phases A–C are reversible until D runs (re-deploy Plan 2's adapter from git history; flip flag back to `dual`).
- Phase D is reversible until 0015a/0016a/0017a run (the legacy hypertable still holds data; redirect inserts back).
- After 0015a, forward-only.

## Q&A — open questions for sign-off

These need explicit answers in the PR body before merge.

- **Q1 — Compression.** Vanilla PG storage growth ~10× over Timescale's compressed hypertables. Accepted, revisit at 200GB/node threshold? *Proposed: yes, accepted; revisit threshold logged in Phase H.10's PR body.*
- **Q2 — Outbox cleanup TTL.** 24-hour retention after `published_at`? Or longer for replay-after-incident headroom? *Proposed: 24h is enough — the outbox is fan-out, not a journal. Replays beyond 24h require a backfill from `revenue_events` / `credit_ledger`, not the outbox.*
- **Q3 — Phase D dry-run target.** Testcontainer (small, fast) AND staging copy of prod data (real, slow)? *Proposed: both. Testcontainer is mandatory pre-merge; staging is mandatory pre-T-0.*
- **Q4 — pg_partman install path.** `postgres:16-bookworm` + apt-installed `postgresql-16-partman`, OR build pg_partman from source on `postgres:16-alpine`? *Proposed: bookworm + apt. Alpine adds Dockerfile complexity (musl, no apt) for ~30MB image-size win; not worth it.*
- **Q5 — `MRR_READ_SOURCE=clickhouse` shipped before plan starts?** Currently the default is `timescale`. Phase 0 requires `dual`. Should we ship the `dual` flip on `main` BEFORE Phase A, so the gate observation can begin immediately on the next deploy? *Proposed: yes — file a separate one-line PR that flips the default to `dual` on `main`, merge it today; Plan 3 picks up after the 14d gate passes.*
- **Q6 — Phase D dispatcher behavior during the maintenance window.** The dispatcher is fire-and-forget; if writes are paused but it keeps running, it'll drain the outbox and idle. OK to leave running? *Proposed: yes, but document. The dispatcher is read-only against PG (claims rows, marks them published) — claiming under read-only mode requires write access; we'll either pause the dispatcher or set the read-only flag at the API level only, not the DB user level. Confirm with ops in the runbook draft.*
- **Q7 — pg_dump / pg_restore compatibility.** A `pg_dump` from the Timescale image won't restore cleanly into a vanilla PG image (it'll try to recreate the extension and the hypertable metadata). Is the backup strategy at the API logical-backup level (export per table) or the PG physical level? *Proposed: this plan does NOT migrate prod data via pg_dump/pg_restore — it does the conversion in-place via Phase D's copy-and-swap. Backups taken before T-0 are restored to a Timescale image if needed (rollback). Backups taken after T-0 are vanilla PG. Document the lineage break in the ops runbook.*

## Final-state baseline (target — to be verified by Phase H.10)

- **Docker compose:** `db: build: ./deploy/postgres` (custom image, postgres:16-bookworm + pg_partman) + `clickhouse:24.3-alpine` + `redpanda:v24.2.13` + `redpanda-console:v2.6.1` + `redis:7-alpine` + `api`.
- **Postgres extensions:** `pg_partman` only. No `timescaledb`. No catalog schemas under `_timescaledb_*`.
- **ClickHouse:** 8 migrations + 8 MVs unchanged from Plan 2.
- **Drizzle migrations:** 0001–0019 in `_journal.json`. Legacy migrations (0001 timescaledb, 0002–0004 hypertables, 0005 cagg, 0006–0007 policies) are present in journal but their effects are reversed by 0014–0019.
- **Drizzle schema:** composite PKs on `revenue_events` and `credit_ledger` include the partition-key column, comments updated to reflect declarative partitioning rationale; no hypertable mentions; `dailyMrr` view binding deleted.
- **API:** no `MRR_READ_SOURCE`, no `timescaleListDailyMrr`, no `dual` adapter logic. New workers `outbox-cleanup` and `partition-maintenance` registered in `index.ts`.
- **Tests:** Timescale fixtures removed; CH-only fixtures + 8-year retention test + per-partition row-count assertions added.
- **Docs:** `CLAUDE.md` reflects vanilla Postgres + ClickHouse split; spec `04-timescaledb.md` carries a deprecation banner pointing here.

End state: no Timescale binary in the image, no Timescale catalog in the database, no Timescale code path in the application. The mental model is single-axis: Postgres is OLTP, ClickHouse is analytics, the outbox is the bridge.
