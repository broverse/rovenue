# Per-Table Retention Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three bespoke retention workers with one registry-driven sweep whose window comes from the project's billing tier, and which can safely retire rows from partitioned, append-only and hash-chained tables.

**Architecture:** A code-level policy registry names every retainable table, the column that ages it, the tier field that sizes its window, a floor no project may go below, and one of three strategies: `DELETE_ROWS` (batched), `DROP_PARTITION` (audited, because the database cannot police it), `CHECKPOINT_TRUNCATE` (export a §9.3 proof bundle, store it, delete, then chain a checkpoint row). Per-project overrides may only shorten a window, never lengthen it.

**Tech Stack:** TypeScript strict, Hono, Drizzle, BullMQ, Postgres 16 + pg_partman, S3-protocol object storage, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-roadmap-9-gdpr-kvkk-design.md` (§9.2)

## Global Constraints

- TypeScript strict. Zod for any API input. Responses are `{ data: T }` or `{ error: { code, message } }`.
- No magic values: every window, batch size, floor and queue name is a named exported constant. The registry itself is structured data, not magic values.
- Postgres access through Drizzle repositories under `packages/db/src/drizzle/repositories`; raw `sql` only where genuinely necessary, and then with qualified column names (`"audit_logs"."createdAt"`) — a bare `${table.col}` renders unqualified and breaks correlated subqueries.
- Every new worker follows the house pattern of `apps/api/src/workers/leaderboard-scheduler.ts`: a `Deps` interface with a `defaultDeps` wiring the real implementations, a pure injectable entry point, per-item `try/catch` so one bad row cannot abort the sweep, and a `*SkippedTotal` counter labelled by reason.
- Self-confirming tests prove nothing. Every test is red-checked against the mutation it exists to catch, and the report says which test failed and with what message.
- Tests throttled and sequential: `nice -n 19 npx vitest run <paths> --maxWorkers=2`. Never the full suite. Integration tests use the ambient docker stack (Postgres 5433, Redis 6380, Redpanda 19092, ClickHouse 8124) via `apps/api/tests/setup.ts`.
- `pnpm --filter @rovenue/scripts typecheck` is ALREADY red on `rotate-encryption-key.ts`. Pre-existing; do not fix it, but do not add to it.

## Established facts — verified, not assumed

Measured against the running database and the shipped code on 2026-09-05. Do not re-derive them from intuition; if any turns out false, STOP and report it.

1. **Dropping a partition bypasses the `credit_ledger` append-only trigger completely.** Probed on a structural replica of `0081_credit_ledger_invariants.sql`: the trigger IS cloned onto every partition, a plain `DELETE` IS rejected (so the probe tested the real guard), and all four of `DROP TABLE partition`, `DETACH` + `DROP`, `TRUNCATE partition` and `TRUNCATE parent` removed rows with no error. Row triggers fire on row DML, not DDL. **Consequence: for `DROP_PARTITION` the audit entry is the only record the drop happened, so it must be written first and must not depend on the dropped rows.**
2. **`credit_ledger`, `revenue_events` and `outgoing_webhooks` are range-partitioned but NOT managed by pg_partman.** `partman.part_config` holds only `funnel_sessions`, `funnel_answers`, `integration_deliveries`. Nothing creates or drops partitions for the first three; their pre-created partitions run `2024_01` … `2028_12`. Migration 0019 would register the first two, but it sits in the TimescaleDB-era range the fresh-install runner marks applied without executing. **Consequence: do not assume partman retention exists for these tables, and do not enable it as a side effect.**
3. **`audit_logs` is NOT partitioned** — a plain table, zero partitions — so `CHECKPOINT_TRUNCATE` deletes rows; it does not drop partitions.
4. **No retention worker reads `billing_tier_limits` today.** `rovi-retention` uses `env.ROVI_MESSAGE_RETENTION_DAYS`, `webhook-retention` a hardcoded 90-day constant, `import-retention` `IMPORT_FILE_RETENTION_DAYS` from `@rovenue/shared`. `findByTierAndCycle` is that table's only reader anywhere. Tier-driven retention is entirely new wiring, not a refactor.
5. **Seeded tier windows** (`0100_seed_billing_tier_limits.sql`, `retention_days` / `audit_log_days`): free 30/7, indie 180/90, studio 365/365, enterprise 1825/1825.
6. **`withLedgerDeleteAuthorized(db, fn)`** is at `packages/db/src/drizzle/repositories/credit-ledger.ts:178`, with exactly one call site: `packages/db/src/drizzle/repositories/projects.ts:345`.
7. **`AuditAction` and `AuditResource` are fixed string-literal unions** in `apps/api/src/lib/audit.ts` (35-182, 184-213). The columns are plain `text`, so the union is the only enforcement point — a new action must be added there.
8. **Object storage fails closed by throwing with the missing variable names.** `apps/api/src/lib/asset-store.ts:85` `isStorageConfigured()`; `s3()` at :97 throws `"asset storage is not configured — set ..."`. `import-store.ts` is a deliberately SEPARATE bucket because the asset bucket grants anonymous `s3:GetObject`, which would make PII exports world-readable.

---

### Task 1: The policy registry and window resolution

**Files:**
- Create: `packages/shared/src/retention/policies.ts`
- Create: `packages/shared/src/retention/policies.test.ts`
- Modify: `packages/shared/package.json` (add the `./retention` subpath export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type RetentionStrategy = "DELETE_ROWS" | "DROP_PARTITION" | "CHECKPOINT_TRUNCATE";`
  - `export type RetentionTierField = "retentionDays" | "auditLogDays";`
  - `export interface RetentionPolicy { table: string; timestampColumn: string; strategy: RetentionStrategy; tierLimitField: RetentionTierField; minimumDays: number; terminalStatuses?: readonly string[]; }`
  - `terminalStatuses`, when present, names a `status` column's terminal values, and
    a `DELETE_ROWS` sweep may only expire rows whose status is one of them. A table
    whose rows have a lifecycle must not lose a row that is still deliverable merely
    because it is old. `import-retention` already models this with
    `TERMINAL_IMPORT_JOB_STATUSES` — read it and match the idea rather than
    inventing a second one.
  - `export const RETENTION_POLICIES: readonly RetentionPolicy[]`
  - `export function findRetentionPolicy(table: string): RetentionPolicy | undefined`
  - `export function resolveRetentionWindowDays(args: { policy: RetentionPolicy; tierDays: number; projectOverrideDays: number | null }): number`

