# Alan 4 — TimescaleDB Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the three clean append-only time-series tables (`revenue_events`, `credit_ledger`, `outgoing_webhooks`) to TimescaleDB hypertables, build the `daily_mrr` continuous aggregate that the dashboard MRR endpoint already assumes exists, and attach compression + retention policies so disk growth stays bounded.

**Architecture:** Append new hand-written SQL migrations under `packages/db/drizzle/migrations/` — one per phase — and keep them referenced through `_journal.json` so `pnpm db:migrate` applies them in order. The Drizzle schema for these three tables changes from single-column `id` PK to composite `(id, partition_column)` PK because TimescaleDB requires the partition column in every UNIQUE/PRIMARY KEY on a hypertable. `daily_mrr` Drizzle view + `metricsRepo.listDailyMrr` + `/dashboard/projects/:projectId/metrics/mrr` route already exist in-tree against a view that does not yet exist in the database; this plan is what makes them actually work at runtime.

**Tech Stack:** TimescaleDB 2.17 (Apache 2 community features only — hypertables, continuous aggregates, compression, retention), Drizzle ORM 0.45, drizzle-kit 0.31, Vitest for schema-level smoke tests. No new dependencies.

**Scope note — what is intentionally NOT in this plan:**
- `webhook_events` hypertable. Spec §1.5 lists it, but its DB-level `UNIQUE(source, storeEventId)` is the idempotency key. TimescaleDB requires UNIQUE constraints to include the partition column, which breaks that invariant. Needs a separate design turn (drop DB unique + lean on the Redis replay guard from Alan 3, or switch the dedup key shape). Out of scope here.
- `experiment_assignments` hypertable. Same problem: `UNIQUE(experimentId, subscriberId)` is the sticky-assignment guarantee. Defer.
- `audit_logs` hypertable. `UNIQUE(rowHash)` is load-bearing for hash-chain integrity. Defer.
- Downtime-minimizing dual-write migration dance (spec §9.2). Rovenue is pre-launch with no production rows; `migrate_data => true` in `create_hypertable()` is fine.
- Backup strategy swap (spec §8.4). Orthogonal ops decision.
- Postgres tuning config (spec §8.3). Leave defaults; document in a follow-up operator note.

---

## Testing conventions

- Schema-level unit tests live in `packages/db/src/drizzle/drizzle-foundation.test.ts`. They import tables and assert column/PK shape without touching a real database — the pattern throughout rovenue's test suite is **hoisted mocks + no live DB**. Extend that file; do not invent a test container harness.
- Each migration in this plan is authored as **hand-written SQL** plus a **hand-appended entry** in `packages/db/drizzle/migrations/meta/_journal.json`. `drizzle-orm`'s migrator reads `_journal.json`, hashes the referenced `.sql`, and records it in `__drizzle_migrations`. That is the contract — tests below validate the shape after `pnpm db:migrate`.
- Runtime-level verification is one-shot: `pnpm --filter @rovenue/db db:migrate` against the local docker-compose database (which already uses `timescale/timescaledb:2.17.2-pg16`), then `psql` or `drizzle-kit studio` to inspect `timescaledb_information.*`. No automated integration test is added by this plan — the schema-level pins are the only CI signal.
- **Do NOT run `drizzle-kit generate`** in this plan. Every migration is hand-authored; running `generate` will try to emit duplicate DDL and corrupt `_journal.json`. All schema.ts changes in this plan are manual, and the migration SQL is manual too.

---

## File structure

### Create

- `packages/db/drizzle/migrations/0001_timescaledb_extension.sql` — `CREATE EXTENSION IF NOT EXISTS timescaledb;`
- `packages/db/drizzle/migrations/0002_hypertable_revenue_events.sql` — drop id PK, add composite `(id, eventDate)` PK, call `create_hypertable`
- `packages/db/drizzle/migrations/0003_hypertable_credit_ledger.sql` — same shape for `credit_ledger` on `createdAt`
- `packages/db/drizzle/migrations/0004_hypertable_outgoing_webhooks.sql` — same shape for `outgoing_webhooks` on `createdAt`
- `packages/db/drizzle/migrations/0005_cagg_daily_mrr.sql` — `CREATE MATERIALIZED VIEW daily_mrr WITH (timescaledb.continuous)` + refresh policy + manual backfill
- `packages/db/drizzle/migrations/0006_compression_policies.sql` — `ALTER TABLE ... SET (timescaledb.compress, ...)` + `add_compression_policy` for all three hypertables
- `packages/db/drizzle/migrations/0007_retention_policies.sql` — `add_retention_policy` for `outgoing_webhooks` only (7-year retention on revenue/credit is handled by omitting the policy)
- `packages/db/scripts/verify-timescale.ts` — standalone CLI that connects via `DATABASE_URL` and prints hypertable + cagg + policy state; used as a smoke check after `db:migrate`

### Modify

- `packages/db/drizzle/migrations/meta/_journal.json` — append one entry per new migration file
- `packages/db/src/drizzle/schema.ts` — three tables change from `id.primaryKey()` to composite `primaryKey({ columns: [t.id, t.<partitionCol>] })`; add `primaryKey` to the `drizzle-orm/pg-core` import
- `packages/db/src/drizzle/drizzle-foundation.test.ts` — pin the new composite PKs and the fact that `dailyMrr` columns stay stable
- `packages/db/package.json` — add `"db:verify:timescale": "tsx scripts/verify-timescale.ts"` script entry

