import { sql } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import {
  RETENTION_POLICIES,
  resolveRetentionWindowDays,
  type RetentionPolicy,
} from "@rovenue/shared/retention";
import { audit, AUDIT_ACTION_RETENTION_PARTITION_DROPPED } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  retentionRowsReclaimedTotal,
  retentionSweepBatchCapReachedTotal,
  retentionSweepSkippedTotal,
} from "../lib/metrics";

// =============================================================
// Retention sweep (ROADMAP §9.2 Task 3)
// =============================================================
//
// Rovenue used to have three bespoke retention workers, each with its
// own hardcoded or env-driven window, none of which consulted the
// project's billing tier. This sweep is the registry-driven
// replacement: it walks every project × every policy in
// `RETENTION_POLICIES` (@rovenue/shared/retention) and, for each unit,
// resolves how many days of history that project keeps for that
// table, then reclaims whatever has aged out — scoped to THAT project
// alone (see `deleteRetentionRows` / packages/db's `retention-rows.ts`:
// a global, unscoped delete would mean one project's resolved window,
// however short, destroys every project's rows in that table).
//
// Task 3 implemented ONLY the `DELETE_ROWS` strategy. Task 4 (this
// one) fills in `DROP_PARTITION` for `credit_ledger` and
// `revenue_events`. `CHECKPOINT_TRUNCATE` (`audit_logs`) is still
// skipped loudly (a counted skip, not a silent no-op) — Task 5 fills
// that in.
//
// --- DROP_PARTITION: why it cannot reuse the per-project loop below ---
//
// `DELETE_ROWS` scopes every delete to one project, so a project's own
// resolved window only ever affects that project's rows. A partition
// is physically shared by every project's rows for that month — there
// is no way to drop `credit_ledger_2024_03` for one tenant only. So a
// per-project window cannot, by itself, authorise dropping it: dropping
// on project A's (however correctly resolved) window would destroy
// project B's still-in-window rows the moment they happen to share
// that partition, INCLUDING a project the window-resolution rules
// deliberately protect by skipping ("no-window" — rule 3 above exists
// specifically so absence of configuration never reads as permission to
// delete).
//
// The rule this sweep applies instead: a `DROP_PARTITION` policy's
// partitions are only ever dropped using the LONGEST (most
// conservative) window any project resolved for that table this run,
// and only when EVERY project resolved *some* window. `overrides` can
// only ever shorten a tier's window, never lengthen it
// (resolveRetentionWindowDays), so the one project asking to keep the
// most history is the one whose requirement legitimately bounds what
// the whole shared table may lose — and any project this sweep could
// not resolve a window for (no tier, no override, or a missing
// billing_tier_limits row) blocks the drop entirely for this run,
// because "unresolved" must never be read as "doesn't care." The
// per-project loop below still resolves each project's window per
// policy (exactly as it does for DELETE_ROWS); for a DROP_PARTITION
// policy that resolution feeds `partitionDropAggregates` instead of an
// immediate delete, and the actual DROP TABLE happens once per
// partition, after every project has been considered, in the block
// that follows the loop. The audit trail is NOT similarly collapsed to
// one row, though: a partition drop affects every project sharing it,
// so `dropTablePartitionsOlderThan` writes one audit row into EACH
// affected project's own chain before that single drop — see
// `PartitionDropAuditContext` for why a single global row was
// rejected (it would sit outside every project's chain, invisible to
// `verifyAuditChain` and the §9.3 proof export — the exact tamper-
// evidence this row exists to provide).
//
// --- Window resolution: three rules, because a project's billing
// tier is optional ---
//
// `tier`/`cycle` live on `billing_subscriptions`, not on `projects`,
// and billing is cloud-only (`HOST_MODE` defaults to "self"). On the
// development database that's 34 billing rows against 407 projects,
// so a tier-driven-only sweep would be inert for roughly nine projects
// in ten, and for every self-hosted deployment by construction.
//
//   1. A project WITH a billing subscription AND a matching
//      `billing_tier_limits` row resolves normally via
//      `resolveRetentionWindowDays`: tier window, override clamped
//      down, policy floor applied.
//   2. A project WITHOUT a billing subscription, but WITH an explicit
//      override for that table, uses the override clamped by the
//      FLOOR ONLY. There is no tier to clamp down to, and an operator
//      who wrote the override is the authority — this is how a
//      self-hosted deployment opts in.
//   3. A project with neither is skipped ("no-window"). It is NOT
//      defaulted to the free tier: free is the most aggressive rung on
//      the ladder (30 days, 7 for audit logs), so defaulting to it
//      would silently delete a self-hoster's audit history a week
//      after they installed. Retaining too much is recoverable;
//      deleting what nobody asked to delete is not.
//
// A fourth case sits outside all three rules: a project WITH a billing
// subscription whose (tier, cycle) has no row at all in
// `billing_tier_limits` (a reference-ladder integrity gap). That is
// NOT the same as "no tier" — falling through to rule 2/3 would
// silently drop a PAYING project's tier clamp — so it gets its own
// skip reason (`tier-limits-not-found`) and a warn log rather than
// being folded into "no-window".
//
// --- Per-item isolation ---
//
// The sweep iterates projects × policies; one project's failure must
// not abort the rest. Modeled on `leaderboard-scheduler.ts`'s
// `closeDueSeasons`, which exists because a sibling function lacking
// this isolation aborted every remaining item on one bad row. A
// project-level fetch (overrides, tier limits — both project facts,
// not policy facts, so both are fetched once per project rather than
// once per policy) is isolated at the project level; the per-policy
// window resolution + delete is isolated at the (project, policy)
// level, incrementing `retentionSweepSkippedTotal` with a `reason`
// label on failure and logging with `projectId` and `table`.