**Why a code constant and not a table:** a policy names a physical table and the column that ages it. Those are facts about the schema, which changes with a migration. A database row describing a table that no longer exists is a silent no-op; a constant referencing one fails to compile.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/retention/policies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  RETENTION_POLICIES,
  findRetentionPolicy,
  resolveRetentionWindowDays,
  type RetentionPolicy,
} from "./policies";

const auditPolicy: RetentionPolicy = {
  table: "audit_logs",
  timestampColumn: "createdAt",
  strategy: "CHECKPOINT_TRUNCATE",
  tierLimitField: "auditLogDays",
  minimumDays: 30,
};

describe("resolveRetentionWindowDays", () => {
  it("uses the tier window when there is no override", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: null,
      }),
    ).toBe(365);
  });

  it("lets a project shorten its window", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: 90,
      }),
    ).toBe(90);
  });

  it("clamps an override that tries to exceed the tier", () => {
    // A longer window is a storage-cost and compliance decision the tier
    // already made. An override may only ever shorten.
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 180,
        projectOverrideDays: 3650,
      }),
    ).toBe(180);
  });

  it("clamps an override below the policy floor", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: 1,
      }),
    ).toBe(30);
  });

  it("raises a tier window that is itself below the floor", () => {
    // free tier's auditLogDays is 7, below the 30-day audit floor. The
    // floor wins: deleting a compliance record after a week is not a
    // retention policy anyone can defend.
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 7,
        projectOverrideDays: null,
      }),
    ).toBe(30);
  });
});