---

## Reference: existing in-tree bindings this plan depends on

These already exist; the plan does not recreate them — but later tasks assume they compile. If they've drifted when you reach those tasks, stop and reconcile before continuing.

- `packages/db/src/drizzle/views.ts` — Drizzle `pgMaterializedView("daily_mrr", ...)` with columns `projectId`, `bucket`, `gross_usd`, `event_count`, `active_subscribers`. Migration 0005 must produce a cagg with exactly these column names and types.
- `packages/db/src/drizzle/sql-helpers.ts` — `timeBucket(interval, column)` helper used in the cagg definition below.
- `packages/db/src/drizzle/repositories/metrics.ts` — `listDailyMrr(db, {projectId, from, to})` already reads from the `dailyMrr` view. Migration 0005 makes that read work at runtime.
- `apps/api/src/routes/dashboard/metrics.ts` — `GET /mrr` endpoint already consumes the repo. Will 500 until 0005 is applied.

---

## Phase 0 — Pre-flight

### Task 0.1: Confirm the baseline suite is green and the local DB is TimescaleDB-capable

**Files:** none

- [ ] **Step 1: Run the db package tests to confirm the schema foundation compiles**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass. This is the smoke-test surface the plan will extend — a flaky baseline will hide regressions later.

- [ ] **Step 2: Start the docker-compose database**

Run: `docker compose up -d db`
Expected: the `db` service starts healthy. `docker compose ps db` should show `healthy`.

- [ ] **Step 3: Confirm the running image is the TimescaleDB distribution**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT version();"`
Expected: PostgreSQL 16.x on some Linux platform. The `timescale/timescaledb:2.17.2-pg16` image pre-installs the extension files; enabling them happens in Phase 1.

- [ ] **Step 4: Verify the TimescaleDB extension files are available but not yet enabled**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'timescaledb';"`
Expected: one row; `default_version` populated (e.g. `2.17.2`); `installed_version` is NULL. The extension is installed on disk but not yet registered in the rovenue database — Phase 1 enables it.

---

## Phase 1 — Enable the TimescaleDB extension

### Task 1.1: Write the extension-install migration

**Files:**
- Create: `packages/db/drizzle/migrations/0001_timescaledb_extension.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write this exact content to `packages/db/drizzle/migrations/0001_timescaledb_extension.sql`:

```sql
-- TimescaleDB extension registration.
-- The extension binaries ship with the timescale/timescaledb:2.17.2-pg16
-- image. This migration opts the rovenue database into the extension
-- so CREATE_HYPERTABLE and CREATE MATERIALIZED VIEW ... WITH
-- (timescaledb.continuous) work in the migrations that follow.
--
-- IF NOT EXISTS so reruns on the same database are no-ops.
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

- [ ] **Step 2: Append the journal entry**

Read `packages/db/drizzle/migrations/meta/_journal.json` and append a new entry after the `0000_flippant_ezekiel` entry so the `entries` array looks like this (the `when` field is a millisecond timestamp; generate a fresh one with `node -e "console.log(Date.now())"` and substitute below):

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1776797490680,
      "tag": "0000_flippant_ezekiel",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "7",
      "when": 1777000000000,
      "tag": "0001_timescaledb_extension",
      "breakpoints": true
    }
  ]
}
```

Replace the `1777000000000` placeholder with the output of `node -e "console.log(Date.now())"`.

- [ ] **Step 3: Apply the migration against the local database**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: drizzle-orm prints that it applied 1 migration, and exit code 0. The CLI hashes the `.sql` content and records it in `__drizzle_migrations`.

- [ ] **Step 4: Verify the extension is now registered**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';"`
Expected: exactly one row with `extname = timescaledb` and an `extversion` matching the image (e.g. `2.17.2`).

- [ ] **Step 5: Confirm the license path is the Apache-only build**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SHOW timescaledb.license;"`
Expected: `apache`. Rovenue is AGPLv3 and must not accidentally activate the TSL code path (spec T11).

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/migrations/0001_timescaledb_extension.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): register timescaledb extension"
```

---

## Phase 2 — Hypertable: `revenue_events`

### Task 2.1: Switch `revenue_events` to a composite primary key in the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (the `revenueEvents` table around lines 565-599)
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Update the schema.ts import list to include `primaryKey`**

Find the existing import block at the top of `packages/db/src/drizzle/schema.ts`:

```ts
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

Replace with:

