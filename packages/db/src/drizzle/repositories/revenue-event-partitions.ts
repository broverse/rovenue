import { sql } from "drizzle-orm";
import type { Db } from "../client";

// =============================================================
// revenue_events partition provisioning (task 8a)
// =============================================================
//
// `revenue_events` (migration 0015) is RANGE-partitioned by `eventDate`
// with NO default partition. Migration 0015 bulk-created monthly
// partitions for 2024-01..2028-12 only; migration 0019 registers
// `partman.create_parent` for ongoing (post-2028) premake/retention. An
// insert whose `eventDate` falls outside every existing child partition
// fails outright: `no partition of relation "revenue_events" found for
// row` (verified directly against this repo's Postgres image).
//
// The historical-import feature needs to write revenue dated years
// before 2024, so it must provision the partitions it needs BEFORE
// Phase A writes a single row (never mid-file — see write.ts).
//
// -------------------------------------------------------------
// Two install paths, two provisioning strategies — VERIFIED, not assumed
// -------------------------------------------------------------
//
// `packages/db/src/fresh-install.ts` treats `0019_install_pg_partman` as
// TimescaleDB-era and marks it applied WITHOUT EXECUTING on every fresh
// install (self-hosted first deploy, and — because
// `apps/api/tests/global-setup.ts` builds its template via
// `runFreshInstall` — every test run in this repo). Its own comment
// explains why: 0015 already bulk-created the 2024-01..2028-12
// partitions by hand, and `partman.create_parent`'s premake from
// `p_start_partition => '2024-01-01'` collides with them
// ("partition ... would overlap partition"). Confirmed live against
// this repo's dev Postgres:
//
//   - `SELECT * FROM partman.part_config WHERE parent_table =
//     'public.revenue_events'` returns ZERO rows on this database (a
//     fresh install) — pg_partman is not managing this table at all
//     here, exactly as fresh-install.ts documents.
//   - `partman.create_partition_time('public.revenue_events', ...)`
//     on this database raises `no config found for public.revenue_events`
//     — pg_partman's own manual-partition API requires the part_config
//     row 0019 never created.
//   - `partman.create_parent(...)` on this database raises `partition
//     "revenue_events_p20240101" would overlap partition
//     "revenue_events_2024_01"` for any `p_start_partition` at or
//     before 2024-01 — there is no way to register the parent after
//     the fact without first detaching the existing children, which is
//     destructive and out of this task's scope.
//
// So on a fresh install, pg_partman isn't in the picture for this table
// AT ALL (its own partition-maintenance worker already treats "not in
// part_config" as "not my table to touch" — apps/api/src/workers/
// partition-maintenance.ts's `outgoing_webhooks` branch is precedent for
// exactly this: hand-rolled `CREATE TABLE IF NOT EXISTS ... PARTITION
// OF` for a table pg_partman does not manage). Hand-rolling a partition
// here is not "fighting" pg_partman — pg_partman has no opinion about
// this table on this install.
//
// On an upgrade-path database (production, where 0019 actually ran and
// registered `public.revenue_events` in `part_config`), pg_partman DOES
// own this parent's partition bookkeeping, and `create_partition_time`
// is its documented, idempotent API for exactly this — "create a
// partition for a specific time that isn't covered by the current
// premake window" — verified end to end against a scratch pg_partman
// parent: creating a month that already exists returns `false` and
// creates nothing; creating a genuinely new month (including one before
// the registered `p_start_partition`) succeeds and the new partition
// accepts inserts immediately.
//
// This module picks the strategy per call by checking which install
// state the database is actually in, so the SAME function is correct
// on both a fresh self-host and a long-lived production database.

/** Matches migration 0019's registered interval; also the grain 0015's
 *  bulk-created initial partitions use. Provisioning at any other grain
 *  would create partitions pg_partman's OWN premake can't line up with
 *  once (if ever) a database is upgraded onto the partman-managed path. */
const PARTITION_INTERVAL_MONTHS = 1;

const REVENUE_EVENTS_QUALIFIED_TABLE = "public.revenue_events";
const REVENUE_EVENTS_TABLE = "revenue_events";

/** Defence in depth: every table/partition name this module builds is
 *  either this hard-coded constant or a name IT computes from a Date —
 *  never caller-supplied — but the name still lands in DDL via
 *  `sql.raw`, so this guard makes "how could that become injectable"
 *  a question with a checked answer instead of an assumed one. */
const SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(name: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `revenue-event-partitions: refusing unsafe identifier "${name}"`,
    );
  }
}

// =============================================================
// Pure month-range helper
// =============================================================

/**
 * Every whole UTC calendar-month boundary from `minEventDate` through
 * `maxEventDate`, inclusive of both ends' months.
 *
 * Pure and DB-free on purpose: the dry-run planner (`plan.ts`) reports
 * the exact span this module would provision WITHOUT touching Postgres
 * (a dry run writes nothing), so it needs this calculation available
 * without importing anything that opens a connection.
 */
export function monthStartsUtc(minEventDate: Date, maxEventDate: Date): Date[] {
  if (minEventDate.getTime() > maxEventDate.getTime()) {
    throw new Error(
      `monthStartsUtc: minEventDate (${minEventDate.toISOString()}) is after ` +
        `maxEventDate (${maxEventDate.toISOString()})`,
    );
  }
  const months: Date[] = [];
  let cursor = new Date(
    Date.UTC(minEventDate.getUTCFullYear(), minEventDate.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(maxEventDate.getUTCFullYear(), maxEventDate.getUTCMonth(), 1),
  );
  while (cursor.getTime() <= end.getTime()) {
    months.push(cursor);
    cursor = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + PARTITION_INTERVAL_MONTHS,
        1,
      ),
    );
  }
  return months;
}