describe("RETENTION_POLICIES", () => {
  it("names each table exactly once", () => {
    const tables = RETENTION_POLICIES.map((p) => p.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("gives every policy a positive floor", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(policy.minimumDays).toBeGreaterThan(0);
    }
  });

  it("restricts the lifecycle tables to terminal statuses", () => {
    // outgoing_webhooks rows are still owed until they reach a terminal
    // state. A policy that expires them by age alone would delete
    // undelivered webhooks, so the registry must carry the restriction.
    const outgoing = findRetentionPolicy("outgoing_webhooks");
    expect(outgoing?.terminalStatuses?.length).toBeGreaterThan(0);
  });

  it("finds a policy by table and returns undefined for an unknown one", () => {
    expect(findRetentionPolicy("audit_logs")?.strategy).toBe(
      "CHECKPOINT_TRUNCATE",
    );
    expect(findRetentionPolicy("no_such_table")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/shared && nice -n 19 npx vitest run src/retention/policies.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/shared/src/retention/policies.ts`. The resolution rule, in one place:

```ts
export function resolveRetentionWindowDays(args: {
  policy: RetentionPolicy;
  tierDays: number;
  projectOverrideDays: number | null;
}): number {
  const requested = args.projectOverrideDays ?? args.tierDays;
  const clampedToTier = Math.min(requested, args.tierDays);
  return Math.max(args.policy.minimumDays, clampedToTier);
}
```

Then the registry — a row for every table the three retired workers covered plus the three the spec names, each with an honest floor:

```ts
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    table: "audit_logs",
    timestampColumn: "createdAt",
    strategy: "CHECKPOINT_TRUNCATE",
    tierLimitField: "auditLogDays",
    // Below a month, an audit trail cannot answer "what changed last
    // quarter", which is the question it exists to answer.
    minimumDays: 30,
  },
  {
    table: "credit_ledger",
    timestampColumn: "createdAt",
    strategy: "DROP_PARTITION",
    tierLimitField: "retentionDays",
    // A financial ledger. The floor is deliberately the longest here.
    minimumDays: 365,
  },
  {
    table: "revenue_events",
    timestampColumn: "eventDate",
    strategy: "DROP_PARTITION",
    tierLimitField: "retentionDays",
    minimumDays: 365,
  },
  {
    table: "outgoing_webhooks",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: 7,
    // Read the status enum off the schema and list only the terminal
    // values here. Nothing deletes this table's rows today and its
    // partitions are never dropped, so it grows without bound — but a
    // PENDING delivery that is merely old is still owed, and age alone
    // must not expire it.
    terminalStatuses: [/* fill from the schema */],
  },
  {
    table: "webhook_events",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: 7,
  },
  {
    table: "copilot_messages",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: 7,
  },
] as const;
```

`outgoing_webhooks` is `DELETE_ROWS`, not `DROP_PARTITION`, on purpose: `0017_partition_outgoing_webhooks.sql` documents that its retention predicate is composite (status AND age), so a whole partition is not uniformly expired. Copy that reasoning into a comment rather than restating the conclusion.

Add the subpath export to `packages/shared/package.json` beside the existing ones:

```json
    "./retention": {
      "types": "./src/retention/policies.ts",
      "default": "./src/retention/policies.ts"
    },
```

Before adding a barrel re-export, check what the barrel excludes and why — it deliberately omits `node:crypto` importers because they crash the dashboard's Vite bundle. This module imports nothing, so a barrel export is safe, but verify and match what neighbouring pure modules do.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd packages/shared && nice -n 19 npx vitest run src/retention/policies.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p packages/shared
```

Expected: PASS, clean.

- [ ] **Step 5: Commit**

Stage `packages/shared/src/retention` and `packages/shared/package.json`, message:

```
feat(retention): a policy registry and one window-resolution rule

An override may only shorten a window, never lengthen it, and a per-table
floor outranks both. The registry is a code constant because it names
physical tables, which change with a migration, not with a row.
```

---

### Task 2: Per-project overrides

**Files:**
- Create: migration via `pnpm db:migrate:generate` after editing the schema
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/src/drizzle/repositories/retention-overrides.ts`
- Create: `packages/db/src/drizzle/repositories/retention-overrides.integration.test.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts` (barrel)

**Interfaces:**
- Consumes: `RetentionPolicy` from `@rovenue/shared/retention`.
- Produces:
  - table `project_retention_overrides`, composite primary key `(projectId, tableName)`, `retentionDays integer NOT NULL`
  - `listRetentionOverrides(db, projectId): Promise<Map<string, number>>` — keyed by table name
  - `upsertRetentionOverride(db, args: { projectId: string; tableName: string; retentionDays: number }): Promise<void>`
  - `deleteRetentionOverride(db, projectId, tableName): Promise<void>`

**Migration constraints — read before generating:**

- Hand-add `CHECK ("retentionDays" > 0)` to the generated SQL. Zero or negative means "delete everything", which no override should express even transiently. The registry floor clamps at read time; the constraint states the intent at the one layer that cannot be bypassed.
- Run `pnpm db:migrate:generate` a SECOND time and confirm it reports "No schema changes, nothing to migrate" — that proves drizzle-kit will not clobber the hand-added CHECK on the next generate.
- Verify the journal entry's `when` is strictly greater than every prior entry. Drizzle applies only migrations with `folderMillis >` the database's `max(created_at)`, so a non-monotonic entry is silently skipped — and CI stays green because the fresh-install path ignores `when`. This has bitten this repository once already. Do not hand-edit the journal to fix ordering; regenerate.
- Verify the migration applies on an UPGRADE-path database, not only a fresh one: apply it, then confirm the table exists and `max(created_at)` advanced.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/repositories/retention-overrides.integration.test.ts`. Read `audit-logs.proof.integration.test.ts` in the same directory first and match how it obtains a handle, seeds a project and cleans up — it is this package's most recent integration test.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("retention overrides", () => {
  it("returns an empty map for a project with no overrides", async () => {
    // Not the same as "no row" — the caller merges this map with the
    // registry, so an empty map must be a valid, non-throwing answer.
  });

  it("round-trips an override keyed by table name", async () => {});

  it("upsert replaces rather than duplicating", async () => {
    // Write 90, then 30 for the same (projectId, tableName); assert one
    // row and the value 30. The composite primary key is what makes this
    // work, so a regression that dropped it shows up here.
  });

  it("scopes overrides to their project", async () => {
    // Two projects, one table name, different values. Reading project A
    // must never see project B's row — and the mirror matters as much as
    // the isolation: assert A sees exactly its own value.
  });

  it("rejects a non-positive window at the database", async () => {
    // Assert the insert REJECTS, and assert on the Postgres error code
    // rather than a message substring. Check lib/pg-errors.ts for an
    // existing check-violation helper before writing one.
  });
});
```

Fill each comment with real code.

- [ ] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/retention-overrides.integration.test.ts --maxWorkers=2
```

Expected: FAIL — relation does not exist.

- [ ] **Step 3: Implement the schema, migration and repository**

Follow the conventions of a neighbouring project-scoped table in `schema.ts`. Read the specific table you copy from: column naming is genuinely mixed per table here, so never generalise casing from a sample.

- [ ] **Step 4: Run it to verify it passes, and verify the migration on an upgrade path**

```bash
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/retention-overrides.integration.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p packages/db
```

Then the upgrade-path check above. Report exactly what you observed, including `max(created_at)` before and after.

- [ ] **Step 5: Commit**

Stage the schema, the migration directory and the repository, message:

```
feat(retention): per-project window overrides

Composite-keyed on (projectId, tableName) so an upsert cannot duplicate,
with a database CHECK stating that a window is always positive.
```

---

### Task 3: The sweep, and the DELETE_ROWS strategy

**Files:**
- Create: `apps/api/src/workers/retention-sweep.ts`
- Create: `apps/api/src/workers/retention-sweep.test.ts`
- Modify: `apps/api/src/lib/metrics.ts`

**Interfaces:**
- Consumes: `RETENTION_POLICIES`, `resolveRetentionWindowDays` (Task 1); `listRetentionOverrides` (Task 2); `findByTierAndCycle` (`packages/db/src/drizzle/repositories/billing-tier-limits.ts:13`).
- Produces:
  - `export interface RetentionDeps { ... }` and `export const defaultDeps: RetentionDeps`
  - `export async function runRetentionSweep(now: Date, deps?: RetentionDeps): Promise<RetentionSweepResult>`
  - `export const RETENTION_SWEEP_QUEUE_NAME = "rovenue-retention-sweep"`
  - `export const RETENTION_DELETE_BATCH_SIZE = 10_000`
  - `export const RETENTION_MAX_BATCHES = 1_000`
  - counters `retentionRowsReclaimedTotal`, `retentionSweepSkippedTotal`

Batch size and cap come from `deleteWebhookEventsOlderThan` (`packages/db/src/drizzle/repositories/webhook-events.ts:276`), which already batches exactly this way — read it and match rather than inventing a second batching idiom.

**Per-item isolation is mandatory.** The sweep iterates projects × policies. One project's failure must not abort the rest: wrap each unit in its own `try/catch`, increment `retentionSweepSkippedTotal` with a `reason` label, log with `projectId` and `table`. `closeDueSeasons` in `leaderboard-scheduler.ts` is the reference, and it exists because a sibling function lacking it aborted every remaining item on one bad row.

**This task implements ONLY `DELETE_ROWS`.** A `DROP_PARTITION` or `CHECKPOINT_TRUNCATE` policy must be skipped with `reason: "strategy-not-implemented"` and a counter increment — not silently ignored, and not half-implemented. Tasks 4 and 5 fill them in.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/retention-sweep.test.ts`, mocking every `RetentionDeps` field as `leaderboard-scheduler.test.ts` does:

```ts
describe("runRetentionSweep", () => {
  it("resolves the window from the project's tier and its override", async () => {
    // Assert the DELETE is asked for the resolved cutoff, computed from
    // the tier row and the override — not from a constant. Pin the
    // cutoff to a literal Date derived from a fixed `now`.
  });

  it("skips a policy whose strategy is not implemented yet", async () => {
    // Assert no delete is attempted for a DROP_PARTITION policy AND that
    // the skip counter increments with reason "strategy-not-implemented".
    // A silent skip is the failure mode this test exists to prevent.
  });

  it("continues to the next project when one project throws", async () => {
    // Three projects, the middle one's delete rejects. Assert the THIRD
    // project's delete still ran — the assertion that actually proves
    // isolation. Asserting only "no throw" would pass against a sweep
    // that stopped after the failure.
  });

  it("stops at the batch cap rather than looping forever", async () => {});

  it("only expires terminal rows for a policy with terminalStatuses", async () => {
    // Assert the delete is asked to restrict on status. Red-check it by
    // dropping the status restriction and watching this fail — without
    // that, an old-but-undelivered webhook is destroyed silently.
  });

  it("does nothing for a project whose tier row is missing", async () => {
    // Assert it skips with a reason rather than falling back to a
    // default window. Guessing a window for a project whose tier cannot
    // be read is how data gets deleted that should not be.
  });
});
```

Fill each comment with real code.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/workers/retention-sweep.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/workers/retention-sweep.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

- [ ] **Step 5: Commit**

Stage the worker, its test and `metrics.ts`, message:

```
feat(retention): registry-driven sweep with the DELETE_ROWS strategy

Window comes from the tier and the project's override, never a constant.
Unimplemented strategies skip loudly with a counter rather than silently.
```

---

### Task 4: The DROP_PARTITION strategy

**Files:**
- Modify: `apps/api/src/workers/retention-sweep.ts`
- Create: `apps/api/src/workers/retention-sweep.partitions.integration.test.ts`
- Modify: `apps/api/src/lib/audit.ts` (one new `AuditAction` literal)

**Interfaces:**
- Produces: `export const AUDIT_ACTION_RETENTION_PARTITION_DROPPED = "retention.partition_dropped"`, added to the `AuditAction` union.

**The rule this task exists to honour.** Established fact 1: a partition drop bypasses the `credit_ledger` append-only trigger entirely, on all four DDL paths. The database cannot police this, so:

1. **Write the audit row BEFORE the drop, and commit it independently.** If the process dies between the audit row and the drop, an audit row describing a drop that did not happen is recoverable — an operator re-runs and finds the partition already gone or still present. Dropping first leaves no record at all.
2. The audit row's `after` carries the partition name, the table, the resolved window, the cutoff, and the row count observed immediately before the drop. That count is the only surviving evidence of what was destroyed.
3. `userId` is `"system"`. `projectId` is required by `AuditEntry`, but retention is a global sweep rather than a project action — decide how to supply one, read how another cross-project worker does it before choosing, and record the choice in the report.
4. **Never `TRUNCATE`.** The probe showed `TRUNCATE` on the parent removes every row across every partition with no trigger and no error. Nothing in this codebase should truncate these tables.
5. **Do not register these tables with pg_partman** and do not set a `retention` in `part_config`. Established fact 2: they are deliberately unmanaged, and enabling partman retention would make partitions disappear on partman's schedule, outside this sweep and without the audit row above.

**Selecting a droppable partition.** A partition is droppable only when its entire upper bound is older than the cutoff — never when the cutoff falls inside it, which would destroy rows still inside the window. Read bounds from `pg_class.relpartbound` via `pg_get_expr`, and assert this boundary case.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/retention-sweep.partitions.integration.test.ts` against the ambient Postgres. Build a scratch partitioned table in the test rather than operating on `credit_ledger` itself — the assertions are about partition arithmetic and the audit row, and a test that drops real ledger partitions is one nobody can safely run twice.

```ts
describe("DROP_PARTITION strategy", () => {
  it("drops a partition whose whole range predates the cutoff", async () => {});

  it("leaves a partition alone when the cutoff falls INSIDE its range", async () => {
    // The boundary case. Dropping here destroys rows still inside the
    // retention window — the data loss the window exists to prevent.
    // This is the most important assertion in the file.
  });

  it("leaves a partition newer than the cutoff alone", async () => {});

  it("writes the audit row before the drop, carrying the row count", async () => {
    // Assert the audit row exists AND that its `after` carries the count
    // observed pre-drop. Once the partition is gone that count cannot be
    // recovered from anywhere else.
  });

  it("does not drop anything when the audit write fails", async () => {
    // Make the audit call reject; assert the partition still exists. The
    // ordering rule is only real if the drop is conditional on it.
  });
});
```

Fill each comment with real code.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/workers/retention-sweep.partitions.integration.test.ts --maxWorkers=2
```

Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/workers/retention-sweep.partitions.integration.test.ts src/workers/retention-sweep.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

- [ ] **Step 5: Commit**

Stage the worker, the new test and `audit.ts`, message:

```
feat(retention): audited partition drops

A partition drop bypasses credit_ledger's append-only trigger on every
DDL path — verified against a real database — so the audit row is the
only record that it happened. It is written first, and the drop does not
proceed without it.
```

---

### Task 5: CHECKPOINT_TRUNCATE for the audit chain

**Files:**
- Modify: `apps/api/src/workers/retention-sweep.ts`
- Create: `apps/api/src/services/audit-retention/checkpoint.ts`
- Create: `apps/api/src/services/audit-retention/checkpoint.integration.test.ts`
- Modify: `apps/api/src/lib/audit.ts` (one new `AuditAction` literal)

**Interfaces:**
- Consumes: `listAuditProofRows` (§9.3, `packages/db/src/drizzle/repositories/audit-logs.ts`), `AUDIT_CHAIN_FORMAT_V1` and `hashAuditRow` from `@rovenue/shared/audit-chain`, and the bundle assembly the proof endpoint performs — read `apps/api/src/routes/dashboard/audit-logs.ts` and reuse its assembly rather than writing a second one that can drift.
- Produces: `export const AUDIT_ACTION_RETENTION_CHECKPOINT = "retention.audit_checkpointed"` and `checkpointAndTruncate(...)`.

**The sequence, and why this order.** Deleting a hash-chained row makes every later row unverifiable back to origin, so the deleted segment must survive as an independently verifiable artifact BEFORE it stops existing:

1. Export the segment being deleted as a §9.3 proof bundle.
2. **Write the bundle to object storage and confirm the write succeeded.**
3. Delete the segment's rows, batched.
4. Write a checkpoint audit row whose `after` records the last deleted row's `rowHash` and the bundle's storage key.

The surviving chain then verifies as an ordinary mid-chain segment: its first row's `prevHash` is the last deleted row's `rowHash`, which the exported bundle's `tip` independently attests. No verifier change is required — confirm this by running `scripts/verify-audit-bundle.ts` over both the exported bundle and a fresh export of the surviving chain in the test.

**Fail closed when storage is unconfigured.** If `isStorageConfigured()` is false, this strategy SKIPS with a distinct reason and deletes nothing. Deleting audit history with nowhere to put the proof turns a compliance record into a hole — the exact failure §9.3 exists to prevent. Follow the fail-closed shape at `apps/api/src/services/apple/apple-verify.ts:196`: a named refusal, not a silent fallback.

**Which bucket.** NOT the asset bucket: `apps/api/src/lib/import-store.ts:16-34` documents that the asset bucket's MinIO policy grants anonymous `s3:GetObject` across the whole bucket, which would publish the audit trail to the internet. Decide between the import bucket and a new one, state the reasoning in the report, and if you add a bucket add its env var to `.env.example`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/audit-retention/checkpoint.integration.test.ts`:

```ts
describe("checkpointAndTruncate", () => {
  it("exports, stores, deletes, then chains a checkpoint — in that order", async () => {
    // Assert the storage write happened BEFORE any delete, by asserting
    // on call order, not just on both having happened.
  });

  it("leaves every row in place when storage is not configured", async () => {
    // The fail-closed case. Assert the skip reason AND that the row
    // count is unchanged.
  });

  it("leaves every row in place when the storage write rejects", async () => {});

  it("produces a bundle that verifies, and a surviving chain that verifies", async () => {
    // Run the real verifier over the exported bundle, then export the
    // surviving chain and verify that too. This is the assertion the
    // whole strategy exists to satisfy: retention must not cost
    // verifiability on either side of the cut.
  });

  it("records the last deleted rowHash and the bundle key in the checkpoint", async () => {});

  it("never deletes the checkpoint row it just wrote", async () => {
    // Run the sweep twice with the same cutoff. The second run must not
    // consume its own checkpoint — an off-by-one here erases the marker
    // that explains the gap.
  });
});
```

Fill each comment with real code.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/audit-retention/checkpoint.integration.test.ts --maxWorkers=2
```

Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/audit-retention/checkpoint.integration.test.ts --maxWorkers=2
cd apps/api && nice -n 19 npx vitest run tests/audit-chain.test.ts tests/audit-log.test.ts tests/audit-tx-rollback.test.ts tests/audit-integrations.test.ts --maxWorkers=2
cd scripts && nice -n 19 npx vitest run verify-audit-bundle.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

- [ ] **Step 5: Commit**

Stage the new service directory, the worker and `audit.ts`, message:

```
feat(retention): checkpoint-and-truncate the audit chain

The deleted segment is exported as a proof bundle and stored before it
stops existing, and a checkpoint row records its last hash and where the
bundle went. With storage unconfigured the strategy deletes nothing.
```

---

### Task 6: Retire the three old workers, wire the sweep, document

**Files:**
- Delete: `apps/api/src/workers/rovi-retention.ts`, `apps/api/src/workers/rovi-retention.test.ts`, `apps/api/src/workers/webhook-retention.ts`
- Modify: `apps/api/src/workers/import-retention.ts`
- Modify: `apps/api/src/index.ts`
- Create: a retention page under `apps/docs/content/docs/guides/`, and modify that directory's `meta.json`
- Modify: `ROADMAP.md`

**`import-retention` is NOT deleted, and that is the point of this task.** It does something the other two do not: it deletes object-storage files as well as rows, and uses a `filesDeletedAt` column so a re-run cannot re-select the same job. Folding storage deletion into the generic sweep would either lose that idempotency or push storage semantics into every policy. Keep the worker; convert only its *window* to come from the registry, and say so in a comment so a later reader does not "finish the job" by deleting it.

- [ ] **Step 1: Rewire boot**

Remove the deleted workers' `create*`/`schedule*` calls from `apps/api/src/index.ts` (around lines 163, 279 and 307 — verify current line numbers rather than trusting these) and register the sweep. Follow the newer `ensure*()` convenience-wrapper convention at `leaderboard-scheduler.ts:456` rather than the two-import shape the retention workers used.

- [ ] **Step 2: Prove nothing lost coverage**

The retired workers covered `copilot_messages` and `webhook_events`. Both are registry rows now. Add one test asserting the registry covers every table the retired workers touched — as a list, not a count, so adding an unrelated policy cannot make it pass.

```bash
cd apps/api && nice -n 19 npx vitest run src/workers/retention-sweep.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

- [ ] **Step 3: Document**

A page under `apps/docs/content/docs/guides/`, registered in that directory's `meta.json` `pages` array — a page missing from that array is unreachable with no error. Keep every brace inside a fenced code block; a bare double-brace in MDX prose breaks the static prerender. Cover: which tables have policies, how a window is resolved, that an override may only shorten, what a checkpoint row means when someone finds a gap in the audit chain, and where exported bundles go.

State plainly what this does NOT cover: ClickHouse. Analytics tables carry their own fixed `INTERVAL 2 YEAR` TTL, which is not tier-driven and is not touched here.

- [ ] **Step 4: Tick the ROADMAP checkbox**

`ROADMAP.md:769`, the second bullet under `## 9. GDPR / KVKK tooling`. Only that one. Do not claim coverage the tests do not have.

- [ ] **Step 5: Commit**

Stage the workers directory, `index.ts`, the docs page and `ROADMAP.md`, message:

```
feat(retention): retire the three bespoke workers

Their tables become registry rows. import-retention stays: it deletes
storage objects and tracks that with filesDeletedAt, which the generic
sweep deliberately does not model.
```

---