```ts
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Change the `revenueEvents` table definition**

Find the `revenueEvents = pgTable("revenue_events", { ... })` block (currently starts around line 565). The `id` column has `.primaryKey()`. Remove that modifier and add a table-level `primaryKey` that pairs `id` with `eventDate`. The resulting block is:

```ts
export const revenueEvents = pgTable(
  "revenue_events",
  {
    // `.primaryKey()` removed — hypertable partition column must be in
    // the PK. The table-level primaryKey below declares (id, eventDate).
    id: text("id").notNull().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id),
    type: revenueEventType("type").notNull(),
    amount: decimal("amount", { precision: 12, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    amountUsd: decimal("amountUsd", { precision: 12, scale: 4 }).notNull(),
    store: store("store").notNull(),
    productId: text("productId")
      .notNull()
      .references(() => products.id),
    eventDate: timestamp("eventDate", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Hypertable partition column (eventDate) must appear in the PK.
    // The cuid2 id alone is still globally unique at the application
    // layer; no external table FKs into revenue_events, so losing the
    // single-column uniqueness at the DB level is safe.
    pk: primaryKey({ columns: [t.id, t.eventDate] }),
    projectIdEventDateIdx: index(
      "revenue_events_projectId_eventDate_idx",
    ).on(t.projectId, t.eventDate),
    subscriberIdTypeIdx: index(
      "revenue_events_subscriberId_type_idx",
    ).on(t.subscriberId, t.type),
  }),
);
```

- [ ] **Step 3: Pin the new PK shape in the drizzle-foundation test**

Open `packages/db/src/drizzle/drizzle-foundation.test.ts`. Find the `describe("schema shapes compile", () => { ... })` block and, inside it, add a new `it` at the end just before its closing `});`:

```ts
  it("revenueEvents uses a composite (id, eventDate) primary key for hypertable partitioning", () => {
    // The underlying DB constraint is a composite PK. Drizzle stores
    // that as an extra-config entry on the table; it is NOT reachable
    // via a public helper on the table object, so we assert the
    // column-level `.primary` flag is false on `id` (which would have
    // been true under the previous single-column PK definition).
    const idColumn = revenueEvents.id as unknown as { primary: boolean };
    expect(idColumn.primary).toBe(false);
    expect(revenueEvents.eventDate.name).toBe("eventDate");
  });
```

- [ ] **Step 4: Run the foundation tests**

Run: `pnpm --filter @rovenue/db test -- drizzle-foundation`
Expected: all tests pass, including the new PK shape assertion. If the test fails with `idColumn.primary === true`, the `.primaryKey()` removal in Step 2 didn't land — recheck.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db): composite PK on revenue_events for hypertable partitioning"
```

### Task 2.2: Write the `revenue_events` hypertable migration

**Files:**
- Create: `packages/db/drizzle/migrations/0002_hypertable_revenue_events.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0002_hypertable_revenue_events.sql`:

```sql
-- Convert revenue_events to a TimescaleDB hypertable partitioned by
-- eventDate. Partition column MUST be in every UNIQUE / PRIMARY KEY
-- on the table (TimescaleDB constraint), so we first rewrite the PK
-- from (id) to (id, eventDate).
--
-- cuid2 already guarantees global uniqueness at the application
-- layer; no other table references revenue_events.id via FK, so
-- dropping the single-column PK is safe.
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "revenue_events" DROP CONSTRAINT "revenue_events_pkey";
ALTER TABLE "revenue_events"
  ADD CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id", "eventDate");

-- 1-day chunks match the dashboard query pattern (daily MRR buckets)
-- and keep the chunk count bounded at ~365/year — well under the
-- max_locks_per_transaction ceiling (spec T7).
SELECT create_hypertable(
  '"revenue_events"',
  by_range('eventDate', INTERVAL '1 day'),
  migrate_data => true,
  if_not_exists => true
);
```

- [ ] **Step 2: Append the journal entry**

Append to `packages/db/drizzle/migrations/meta/_journal.json` entries array:

```json
    {
      "idx": 2,
      "version": "7",
      "when": 1777000000001,
      "tag": "0002_hypertable_revenue_events",
      "breakpoints": true
    }
```

Replace `1777000000001` with a fresh `node -e "console.log(Date.now())"` value, strictly greater than the 0001 entry's `when`.

- [ ] **Step 3: Apply against the local DB**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0, with a log line referencing the 0002 migration. If the local DB has pre-existing rows, they are migrated into chunks by `migrate_data => true`; on a fresh DB the table is converted empty.

- [ ] **Step 4: Verify the hypertable is registered**

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'revenue_events';"
```
Expected: one row with `hypertable_name = revenue_events`. `num_chunks` may be 0 on a fresh DB.

- [ ] **Step 5: Verify the Drizzle repo still reads successfully**

Run: `pnpm --filter @rovenue/db test`
Expected: green. The repo read path uses `.select().from(revenueEvents)` — no change needed now that PK is composite, since no query targets `WHERE id = ?` alone.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/migrations/0002_hypertable_revenue_events.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): convert revenue_events to timescaledb hypertable"
```

---

## Phase 3 — Hypertable: `credit_ledger`

### Task 3.1: Switch `credit_ledger` to a composite primary key in the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (the `creditLedger` table around lines 209-242)
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Change the `creditLedger` table definition**

Find the `creditLedger = pgTable("credit_ledger", { ... })` block. Remove `.primaryKey()` from `id` and add a table-level composite PK on `(id, createdAt)`:

```ts
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").notNull().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    type: creditLedgerType("type").notNull(),
    amount: integer("amount").notNull(),
    balance: integer("balance").notNull(),
    referenceType: text("referenceType"),
    referenceId: text("referenceId"),
    description: text("description"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // (id, createdAt) PK — createdAt is the partition column.
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
    subscriberIdCreatedAtIdx: index(
      "credit_ledger_subscriberId_createdAt_idx",
    ).on(t.subscriberId, t.createdAt),
    projectIdSubscriberIdIdx: index(
      "credit_ledger_projectId_subscriberId_idx",
    ).on(t.projectId, t.subscriberId),
  }),
);
```

- [ ] **Step 2: Pin the new PK shape**

In `packages/db/src/drizzle/drizzle-foundation.test.ts`, inside `describe("schema shapes compile", ...)`, append:

```ts
  it("creditLedger uses a composite (id, createdAt) primary key for hypertable partitioning", () => {
    const idColumn = creditLedger.id as unknown as { primary: boolean };
    expect(idColumn.primary).toBe(false);
    expect(creditLedger.createdAt.name).toBe("createdAt");
  });
```

- [ ] **Step 3: Run the foundation tests**

Run: `pnpm --filter @rovenue/db test -- drizzle-foundation`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db): composite PK on credit_ledger for hypertable partitioning"
```

### Task 3.2: Write the `credit_ledger` hypertable migration

**Files:**
- Create: `packages/db/drizzle/migrations/0003_hypertable_credit_ledger.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0003_hypertable_credit_ledger.sql`:

```sql
-- Convert credit_ledger to a TimescaleDB hypertable partitioned by
-- createdAt. Append-only by repository-layer convention — all code
-- paths in packages/db only INSERT; no UPDATE/DELETE. (Not enforced
-- by a DB trigger today; see Phase 9 docs cleanup + follow-up for
-- a BEFORE UPDATE/DELETE trigger if DB-level enforcement is wanted.)
-- Compressed-chunk modify cost is therefore zero in practice.
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_pkey";
ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id", "createdAt");

SELECT create_hypertable(
  '"credit_ledger"',
  by_range('createdAt', INTERVAL '1 day'),
  migrate_data => true,
  if_not_exists => true
);
```

- [ ] **Step 2: Append the journal entry**

Append to `packages/db/drizzle/migrations/meta/_journal.json`:

```json
    {
      "idx": 3,
      "version": "7",
      "when": 1777000000002,
      "tag": "0003_hypertable_credit_ledger",
      "breakpoints": true
    }
```

Use a fresh `Date.now()`.

- [ ] **Step 3: Apply and verify**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0.

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'credit_ledger';"`
Expected: one row.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0003_hypertable_credit_ledger.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): convert credit_ledger to timescaledb hypertable"
```

---

## Phase 4 — Hypertable: `outgoing_webhooks`

### Task 4.1: Switch `outgoing_webhooks` to a composite primary key in the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (the `outgoingWebhooks` table around lines 525-559)
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Change the `outgoingWebhooks` table definition**

Replace the existing `outgoingWebhooks = pgTable("outgoing_webhooks", { ... })` block with:

```ts
export const outgoingWebhooks = pgTable(
  "outgoing_webhooks",
  {
    id: text("id").notNull().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventType: text("eventType").notNull(),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId").references(() => purchases.id),
    payload: jsonb("payload").notNull(),
    url: text("url").notNull(),
    status: outgoingWebhookStatus("status").notNull().default("PENDING"),
    httpStatus: integer("httpStatus"),
    responseBody: text("responseBody"),
    lastErrorMessage: text("lastErrorMessage"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("nextRetryAt", { withTimezone: true }),
    sentAt: timestamp("sentAt", { withTimezone: true }),
    deadAt: timestamp("deadAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
    statusNextRetryAtIdx: index(
      "outgoing_webhooks_status_nextRetryAt_idx",
    ).on(t.status, t.nextRetryAt),
    projectIdStatusIdx: index(
      "outgoing_webhooks_projectId_status_idx",
    ).on(t.projectId, t.status),
  }),
);
```

- [ ] **Step 2: Pin the new PK shape**

In `packages/db/src/drizzle/drizzle-foundation.test.ts`, inside `describe("schema shapes compile", ...)`, append:

```ts
  it("outgoingWebhooks uses a composite (id, createdAt) primary key for hypertable partitioning", () => {
    const idColumn = outgoingWebhooks.id as unknown as { primary: boolean };
    expect(idColumn.primary).toBe(false);
    expect(outgoingWebhooks.createdAt.name).toBe("createdAt");
  });
```

- [ ] **Step 3: Run foundation tests**

Run: `pnpm --filter @rovenue/db test -- drizzle-foundation`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db): composite PK on outgoing_webhooks for hypertable partitioning"
```

### Task 4.2: Write the `outgoing_webhooks` hypertable migration

**Files:**
- Create: `packages/db/drizzle/migrations/0004_hypertable_outgoing_webhooks.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0004_hypertable_outgoing_webhooks.sql`:

```sql
-- Convert outgoing_webhooks to a TimescaleDB hypertable partitioned
-- by createdAt. Retry workers UPDATE `status`, `attempts`,
-- `nextRetryAt`, etc. on recent rows — hypertable supports those
-- updates on uncompressed chunks at zero cost, and compressed-chunk
-- updates (TimescaleDB 2.11+) are only triggered for old rows which
-- retry logic never touches (Alan 3 retry window << 30 days).
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "outgoing_webhooks" DROP CONSTRAINT "outgoing_webhooks_pkey";
ALTER TABLE "outgoing_webhooks"
  ADD CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id", "createdAt");

-- 6-hour chunks — smaller than revenue_events because retry queues
-- favour fine-grained chunk exclusion for "WHERE status = 'PENDING'
-- AND nextRetryAt <= now()" queries.
SELECT create_hypertable(
  '"outgoing_webhooks"',
  by_range('createdAt', INTERVAL '6 hours'),
  migrate_data => true,
  if_not_exists => true
);
```

- [ ] **Step 2: Append the journal entry**

Append to `packages/db/drizzle/migrations/meta/_journal.json`:

```json
    {
      "idx": 4,
      "version": "7",
      "when": 1777000000003,
      "tag": "0004_hypertable_outgoing_webhooks",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply and verify**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0.

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables ORDER BY hypertable_name;"`
Expected: three rows — `credit_ledger`, `outgoing_webhooks`, `revenue_events`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0004_hypertable_outgoing_webhooks.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): convert outgoing_webhooks to timescaledb hypertable"
```

---

## Phase 5 — Continuous aggregate: `daily_mrr`

### Task 5.1: Write the `daily_mrr` cagg migration

**Files:**
- Create: `packages/db/drizzle/migrations/0005_cagg_daily_mrr.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

