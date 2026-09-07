import { sql } from "drizzle-orm";
import type { Db } from "../client";

// =============================================================
// revenue_events partition provisioning (task 8a)
// =============================================================
//
// `revenue_events` (migration 0015) is RANGE-partitioned by `eventDate`.
// Migration 0015 bulk-created monthly partitions for 2024-01..2028-12
// only; migration 0130 registers `partman.create_parent` for ongoing
// (post-2028) premake. An insert whose `eventDate` falls outside every
// existing child partition used to fail outright: `no partition of
// relation "revenue_events" found for row` (verified directly against
// this repo's Postgres image). Since 0130 the parent also has a partman
// `revenue_events_default`, so such a row is absorbed there instead —
// which is NOT a licence to skip provisioning: Postgres then refuses to
// attach the real partition for that month while the stray row sits in
// the default, so the failure moves from the insert to a later
// maintenance run. Provision first, as this module exists to do.
//
// The historical-import feature needs to write revenue dated years
// before 2024, so it must provision the partitions it needs BEFORE
// Phase A writes a single row (never mid-file — see write.ts).
//
// -------------------------------------------------------------
// Two strategies — VERIFIED, not assumed
// -------------------------------------------------------------
//
// HISTORY, because it explains why this fork exists at all.
// `packages/db/src/fresh-install.ts` treats `0019_install_pg_partman` as
// TimescaleDB-era and marks it applied WITHOUT EXECUTING on every fresh
// install (self-hosted first deploy, and — because
// `apps/api/tests/global-setup.ts` builds its template via
// `runFreshInstall` — every test run in this repo). Its own comment
// explains why: 0015 already bulk-created the 2024-01..2028-12
// partitions by hand, and `partman.create_parent`'s premake from
// `p_start_partition => '2024-01-01'` collides with them —
// `partition "revenue_events_p20240101" would overlap partition
// "revenue_events_2024_01"`, reproduced verbatim against this repo's
// own image. So for a long time `revenue_events` was partman-managed on
// the upgrade path and unmanaged on a fresh install, and this module
// picked its strategy per call to be correct on both.
//
// SINCE MIGRATION 0130 that asymmetry is gone: 0130 runs on BOTH paths
// and registers the parent starting at the first month the hand-made
// children do not already cover, so `public.revenue_events` is in
// `partman.part_config` on any migrated database and this module takes
// the pg_partman branch. Verified end to end against a database built
// by `runFreshInstall` on this repo's image: with the parent registered
// from 2029-01, `create_partition_time('public.revenue_events',
// ARRAY['2019-03-01'])` creates `revenue_events_p20190301` — a month far
// BEHIND the registered start — the second call for the same month
// returns `false` and creates nothing, and a row dated 2019-03-15 lands
// in it.
//
// -------------------------------------------------------------
// WHY MONTHS ARE FILTERED AGAINST THE CATALOG FIRST
// -------------------------------------------------------------
//
// partman's idempotence is by child NAME. It computes
// `revenue_events_p20260301` for 2026-03 and, seeing no table by that
// name, attaches it — but 0015 already owns that range under the name
// `revenue_events_2026_03`, so Postgres refuses:
//
//   ERROR:  partition "revenue_events_p20260301" would overlap partition
//           "revenue_events_2026_03"
//
// reproduced against this repo's image on a `runFreshInstall` database.
// Every month in 2024-01..2028-12 — i.e. TODAY's data — is in that
// state. The pre-0130 hand-rolled branch never hit it, because
// `CREATE TABLE IF NOT EXISTS revenue_events_2026_03` is a no-op on the
// name 0015 used.
//
// So both branches now start from `uncoveredMonths`, which asks the
// CATALOG (pg_inherits + relpartbound ranges, exactly how partman itself
// resolves a partition set) which months already have a child covering
// them, whatever that child is called. A month is passed to the creating
// branch only if no existing child's range contains its first instant.
// That is correct for all three positions a month can occupy: inside the
// hand-made range (covered -> skipped, and the existing child serves it),
// below partman's registered start with no child (uncovered -> partman
// creates a month behind its own window, which it does happily), and at
// or after the registered start (covered by premake -> skipped, else
// created). It is also what makes repeat calls free rather than merely
// error-free.
//
// Filtering before BOTH branches rather than only the partman one is
// deliberate: the hand-rolled branch has the same blind spot from the
// other side (`IF NOT EXISTS` protects the name, not the range), so a
// parent with differently-named children would fail there too.
//
// The hand-rolled branch is kept, not dead code: it is the correct
// behaviour for any partitioned parent nobody registered, it is what
// runs if 0130's availability guard skipped on a server without
// pg_partman, and `apps/api/src/workers/partition-maintenance.ts`'s
// `outgoing_webhooks` branch is the same pattern for a table partman
// deliberately does not manage. Both branches are covered by
// packages/db/tests/revenue-event-partitions.test.ts against a real
// Postgres — the partman one by `revenue_events` itself, the
// hand-rolled one by a scratch parent the test leaves unregistered.

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