const log = logger.child("retention-sweep");

export const RETENTION_SWEEP_QUEUE_NAME = "rovenue-retention-sweep";

// Mirrors `deleteWebhookEventsOlderThan`'s batching shape
// (packages/db/src/drizzle/repositories/webhook-events.ts): bounded
// subselect, loop until a batch comes back partial, cap at
// `RETENTION_MAX_BATCHES` as a brake against a single long table lock.
export const RETENTION_DELETE_BATCH_SIZE = 10_000;
export const RETENTION_MAX_BATCHES = 1_000;

// retentionSweepSkippedTotal reason labels.
export const RETENTION_SKIP_REASON_NO_WINDOW = "no-window";
export const RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND =
  "tier-limits-not-found";
export const RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED =
  "strategy-not-implemented";
export const RETENTION_SKIP_REASON_ERROR = "error";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// =============================================================
// DROP_PARTITION strategy (ROADMAP §9.2 Task 4)
// =============================================================

// Matches the schema-qualified naming `revenue-event-partitions.ts`
// and `partition-maintenance.ts` already use for hand-rolled monthly
// partitions (`<table>_<yyyy>_<mm>`), and the identifier characters
// Postgres itself allows unquoted. Every partition name this module
// acts on comes from `pg_class.relname` (the catalog, never caller
// input), but the DDL below still interpolates it via `sql.raw` — this
// is defence in depth, the same posture `revenue-event-partitions.ts`
// takes for its own catalog-sourced names.
const PARTITION_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

// Every partition this sweep touches lives in `public`, matching every
// migration in this repo (see `revenue-event-partitions.ts`, which
// hardcodes `public.revenue_events` for the same reason). Named rather
// than inlined so `listTablePartitions`, `countPartitionRows` and
// `dropPartitionTable` cannot silently drift apart on which schema
// they mean.
const PARTITION_SCHEMA = "public";

function assertSafePartitionIdentifier(name: string): string {
  if (!PARTITION_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `retention-sweep: refusing unsafe partition identifier "${name}"`,
    );
  }
  return name;
}

function qualifiedPartitionIdentifier(partitionName: string): string {
  assertSafePartitionIdentifier(partitionName);
  return `"${PARTITION_SCHEMA}"."${partitionName}"`;
}