Background: `packages/db/src/drizzle/views.ts` already declares `pgMaterializedView("daily_mrr", ...)` with columns `projectId`, `bucket`, `gross_usd`, `event_count`, `active_subscribers`. The metrics repo + dashboard endpoint already consume it. This migration is what makes those reads actually return data.

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0005_cagg_daily_mrr.sql`:

```sql
-- daily_mrr continuous aggregate over revenue_events.
-- Columns MUST stay in lockstep with packages/db/src/drizzle/views.ts:
--   projectId            text           project scope
--   bucket               timestamptz    day bucket (UTC)
--   gross_usd            numeric(12,4)  SUM(amountUsd)
--   event_count          bigint         COUNT(*)
--   active_subscribers   bigint         COUNT(DISTINCT subscriberId)
--
-- NB: drizzle-orm's node-postgres migrator wraps each .sql file in a
-- transaction. `CALL refresh_continuous_aggregate(...)` cannot run
-- inside a transaction block, so the one-shot historical backfill
-- happens in Step 4 below (outside the migration) — not here.

CREATE MATERIALIZED VIEW "daily_mrr"
WITH (timescaledb.continuous) AS
SELECT
  "projectId"                               AS "projectId",
  time_bucket(INTERVAL '1 day', "eventDate") AS "bucket",
  SUM("amountUsd")                           AS "gross_usd",
  COUNT(*)                                   AS "event_count",
  COUNT(DISTINCT "subscriberId")             AS "active_subscribers"
FROM "revenue_events"
GROUP BY "projectId", "bucket"
WITH NO DATA;