/** Pull the bounds out of a child's `FOR VALUES FROM ('...') TO ('...')`.
 *  Sent as bind parameters, so these are raw POSIX regexes — no SQL
 *  quote-doubling. A DEFAULT partition's bound expression is the bare word
 *  DEFAULT and matches neither, yielding NULL and dropping out of the
 *  containment test — which is exactly right: a row landing in the default
 *  is the failure this module exists to prevent, never proof of coverage.
 *  An unbounded MINVALUE/MAXVALUE child matches neither either, so it reads
 *  as "not covered"; no such child exists on these parents, and the
 *  conservative direction is to attempt creation and fail loudly rather
 *  than to skip silently. Mirrors `UPPER_BOUND_PATTERN` in migration 0130
 *  and `parsePartitionBoundExpr` in apps/api's retention sweep. */
const LOWER_BOUND_PATTERN = "FROM \\('(.*?)'\\)";
const UPPER_BOUND_PATTERN = "TO \\('(.*?)'\\)";

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

/**
 * The subset of `months` that NO existing child of `qualifiedParentTable`
 * already covers, in the order given.
 *
 * Coverage is decided by RANGE, read from the catalog, never by the name
 * a child happens to carry — see the module header. `relpartbound` is
 * rendered in the session TimeZone but always carries an explicit offset,
 * so casting it back to `timestamptz` compares instants and is TimeZone-
 * independent.
 */
async function uncoveredMonths(
  db: Db,
  qualifiedParentTable: string,
  months: Date[],
): Promise<Date[]> {
  const timestamps = months.map((m) => sql`${m.toISOString()}::timestamptz`);
  const result = await db.execute(sql`
    SELECT "t"."ord"::int AS "ord"
      FROM unnest(ARRAY[${sql.join(timestamps, sql`, `)}]::timestamptz[])
           WITH ORDINALITY AS "t"("month_start", "ord")
     WHERE NOT EXISTS (
       SELECT 1
         FROM "pg_inherits" "i"
         JOIN "pg_class" "c" ON "c"."oid" = "i"."inhrelid"
        WHERE "i"."inhparent" = ${qualifiedParentTable}::regclass
          AND (substring(
                pg_get_expr("c"."relpartbound", "c"."oid")
                FROM ${LOWER_BOUND_PATTERN}
              ))::timestamptz <= "t"."month_start"
          AND (substring(
                pg_get_expr("c"."relpartbound", "c"."oid")
                FROM ${UPPER_BOUND_PATTERN}
              ))::timestamptz > "t"."month_start"
     )
     ORDER BY "t"."ord"
  `);
  const rows = (result as unknown as { rows: Array<{ ord: number }> }).rows;
  // `WITH ORDINALITY` is 1-based.
  return rows.map((row) => months[row.ord - 1]!).filter((m) => m !== undefined);
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
  const requested = monthStartsUtc(args.minEventDate, args.maxEventDate);
  if (requested.length === 0) return;

  // Whichever branch runs, only months no existing child already covers
  // reach it. See "WHY MONTHS ARE FILTERED AGAINST THE CATALOG FIRST".
  const months = await uncoveredMonths(
    db,
    args.qualifiedParentTable,
    requested,
  );
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