// A RANGE bound literal as `pg_get_expr` renders a `timestamptz` value,
// e.g. `2024-01-01 00:00:00+00` — verified directly against this
// repo's Postgres. The trailing offset (`Z` or `[+-]HH[:MM]`) is
// REQUIRED, not optional: `credit_ledger`/`revenue_events` are both
// `timestamptz`-keyed today, so every literal this sweep has ever seen
// carries one, but a future `timestamp` (no tz)-keyed table would
// render one WITHOUT an offset — and `new Date(...)` parses an
// offsetless string as LOCAL time, silently shifting the bound earlier
// or later depending on the server's TZ. That shift is exactly toward
// the failure mode this task exists to prevent (an in-window partition
// misjudged as fully expired), so an offsetless literal is rejected
// outright rather than parsed optimistically.
const PARTITION_BOUND_LITERAL =
  "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}(?::?\\d{2})?)";

// Parses what `pg_get_expr(relpartbound, oid)` renders for a RANGE
// partition, e.g. `FOR VALUES FROM ('2024-01-01 00:00:00+00') TO
// ('2024-02-01 00:00:00+00')`. A bound may also be the bare keyword
// MINVALUE/MAXVALUE (no quotes) rather than a literal.
const PARTITION_BOUND_EXPR_PATTERN = new RegExp(
  `^FOR VALUES FROM \\((?:'(?<lower>${PARTITION_BOUND_LITERAL})'|(?<lowerKw>MINVALUE|MAXVALUE))\\) TO \\((?:'(?<upper>${PARTITION_BOUND_LITERAL})'|(?<upperKw>MINVALUE|MAXVALUE))\\)$`,
);

export interface PartitionBound {
  name: string;
  lowerBound: Date | null;
  upperBound: Date | null;
}

/**
 * Pure parser, DB-free on purpose so the boundary arithmetic it feeds
 * is unit-testable without Postgres. Returns `null` for anything this
 * sweep must never treat as droppable: a DEFAULT partition (bound_expr
 * is literally `DEFAULT`, no FROM/TO at all) or a bound this pattern
 * doesn't recognize — either way, "cannot determine a fixed upper
 * bound" must resolve to "never droppable," not "always droppable."
 */
export function parsePartitionBoundExpr(
  name: string,
  boundExpr: string,
): PartitionBound | null {
  const match = PARTITION_BOUND_EXPR_PATTERN.exec(boundExpr.trim());
  if (!match?.groups) return null;
  const { lower, lowerKw, upper, upperKw } = match.groups;
  return {
    name,
    lowerBound: lowerKw ? null : new Date(lower!),
    upperBound: upperKw ? null : new Date(upper!),
  };
}

/**
 * A partition is droppable ONLY when its entire range predates the
 * cutoff — its upper bound (exclusive) must be at or before the
 * cutoff. If the cutoff falls INSIDE `[lowerBound, upperBound)`, some
 * rows in the partition are still inside the retention window, and
 * dropping it would destroy them — the single most important
 * assertion this task exists to protect (see
 * retention-sweep.partitions.integration.test.ts). A partition with no
 * fixed upper bound (MAXVALUE, DEFAULT, or unparseable) is never
 * droppable: there is no point at which "entirely before the cutoff"
 * can ever become true for it.
 */
export function isPartitionDroppable(
  bound: Pick<PartitionBound, "upperBound">,
  cutoff: Date,
): boolean {
  if (bound.upperBound === null) return false;
  return bound.upperBound.getTime() <= cutoff.getTime();
}

type CatalogRow = {
  name: string;
  bound_expr: string;
};

/**
 * Every RANGE-partition child of `table` (schema-qualified to
 * `public`, matching every migration in this repo), with its bounds
 * read from `pg_class.relpartbound` via `pg_get_expr` — never by
 * querying row data. This sidesteps the property-name-vs-physical-
 * column-name trap `RetentionPolicy.timestampColumn` sets for any
 * consumer that filters rows directly (see retention-rows.ts):
 * catalog bounds are keyed by partition OID, not by column name, so
 * this function never needs to resolve or interpolate a column
 * identifier at all.
 */