-- Real-time tail: recompute the last 7 days every 10 minutes, leaving
-- the current hour live (on-read aggregation fills the gap). Matches
-- the dashboard expectation documented in apps/api/src/routes/
-- dashboard/metrics.ts line 15 ("refreshed every ~10 minutes with a
-- 1-hour real-time tail").
SELECT add_continuous_aggregate_policy(
  'daily_mrr',
  start_offset => INTERVAL '7 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes'
);
```

- [ ] **Step 2: Append the journal entry**

Append to `packages/db/drizzle/migrations/meta/_journal.json`:

```json
    {
      "idx": 5,
      "version": "7",
      "when": 1777000000004,
      "tag": "0005_cagg_daily_mrr",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0. If this fails with `refresh_continuous_aggregate cannot run inside a transaction block`, the migration still contains the `CALL refresh_continuous_aggregate(...)` line that was removed in Step 1 — remove it and re-run.

- [ ] **Step 4: Backfill existing history into the aggregate (outside any transaction)**

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "CALL refresh_continuous_aggregate('daily_mrr', NULL, NULL);"
```
Expected: no output, exit 0. This one-shot catches up any `revenue_events` rows that existed before the migration ran — the scheduled policy only refreshes the trailing 7-day window, so without this call historical rows stay invisible until the first batch job runs over them.

On a fresh local DB with no rows, this call is a no-op but still necessary as the idempotent default. In production, run it once after applying migration 0005 and never again — the scheduled policy owns refresh from that point on.

- [ ] **Step 5: Verify the cagg exists with the right columns**

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT view_name, materialization_hypertable_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'daily_mrr';"
```
Expected: one row with `view_name = daily_mrr`.

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "\d daily_mrr"
```
Expected: columns `projectId`, `bucket`, `gross_usd`, `event_count`, `active_subscribers`. If any column name differs from `views.ts`, the Drizzle read path will blow up at runtime — fix the migration to match.

- [ ] **Step 6: Verify the refresh policy is registered**

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT proc_name, hypertable_name FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate';"
```
Expected: one row. The `hypertable_name` column reports the internal materialisation hypertable (something like `_materialized_hypertable_2`), NOT `daily_mrr` — that is expected. The important signal is that exactly one row comes back.

- [ ] **Step 7: Run the db test suite to confirm Drizzle's view binding still matches**

Run: `pnpm --filter @rovenue/db test -- drizzle-foundation`
Expected: the existing `describe("dailyMrr view", ...)` block still passes — column names pinned at lines 323-327 of that file have not changed.

- [ ] **Step 8: Smoke-test the dashboard endpoint against the live DB**

If the API is running (`pnpm dev`), hit the MRR endpoint through curl or the dashboard; otherwise skip this step. The goal is to confirm that `GET /dashboard/projects/:projectId/metrics/mrr` returns `{ data: { points: [...] } }` without a 500. If the local DB has no revenue_events rows seeded, `points` will be empty `[]` — that is the correct shape.

- [ ] **Step 9: Commit**

```bash
git add packages/db/drizzle/migrations/0005_cagg_daily_mrr.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): add daily_mrr continuous aggregate"
```

---

## Phase 6 — Compression policies

### Task 6.1: Write the compression-policy migration

**Files:**
- Create: `packages/db/drizzle/migrations/0006_compression_policies.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0006_compression_policies.sql`:

```sql
-- Compression settings + policies for the three hypertables.
--
-- segment_by choice: projectId for all three. It has the right
-- cardinality (tens to hundreds in a multi-tenant deployment — sweet
-- spot per spec §5.3) and lines up with the dominant query filter
-- ("WHERE projectId = $1"), so compressed-chunk reads prune to one
-- segment and decompress only what they need.
--
-- order_by is time DESC because reads almost always want the newest
-- rows first (dashboard time-series charts, webhook retry lookups).

-- revenue_events
ALTER TABLE "revenue_events" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"eventDate" DESC'
);
-- Chunks older than 30 days get compressed on the nightly policy run.
SELECT add_compression_policy('revenue_events', INTERVAL '30 days');

-- credit_ledger
ALTER TABLE "credit_ledger" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);
SELECT add_compression_policy('credit_ledger', INTERVAL '30 days');

-- outgoing_webhooks
-- Retry logic is bounded to a few hours after createdAt (Alan 3
-- backoff), so compressing anything older than 7 days is safe — the
-- row is either delivered, DEAD, or DISMISSED, and any follow-up
-- analytics tolerates the decompress cost.
ALTER TABLE "outgoing_webhooks" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = '"projectId"',
  timescaledb.compress_orderby = '"createdAt" DESC'
);
SELECT add_compression_policy('outgoing_webhooks', INTERVAL '7 days');
```

- [ ] **Step 2: Append the journal entry**

Append to `_journal.json`:

```json
    {
      "idx": 6,
      "version": "7",
      "when": 1777000000005,
      "tag": "0006_compression_policies",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply and verify**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0.

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name, attname, segmentby_column_index, orderby_column_index, orderby_asc FROM timescaledb_information.compression_settings ORDER BY hypertable_name, attname;"
```
Expected: six rows (one per attribute per table): three with `segmentby_column_index = 1` on `"projectId"`, three with `orderby_column_index = 1` + `orderby_asc = f` on the partition column of each table.

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name, config FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression' ORDER BY hypertable_name;"
```
Expected: three rows.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0006_compression_policies.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): add compression policies to hypertables"
```

---

## Phase 7 — Retention policies

### Task 7.1: Write the retention-policy migration

**Files:**
- Create: `packages/db/drizzle/migrations/0007_retention_policies.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

Per spec §6.1:
- `revenue_events` and `credit_ledger` → **no retention policy** (7-year VUK financial retention handled by the absence of a policy; operator will add one via a future migration if they want 7y+ cutoff).
- `outgoing_webhooks` → 90-day retention. DLQ + retry history beyond that is noise.

- [ ] **Step 1: Create the migration SQL**

Write to `packages/db/drizzle/migrations/0007_retention_policies.sql`:

```sql
-- Retention policies. Dropped chunks go away instantly (DROP CHUNK,
-- not DELETE) so there is no vacuum overhead — spec §1.3.
--
-- revenue_events and credit_ledger deliberately have NO retention
-- policy: financial records must survive 7+ years for tax/audit
-- (Turkish VUK minimum is 5 years). Operators who want a hard cutoff
-- add a policy later via an explicit migration.

SELECT add_retention_policy('outgoing_webhooks', INTERVAL '90 days');
```

- [ ] **Step 2: Append the journal entry**

Append to `_journal.json`:

```json
    {
      "idx": 7,
      "version": "7",
      "when": 1777000000006,
      "tag": "0007_retention_policies",
      "breakpoints": true
    }
```

- [ ] **Step 3: Apply and verify**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: exit 0.

Run:
```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT hypertable_name, config FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention';"
```
Expected: one row for `outgoing_webhooks`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0007_retention_policies.sql packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): add retention policy to outgoing_webhooks"
```

---

## Phase 8 — Verification script

### Task 8.1: Write the post-migration verification CLI

**Files:**
- Create: `packages/db/scripts/verify-timescale.ts`
- Modify: `packages/db/package.json` (add a new script entry)

- [ ] **Step 1: Confirm the scripts directory does not yet exist**

Run: `ls /Volumes/Development/rovenue/packages/db/scripts 2>/dev/null || echo "missing"`
Expected: either an empty listing or the literal string `missing`. If a `scripts/` directory already contains files, create this one alongside them without clobbering.

- [ ] **Step 2: Create the verification script**

Write to `packages/db/scripts/verify-timescale.ts`:

```ts
#!/usr/bin/env tsx
import { getPool } from "../src/drizzle/pool";

// =============================================================
// TimescaleDB post-migration verifier
// =============================================================
//
// Prints the live state of the hypertables, continuous aggregates,
// and policies so an operator can confirm that `pnpm db:migrate`
// landed TimescaleDB features correctly. Non-zero exit if any
// expected object is missing.
//
//   pnpm --filter @rovenue/db db:verify:timescale

interface Hypertable {
  hypertable_name: string;
  num_chunks: number;
  compression_enabled: boolean;
}

interface Cagg {
  view_name: string;
}

interface Policy {
  proc_name: string;
  hypertable_name: string | null;
  view_name: string | null;
}

const EXPECTED_HYPERTABLES = [
  "credit_ledger",
  "outgoing_webhooks",
  "revenue_events",
];

const EXPECTED_CAGGS = ["daily_mrr"];

const EXPECTED_COMPRESSION_POLICIES = [
  "credit_ledger",
  "outgoing_webhooks",
  "revenue_events",
];

const EXPECTED_RETENTION_POLICIES = ["outgoing_webhooks"];

const EXPECTED_REFRESH_POLICIES = ["daily_mrr"];

async function main(): Promise<void> {
  const pool = getPool();
  const problems: string[] = [];

  try {
    const hypertables = (
      await pool.query<Hypertable>(
        `SELECT hypertable_name, num_chunks, compression_enabled
         FROM timescaledb_information.hypertables
         ORDER BY hypertable_name`,
      )
    ).rows;
    console.log("Hypertables:");
    for (const h of hypertables) {
      console.log(
        `  ${h.hypertable_name}  chunks=${h.num_chunks}  compression=${h.compression_enabled}`,
      );
    }
    const actualHt = new Set(hypertables.map((h) => h.hypertable_name));
    for (const name of EXPECTED_HYPERTABLES) {
      if (!actualHt.has(name)) problems.push(`missing hypertable: ${name}`);
    }

    const caggs = (
      await pool.query<Cagg>(
        `SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY view_name`,
      )
    ).rows;
    console.log("\nContinuous aggregates:");
    for (const c of caggs) console.log(`  ${c.view_name}`);
    const actualCagg = new Set(caggs.map((c) => c.view_name));
    for (const name of EXPECTED_CAGGS) {
      if (!actualCagg.has(name)) problems.push(`missing cagg: ${name}`);
    }

    const policies = (
      await pool.query<Policy>(
        `SELECT proc_name,
                (config ->> 'hypertable_id')::int AS _ignore_hid,
                hypertable_name,
                (config ->> 'mat_hypertable_id') AS _ignore_mh,
                NULL::text AS view_name
         FROM timescaledb_information.jobs
         WHERE proc_name IN (
           'policy_compression',
           'policy_retention',
           'policy_refresh_continuous_aggregate'
         )
         ORDER BY proc_name, hypertable_name`,
      )
    ).rows;

    // policy_refresh_continuous_aggregate rows report the cagg name
    // via `hypertable_name` in 2.17 (the cagg's materialisation
    // hypertable). Print the raw rows so the operator can eyeball.
    console.log("\nPolicies:");
    for (const p of policies) {
      console.log(`  ${p.proc_name}  on  ${p.hypertable_name ?? "(null)"}`);
    }

    const compressionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_compression")
        .map((p) => p.hypertable_name ?? ""),
    );
    for (const name of EXPECTED_COMPRESSION_POLICIES) {
      if (!compressionTargets.has(name))
        problems.push(`missing compression policy: ${name}`);
    }

    const retentionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_retention")
        .map((p) => p.hypertable_name ?? ""),
    );
    for (const name of EXPECTED_RETENTION_POLICIES) {
      if (!retentionTargets.has(name))
        problems.push(`missing retention policy: ${name}`);
    }

    // Refresh-policy rows reference the materialisation hypertable
    // (internal name like `_materialized_hypertable_NN`), not the
    // public cagg name. Count rows per proc as the existence check.
    const refreshCount = policies.filter(
      (p) => p.proc_name === "policy_refresh_continuous_aggregate",
    ).length;
    if (refreshCount < EXPECTED_REFRESH_POLICIES.length) {
      problems.push(
        `expected >= ${EXPECTED_REFRESH_POLICIES.length} refresh policies, found ${refreshCount}`,
      );
    }

    if (problems.length) {
      console.error("\nFAIL:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    console.log("\nOK — TimescaleDB state matches expectations.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("verify-timescale failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Register the script in `package.json`**

Open `packages/db/package.json`. Find the `"scripts"` block:

```json
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "db:migrate": "tsx src/migrate.ts",
    "db:migrate:baseline": "tsx src/migrate-baseline.ts",
    "db:migrate:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio",
    "seed": "tsx seed.ts"
  },
```

Add a `"db:verify:timescale"` entry:

```json
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "db:migrate": "tsx src/migrate.ts",
    "db:migrate:baseline": "tsx src/migrate-baseline.ts",
    "db:migrate:generate": "drizzle-kit generate",
    "db:verify:timescale": "tsx scripts/verify-timescale.ts",
    "db:studio": "drizzle-kit studio",
    "seed": "tsx seed.ts"
  },