function monthPartitionName(unqualifiedParentTable: string, monthStart: Date): string {
  const yyyy = monthStart.getUTCFullYear();
  const mm = String(monthStart.getUTCMonth() + 1).padStart(2, "0");
  return `${unqualifiedParentTable}_${yyyy}_${String(mm)}`;
}

// =============================================================
// Install-state detection
// =============================================================

/** True when pg_partman actually owns `qualifiedParentTable` — i.e. 0019
 *  (or an operator's manual equivalent) registered it. Checked at call
 *  time rather than cached: this function runs at most once per import
 *  batch, never in a hot per-row path, so a fresh read each time is
 *  cheap and can never go stale across a database upgrade. */
async function isPartmanManaged(
  db: Db,
  qualifiedParentTable: string,
): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM "partman"."part_config" WHERE "parent_table" = ${qualifiedParentTable} LIMIT 1`,
  );
  const rows = (result as unknown as { rows: unknown[] }).rows;
  return rows.length > 0;
}

// =============================================================
// Generic monthly-range-partition provisioner
// =============================================================

export interface EnsureMonthlyPartitionsArgs {
  /** Schema-qualified name as registered (or to be checked) in
   *  `partman.part_config.parent_table`, e.g. `"public.revenue_events"`. */
  qualifiedParentTable: string;
  /** Bare table name, used only for the hand-rolled child-table naming
   *  fallback (`<table>_<yyyy>_<mm>`) — never interpolated from anything
   *  other than this module's own constants in production use. */
  unqualifiedParentTable: string;
  minEventDate: Date;
  maxEventDate: Date;
}

/**
 * Ensures a monthly range partition exists for every month touched by
 * `[minEventDate, maxEventDate]`, using whichever strategy actually
 * applies to this database (see the module header). Creating a
 * partition that already exists is always a safe no-op — required
 * because imports overlap and because Task 8's worker may call this
 * once per batch of the same job.
 *
 * Exported (not just `ensureRevenueEventPartitions`) so both branches
 * can be exercised directly against a real Postgres in tests: the
 * hand-rolled branch against the real `revenue_events` table (this
 * repo's only reachable install state), and the pg_partman branch
 * against a scratch parent registered with `partman.create_parent` in
 * the test itself — proving the strategy this repo's own dev/CI
 * Postgres can never take, without pretending it wasn't tested.
 */
export async function ensureMonthlyPartitions(
  db: Db,
  args: EnsureMonthlyPartitionsArgs,
): Promise<void> {
  const months = monthStartsUtc(args.minEventDate, args.maxEventDate);
  if (months.length === 0) return;

  if (await isPartmanManaged(db, args.qualifiedParentTable)) {
    const timestamps = months.map((m) => sql`${m.toISOString()}::timestamptz`);
    await db.execute(
      sql`SELECT "partman"."create_partition_time"(
        ${args.qualifiedParentTable},
        ARRAY[${sql.join(timestamps, sql`, `)}]::timestamptz[]
      )`,
    );
    return;
  }

  assertSafeIdentifier(args.unqualifiedParentTable);
  for (const monthStart of months) {
    const monthEnd = new Date(
      Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth() + PARTITION_INTERVAL_MONTHS,
        1,
      ),
    );
    const partitionName = monthPartitionName(
      args.unqualifiedParentTable,
      monthStart,
    );
    assertSafeIdentifier(partitionName);
    // `FOR VALUES FROM (...) TO (...)` bounds must be constant
    // expressions — Postgres rejects a bind parameter there ("bind
    // message supplies N parameters, but prepared statement requires
    // 0"), confirmed against this repo's Postgres. Both bounds are this
    // function's OWN `Date#toISOString()` output (fixed digit/`-`/`:`/
    // `.`/`Z` charset, never caller text), so literal-embedding via
    // `sql.raw` carries no injection risk despite skipping bind params.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${partitionName}"`)}
        PARTITION OF ${sql.raw(`"${args.unqualifiedParentTable}"`)}
        FOR VALUES FROM (${sql.raw(`'${monthStart.toISOString()}'::timestamptz`)})
                     TO (${sql.raw(`'${monthEnd.toISOString()}'::timestamptz`)})
    `);
  }
}

/**
 * `revenue_events`-specific entry point — what the import writer and
 * dry-run planner actually call. See the module header for why the
 * strategy is chosen per call rather than hard-coded to one branch.
 */
export async function ensureRevenueEventPartitions(
  db: Db,
  range: { minEventDate: Date; maxEventDate: Date },
): Promise<void> {
  await ensureMonthlyPartitions(db, {
    qualifiedParentTable: REVENUE_EVENTS_QUALIFIED_TABLE,
    unqualifiedParentTable: REVENUE_EVENTS_TABLE,
    minEventDate: range.minEventDate,
    maxEventDate: range.maxEventDate,
  });
}

/**
 * Pure description of the span `ensureRevenueEventPartitions` would
 * provision for a given observed range — no DB access, for the dry
 * run's report (plan.ts). `fromMonth`/`toMonth` are `YYYY-MM`, UTC.
 */
export function describeRequiredPartitionSpan(
  minEventDate: Date,
  maxEventDate: Date,
): { fromMonth: string; toMonth: string; monthCount: number } {
  const months = monthStartsUtc(minEventDate, maxEventDate);
  const format = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    fromMonth: format(months[0]!),
    toMonth: format(months[months.length - 1]!),
    monthCount: months.length,
  };
}