export async function listTablePartitions(
  db: Db,
  table: string,
): Promise<PartitionBound[]> {
  const result = await db.execute<CatalogRow>(sql`
    SELECT child.relname AS name,
           pg_get_expr(child.relpartbound, child.oid) AS bound_expr
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = ${table} AND pn.nspname = ${PARTITION_SCHEMA}
    ORDER BY child.relname
  `);
  const bounds: PartitionBound[] = [];
  for (const row of result.rows) {
    const parsed = parsePartitionBoundExpr(row.name, row.bound_expr);
    if (parsed) {
      bounds.push(parsed);
      continue;
    }
    // DEFAULT is an expected, ordinary shape (never droppable, no
    // warning needed). Anything else this pattern doesn't recognize —
    // a LIST/HASH partition, an offsetless timestamp literal, a future
    // Postgres rendering this sweep has never seen — is a partition
    // this sweep genuinely does not understand. It's still safe (never
    // droppable), but silence would hide a config/schema drift an
    // operator should know about.
    if (row.bound_expr.trim() !== "DEFAULT") {
      log.warn("retention sweep could not parse a partition's bound; treating it as never droppable", {
        table,
        partition: row.name,
        boundExpr: row.bound_expr,
      });
    }
  }
  return bounds;
}

async function countPartitionRows(db: Db, partitionName: string): Promise<number> {
  const qualified = qualifiedPartitionIdentifier(partitionName);
  const result = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${sql.raw(qualified)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function dropPartitionTable(db: Db, partitionName: string): Promise<void> {
  const qualified = qualifiedPartitionIdentifier(partitionName);
  // Plain `DROP TABLE` on the attached partition — never `TRUNCATE`
  // anywhere in this codebase (probed directly: TRUNCATE on either the
  // partition or the parent removes rows across every partition/every
  // project with no error). DROP TABLE here is scoped to exactly this
  // one partition, and — because row triggers fire on row DML, not
  // DDL — it bypasses credit_ledger's append-only trigger completely.
  // That is exactly why `dropTablePartitionsOlderThan` below writes
  // the audit row first and only reaches this call if that write did
  // not throw.
  await db.execute(sql`DROP TABLE ${sql.raw(qualified)}`);
}

export interface PartitionDropAuditContext {
  table: string;
  partition: string;
  lowerBound: Date | null;
  upperBound: Date;
  cutoff: Date;
  // The project this ONE row is written into — a partition drop
  // affects every project sharing the partition, so this function
  // writes one row per project rather than a single global one (see
  // the module doc comment for why: `auditLogs.projectId` is a real FK
  // to `projects.id`, and recording the event in each affected
  // project's own chain is what keeps it inside `verifyAuditChain`/the
  // §9.3 proof export, which is the entire point of writing it).
  projectId: string;
  // THIS project's own resolved retention window for `table` — not the
  // fleet-wide maximum the drop cutoff was actually computed from.
  // Every project's own window is guaranteed to already have elapsed
  // for a dropped partition (the cutoff used is the longest of all of
  // them), so this is strictly more informative to that project's own
  // audit trail than the shared maximum would be.
  windowDays: number;
  rowCount: number;
}

export type WriteRetentionPartitionAuditRow = (
  ctx: PartitionDropAuditContext,
) => Promise<void>;

export interface DropTablePartitionsResult {
  partitionsDropped: string[];
  rowsDropped: number;
}

/**
 * Drops every partition of `table` whose entire range predates
 * `cutoff`, auditing each one FIRST and unconditionally: for every
 * project in `projectWindows`, `writeAuditRow` is awaited — and must
 * succeed — before `dropPartitionTable` is ever called for that
 * partition. If any one of those writes rejects, this function
 * propagates that rejection immediately: nothing is dropped, any
 * partition not yet reached is left for the next sweep run, and any
 * project not yet reached this partition gets no audit row for it
 * either — never a partial record claiming an event that did not
 * happen. `rowCount` is read from the live partition once (not once
 * per project) immediately before the first audit write, because it is
 * the only surviving evidence of what was destroyed once the partition
 * is gone.
 */
export async function dropTablePartitionsOlderThan(
  db: Db,
  table: string,
  cutoff: Date,
  projectWindows: ReadonlyMap<string, number>,
  writeAuditRow: WriteRetentionPartitionAuditRow,
): Promise<DropTablePartitionsResult> {
  const partitions = await listTablePartitions(db, table);
  const partitionsDropped: string[] = [];
  let rowsDropped = 0;

  for (const partition of partitions) {
    if (!isPartitionDroppable(partition, cutoff)) continue;
    const upperBound = partition.upperBound!; // non-null: isPartitionDroppable ruled out null above

    const rowCount = await countPartitionRows(db, partition.name);

    // Audit BEFORE the drop — once per affected project. If the
    // process dies partway through this loop, whichever project rows
    // already committed survive and describe a drop that may or may
    // not have happened yet; an operator can check the partition and
    // re-run the sweep. Dropping first would leave no record at all.
    for (const [projectId, windowDays] of projectWindows) {
      await writeAuditRow({
        table,
        partition: partition.name,
        lowerBound: partition.lowerBound,
        upperBound,
        cutoff,
        projectId,
        windowDays,
        rowCount,
      });
    }

    // Only reached if every audit write above succeeded.
    await dropPartitionTable(db, partition.name);
    partitionsDropped.push(partition.name);
    rowsDropped += rowCount;
  }

  return { partitionsDropped, rowsDropped };
}

/**
 * The real `writeAuditRow` for production use — a plain, project-scoped
 * write like any other `audit()` call. `userId` is the `"system"`
 * sentinel every other non-dashboard worker in this codebase uses.
 */
export async function writeRetentionPartitionAuditRow(
  ctx: PartitionDropAuditContext,
): Promise<void> {
  await audit({
    projectId: ctx.projectId,
    userId: "system",
    action: AUDIT_ACTION_RETENTION_PARTITION_DROPPED,
    resource: "retention_partition",
    resourceId: ctx.partition,
    before: null,
    after: {
      table: ctx.table,
      partition: ctx.partition,
      lowerBound: ctx.lowerBound ? ctx.lowerBound.toISOString() : null,
      upperBound: ctx.upperBound.toISOString(),
      cutoff: ctx.cutoff.toISOString(),
      windowDays: ctx.windowDays,
      rowCount: ctx.rowCount,
    },
    ipAddress: null,
    userAgent: null,
  });
}

// A DROP_PARTITION policy's aggregate is blocked by whichever of these
// reasons hit first: an ordinary per-project window-resolution skip
// (no-window / tier-limits-not-found), or a transient error that kept
// a project's window from being resolved at all. These are genuinely
// different situations for an operator reading the metric — a
// sustained NO_WINDOW rate means "most projects have no configured
// retention," a sustained ERROR rate means "something is actually
// broken" — so the fleet-level skip below reuses whichever specific
// reason actually caused the block instead of collapsing every case
// into `no-window`.
type PartitionBlockReason = WindowSkipReason | typeof RETENTION_SKIP_REASON_ERROR;

interface PartitionDropAggregate {
  // Set the moment ANY project's window for this table could not be
  // resolved. A partition is shared by every project, so one
  // unresolved project must block the drop for ALL of them — the
  // alternative (drop using only the projects this run DID resolve)
  // would silently destroy an unconsulted project's rows the instant
  // they share a physical partition with a resolved one. Once set, it
  // is never overwritten — the first reason a run couldn't vouch for
  // the whole fleet is the one that matters.
  blockedReason: PartitionBlockReason | null;
  // The longest (most conservative) window any project resolved for
  // this table. `resolveRetentionWindowDays` only ever lets an
  // override SHORTEN a tier's window, never lengthen it, so the
  // project asking to keep the most history is the one whose
  // requirement legitimately bounds what the shared table may lose.
  maxDays: number | null;
  // Every project's OWN resolved days for this table, keyed by
  // projectId — carried through to `dropTablePartitionsOlderThan` so
  // each project's audit row can show its own window rather than the
  // fleet-wide maximum the actual cutoff was computed from.
  projectWindows: Map<string, number>;
}

/** First reason wins; see `PartitionDropAggregate.blockedReason`. */
function blockPartitionDrop(
  aggregate: PartitionDropAggregate | undefined,
  reason: PartitionBlockReason,
): void {
  if (aggregate && aggregate.blockedReason === null) {
    aggregate.blockedReason = reason;
  }
}

export interface RetentionSweepResult {
  rowsReclaimed: number;
  skipped: number;
}

type ProjectWithTier = Awaited<
  ReturnType<typeof drizzle.billingSubscriptionRepo.listProjectsWithTier>
>[number];

type BillingTierLimitsRow = typeof drizzle.schema.billingTierLimits.$inferSelect;

export interface DeleteRetentionRowsResult {
  deleted: number;
  hitBatchCap: boolean;
}

export interface RetentionDeps {
  db: Db;
  listProjectsWithTier: (db: Db) => Promise<ProjectWithTier[]>;
  findByTierAndCycle: (
    db: Db,
    tier: BillingTierLimitsRow["tier"],
    cycle: BillingTierLimitsRow["cycle"],
  ) => Promise<BillingTierLimitsRow | null>;
  listRetentionOverrides: (
    db: Db,
    projectId: string,
  ) => Promise<Map<string, number>>;
  deleteRetentionRows: (
    db: Db,
    table: string,
    timestampColumn: string,
    projectId: string,
    cutoff: Date,
    terminalStatuses: readonly string[] | undefined,
    batchSize: number,
    maxBatches: number,
  ) => Promise<DeleteRetentionRowsResult>;
  dropTablePartitionsOlderThan: (
    db: Db,
    table: string,
    cutoff: Date,
    projectWindows: ReadonlyMap<string, number>,
    writeAuditRow: WriteRetentionPartitionAuditRow,
  ) => Promise<DropTablePartitionsResult>;
}

export const defaultDeps: RetentionDeps = {
  db: drizzle.db,
  listProjectsWithTier: drizzle.billingSubscriptionRepo.listProjectsWithTier,
  findByTierAndCycle: drizzle.billingTierLimitsRepo.findByTierAndCycle,
  listRetentionOverrides: drizzle.retentionOverrideRepo.listRetentionOverrides,
  deleteRetentionRows: drizzle.retentionRowsRepo.deleteRetentionRowsOlderThan,
  dropTablePartitionsOlderThan,
};

type WindowSkipReason =
  | typeof RETENTION_SKIP_REASON_NO_WINDOW
  | typeof RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND;

export type WindowResolution =
  | { kind: "resolved"; days: number }
  | { kind: "skip"; reason: WindowSkipReason };

/**
 * Resolve how many days of history one project keeps for one policy,
 * applying the rules documented in the module doc comment above.
 */
export function resolveProjectPolicyWindowDays(
  policy: RetentionPolicy,
  hasTier: boolean,
  tierLimits: BillingTierLimitsRow | null,
  overrideDays: number | undefined,
): WindowResolution {
  if (hasTier && !tierLimits) {
    // The project names a (tier, cycle) pair but the reference ladder
    // has no matching row — a billing_tier_limits integrity gap, not
    // an ordinary no-tier project. Skip loudly rather than silently
    // treating a paying project's tier clamp as absent.
    return {
      kind: "skip",
      reason: RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
    };
  }

  if (tierLimits) {
    // Rule 1: normal path. `resolveRetentionWindowDays` clamps the
    // override down against the tier and floors at the policy minimum.
    const tierDays = tierLimits[policy.tierLimitField];
    const days = resolveRetentionWindowDays({
      policy,
      tierDays,
      projectOverrideDays: overrideDays ?? null,
    });
    return { kind: "resolved", days };
  }

  if (overrideDays !== undefined) {
    // Rule 2: no tier to clamp down to. The operator who wrote the
    // override is the authority; only the policy's own floor still
    // applies.
    return { kind: "resolved", days: Math.max(policy.minimumDays, overrideDays) };
  }

  // Rule 3: neither a tier nor an override.
  return { kind: "skip", reason: RETENTION_SKIP_REASON_NO_WINDOW };
}

/**
 * Sweep every project against every retention policy, reclaiming
 * whatever has aged past its resolved window. `DELETE_ROWS` policies
 * are deleted per (project, policy) as the loop reaches them.
 * `DROP_PARTITION` policies resolve their window per project exactly
 * the same way, but the drop itself is deferred until every project
 * has been considered — see the module doc comment above for why a
 * per-project window cannot, alone, authorise dropping a partition
 * every project shares. `CHECKPOINT_TRUNCATE` policies are still
 * counted as skipped until Task 5 lands.
 */
export async function runRetentionSweep(
  now: Date,
  deps: RetentionDeps = defaultDeps,
): Promise<RetentionSweepResult> {
  const projectRows = await deps.listProjectsWithTier(deps.db);

  let rowsReclaimed = 0;
  let skipped = 0;

  const partitionDropAggregates = new Map<string, PartitionDropAggregate>();
  for (const policy of RETENTION_POLICIES) {
    if (policy.strategy === "DROP_PARTITION") {
      partitionDropAggregates.set(policy.table, {
        blockedReason: null,
        maxDays: null,
        projectWindows: new Map(),
      });
    }
  }

  for (const project of projectRows) {
    const hasTier = Boolean(project.tier && project.cycle);

    // Project-level facts, fetched once per project (not once per
    // policy — both are the same for every policy this project is
    // checked against). A failure here skips every policy for this
    // project but leaves the rest of the sweep untouched.
    let overrides: Map<string, number>;
    let tierLimits: BillingTierLimitsRow | null = null;
    try {
      overrides = await deps.listRetentionOverrides(
        deps.db,
        project.projectId,
      );
      if (hasTier) {
        tierLimits = await deps.findByTierAndCycle(
          deps.db,
          project.tier!,
          project.cycle!,
        );
      }
    } catch (err) {
      for (const policy of RETENTION_POLICIES) {
        skipped += 1;
        retentionSweepSkippedTotal.inc({
          reason: RETENTION_SKIP_REASON_ERROR,
          table: policy.table,
        });
        // This project's window for a DROP_PARTITION table could not
        // even be attempted — the fleet-wide aggregate can no longer
        // vouch that every project's window was considered, so it
        // must block the drop exactly like an ordinary unresolved
        // window would, but under its OWN reason (this is a transient
        // failure, not "nobody configured a window").
        blockPartitionDrop(
          partitionDropAggregates.get(policy.table),
          RETENTION_SKIP_REASON_ERROR,
        );
      }
      log.error("retention sweep failed to load project facts", {
        projectId: project.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const policy of RETENTION_POLICIES) {
      try {
        const overrideDays = overrides.get(policy.table);

        const resolution = resolveProjectPolicyWindowDays(
          policy,
          hasTier,
          tierLimits,
          overrideDays,
        );
        if (resolution.kind === "skip") {
          skipped += 1;
          retentionSweepSkippedTotal.inc({
            reason: resolution.reason,
            table: policy.table,
          });
          if (resolution.reason === RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND) {
            log.warn(
              "billing_tier_limits has no row for this project's tier/cycle; skipping window resolution",
              {
                projectId: project.projectId,
                table: policy.table,
                tier: project.tier,
                cycle: project.cycle,
              },
            );
          }
          // This project's window for a shared DROP_PARTITION table is
          // unresolved. Absence of configuration must never read as
          // permission to delete, so it blocks the drop for every
          // project sharing that table's partitions this run — not
          // just this one. Carries the SPECIFIC reason (no-window vs.
          // tier-limits-not-found) through to the fleet-level skip.
          blockPartitionDrop(
            partitionDropAggregates.get(policy.table),
            resolution.reason,
          );
          continue;
        }

        if (policy.strategy === "DROP_PARTITION") {
          // Resolved, but not acted on yet: fold this project's window
          // into the fleet-wide aggregate rather than deleting
          // anything now. The actual drop happens once, after every
          // project has been considered, using the LONGEST window any
          // project resolved (see the module doc comment) — and this
          // project's OWN resolved days is retained too, so its audit
          // row can carry its own window rather than the fleet max.
          const aggregate = partitionDropAggregates.get(policy.table)!;
          aggregate.maxDays =
            aggregate.maxDays === null
              ? resolution.days
              : Math.max(aggregate.maxDays, resolution.days);
          aggregate.projectWindows.set(project.projectId, resolution.days);
          continue;
        }

        if (policy.strategy !== "DELETE_ROWS") {
          // Not silently ignored: CHECKPOINT_TRUNCATE is real,
          // actionable work this task deliberately does not implement.
          // Task 5 fills it in.
          skipped += 1;
          retentionSweepSkippedTotal.inc({
            reason: RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED,
            table: policy.table,
          });
          continue;
        }

        const cutoff = new Date(now.getTime() - resolution.days * MS_PER_DAY);
        const { deleted, hitBatchCap } = await deps.deleteRetentionRows(
          deps.db,
          policy.table,
          policy.timestampColumn,
          project.projectId,
          cutoff,
          policy.terminalStatuses,
          RETENTION_DELETE_BATCH_SIZE,
          RETENTION_MAX_BATCHES,
        );
        rowsReclaimed += deleted;
        retentionRowsReclaimedTotal.inc({ table: policy.table }, deleted);

        if (hitBatchCap) {
          retentionSweepBatchCapReachedTotal.inc({ table: policy.table });
          log.warn(
            "retention sweep hit its batch cap; rows past the cutoff may remain",
            {
              projectId: project.projectId,
              table: policy.table,
              deleted,
              maxBatches: RETENTION_MAX_BATCHES,
              batchSize: RETENTION_DELETE_BATCH_SIZE,
            },
          );
        }
      } catch (err) {
        // Per-item isolation: one project's bad row, missing tier
        // ladder entry, or transient DB error must not abort every
        // remaining (project, policy) unit in this sweep.
        skipped += 1;
        retentionSweepSkippedTotal.inc({
          reason: RETENTION_SKIP_REASON_ERROR,
          table: policy.table,
        });
        // Same reasoning as the two explicit skip branches above: this
        // project's requirement for a shared DROP_PARTITION table is
        // now unknown, which must block the drop for every project
        // sharing it, not just this one — under the ERROR reason, not
        // "no-window".
        blockPartitionDrop(
          partitionDropAggregates.get(policy.table),
          RETENTION_SKIP_REASON_ERROR,
        );
        log.error("retention sweep unit failed", {
          projectId: project.projectId,
          table: policy.table,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // DROP_PARTITION: the drop itself, once per policy, using whatever
  // the project loop above resolved. See the module doc comment and
  // `PartitionDropAggregate` for why this is deferred rather than done
  // per project.
  for (const policy of RETENTION_POLICIES) {
    if (policy.strategy !== "DROP_PARTITION") continue;
    const aggregate = partitionDropAggregates.get(policy.table)!;
    const maxDays = aggregate.maxDays;

    if (aggregate.blockedReason !== null || maxDays === null) {
      // Either some project's window for this table is unresolved (its
      // requirement is unknown, so the shared table cannot be touched
      // on its behalf — reported under whichever specific reason
      // actually blocked it) or literally no project resolved a window
      // at all (nothing to safely bound the drop by — falls back to
      // "no-window", the same underlying condition as the per-project
      // skip, just evaluated once for the whole fleet).
      skipped += 1;
      retentionSweepSkippedTotal.inc({
        reason: aggregate.blockedReason ?? RETENTION_SKIP_REASON_NO_WINDOW,
        table: policy.table,
      });
      continue;
    }

    try {
      const cutoff = new Date(now.getTime() - maxDays * MS_PER_DAY);
      const { partitionsDropped, rowsDropped } =
        await deps.dropTablePartitionsOlderThan(
          deps.db,
          policy.table,
          cutoff,
          aggregate.projectWindows,
          writeRetentionPartitionAuditRow,
        );
      rowsReclaimed += rowsDropped;
      retentionRowsReclaimedTotal.inc({ table: policy.table }, rowsDropped);
      if (partitionsDropped.length > 0) {
        log.info("retention sweep dropped partitions", {
          table: policy.table,
          partitions: partitionsDropped,
          maxWindowDays: maxDays,
          projectCount: aggregate.projectWindows.size,
          cutoff: cutoff.toISOString(),
        });
      }
    } catch (err) {
      // Per-item isolation at the policy level: a failure dropping
      // credit_ledger's partitions must not prevent revenue_events'
      // from being considered.
      skipped += 1;
      retentionSweepSkippedTotal.inc({
        reason: RETENTION_SKIP_REASON_ERROR,
        table: policy.table,
      });
      log.error("retention sweep partition drop failed", {
        table: policy.table,
        maxWindowDays: maxDays,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result: RetentionSweepResult = { rowsReclaimed, skipped };
  if (result.rowsReclaimed > 0 || result.skipped > 0) {
    log.info("retention sweep", { ...result });
  }
  return result;
}