```

- [ ] **Step 4: Run the verifier against the migrated local database**

Run: `pnpm --filter @rovenue/db db:verify:timescale`
Expected: the script prints `Hypertables:`, `Continuous aggregates:`, `Policies:`, and ends with `OK — TimescaleDB state matches expectations.` Exit code 0.

If any `missing ...` error fires, go back to the phase that created that object — the migration did not apply. Re-run `pnpm --filter @rovenue/db db:migrate` after checking the journal entry is well-formed.

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/verify-timescale.ts packages/db/package.json
git commit -m "chore(db): add verify-timescale CLI for post-migration smoke check"
```

---

## Phase 9 — Final baseline pass

### Task 9.1: Run the whole suite end-to-end

**Files:** none

- [ ] **Step 1: Reset local DB to a clean state and re-run every migration from scratch**

If your local DB has test rows that you want to preserve, skip this step. Otherwise, run a clean replay to confirm the migration chain is idempotent from empty:

```bash
docker compose down db
docker volume rm rovenue_rovenue-data || true
docker compose up -d db
# Wait for healthy
until docker compose ps db | grep -q healthy; do sleep 2; done
pnpm --filter @rovenue/db db:migrate
docker compose exec db psql -U rovenue -d rovenue -c "CALL refresh_continuous_aggregate('daily_mrr', NULL, NULL);"
pnpm --filter @rovenue/db db:verify:timescale
```

Expected: every migration applies, the cagg backfill call succeeds (no-op on an empty DB), and the verifier prints `OK`.

- [ ] **Step 2: Run the full workspace test suite**

Run: `pnpm test`
Expected: all packages' Vitest suites pass. The db-foundation tests now include three new composite-PK assertions; the existing `dailyMrr` column assertions still hold.

- [ ] **Step 3: Document the migration chain in the spec's "completed" markers**

Open `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/04-timescaledb.md`. Skim it. If the team's convention for this repo is to inline a `✅ <date>` marker next to completed bullets (c.f. the Alan 3 commit `56b5212 docs(spec): mark Alan 3 completed items`), add markers next to:
- §1.5 "Karar" → "Evet, TimescaleDB'ye geç; ama seçici. Tüm tabloları değil, yalnızca: revenue_events, credit_ledger, outgoing_webhooks" with a note that `webhook_events`, `experiment_assignments`, and `audit_logs` are deferred.
- §3 "Hypertable seçimleri" → mark the three done.
- §4 "Continuous aggregates" → mark `daily_mrr` done.
- §5 "Compression" + §6 "Retention" → mark done.

Do not invent a new marker convention — if the spec has no `✅` patterns yet, skip this step.

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/specs/2026-04-20-tech-stack-upgrade/04-timescaledb.md
git commit -m "docs(spec): mark Alan 4 completed items"
```

(Skip if Step 3 didn't change the file.)

---

## Deferred follow-ups (out of scope for this plan)

Create a follow-up plan for each when rovenue is ready. Each needs its own design turn because of a unique-constraint issue not resolvable by adding the partition column.

- **`webhook_events` hypertable.** The `UNIQUE(source, storeEventId)` idempotency key cannot grow a `createdAt` column without breaking dedup. Options: (a) drop DB unique and rely on the Alan-3 Redis replay guard, (b) derive a deterministic `storeEventDate` from `storeEventId` and include it in the unique + partition key. Requires a call.
- **`experiment_assignments` hypertable.** `UNIQUE(experimentId, subscriberId)` is the sticky-assignment guarantee — same shape problem as `webhook_events`. Likely resolved by moving assignment uniqueness into an application-level lock table.
- **`audit_logs` hypertable.** `UNIQUE(rowHash)` is load-bearing for hash-chain integrity checks. Options: (a) change the constraint to a partial unique index that only covers "recent" chunks, (b) drop DB uniqueness and rely on audit-log verification passes to detect duplicates. Requires a SOC 2 posture decision.
- **Postgres tuning config** (spec §8.3). `shared_buffers`, `work_mem`, `timescaledb.max_background_workers` should land once ops know the target VPS shape.
- **Backup strategy upgrade** (spec §8.4). `pgBackRest` + WAL archive to S3-compatible storage when disk usage exceeds ~50 GB.
- **Policy-call idempotency pattern.** Migrations 0005/0006/0007 call `add_continuous_aggregate_policy` / `add_compression_policy` / `add_retention_policy` without `if_not_exists => true`. `create_hypertable` calls do use it. A replay against a DB where the policy already exists will fail at these lines. Future policy-shipping migrations should pass `if_not_exists => true`; retroactive fix requires a rebuild-from-empty volume, which isn't worth the churn.
