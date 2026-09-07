import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { sql } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  partitionDefaultRows,
  partitionMaintenancePartmanRan,
  partitionPremakeMonthsRemaining,
} from "../lib/metrics";

// =============================================================
// Partition maintenance worker (Plan 3 §F.3)
// =============================================================
//
// Runs daily at 03:00 UTC. Three jobs:
//
//   1. `CALL partman.run_maintenance_proc()` — pg_partman rolls the
//      premake window forward for every parent in
//      `partman.part_config`. As of migration 0130 that set is
//      `revenue_events` and `credit_ledger` (0130), `funnel_sessions`
//      and `funnel_answers` (0051), and `integration_deliveries`
//      (0060).
//
//      Registration is 0130's, not 0019's. 0019 tried first and is in
//      `TIMESCALE_LEGACY_TAGS` — marked applied without executing on
//      every fresh install — because its `create_parent` overlapped
//      the 60 hand-made children migrations 0015/0016 had already
//      created. 0130 registers from the first month those children do
//      NOT cover, so it runs on both install paths: it registers on a
//      fresh install and reconciles an existing `part_config` row on
//      the upgrade path.
//
//      Only premake. 0130 nulls partman's retention on both tables —
//      `workers/retention-sweep.ts` owns dropping, because it is
//      tenant-scoped and audited and partman is neither. Which means
//      there is NO backstop dropper for these two tables: if the sweep
//      stalls they grow unbounded, and the gauges set at the end of
//      this run are the only thing watching them.
//
//   2. Manually pre-create the next thirteen months of
//      `outgoing_webhooks` partitions. That table is intentionally NOT
//      pg_partman-managed because its retention predicate is
//      composite (status + age) — the registry-driven retention sweep
//      (ROADMAP §9.2, workers/retention-sweep.ts) handles row-level
//      deletion via DELETE_ROWS, restricted to terminalStatuses.
//      Without this manual step the table would refuse rows for any
//      month past 2028-12 (the end of the bulk-created window in
//      migration 0017).
//
//   3. Publish the partition gauges (`apps/api/src/lib/metrics.ts`).
//      Everything above is invisible without them: a stalled premake
//      window only announces itself when an insert finally lands past
//      the last partition, which for `revenue_events` was a date in
//      2029 that nobody was going to reach in testing.
//
// The 8-year-row test in partition-maintenance.integration.test.ts
// is the load-bearing VUK 7-year retention proof.

const log = logger.child("partition-maintenance");

export const PARTITION_MAINTENANCE_QUEUE_NAME =
  "rovenue-partition-maintenance";

const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000; // daily
// 03:00 UTC is "low traffic" globally — most users finished their
// nightly batches and morning users haven't started.
const TARGET_HOUR_UTC = 3;
const REPEATABLE_JOB_NAME = "partition:maintenance";
const REPEATABLE_JOB_ID = "partition-maintenance-repeatable";

/** The one partitioned table this worker premakes by hand. Declared
 *  here rather than beside its loop because WATCHED_PARTITIONED_TABLES
 *  reads it at module-evaluation time. */
const OUTGOING_WEBHOOKS_TABLE = "outgoing_webhooks";
/** Look this far ahead so headroom survives the worker missing runs. */
const OUTGOING_WEBHOOKS_MONTHS_AHEAD = 13;

export interface PartitionMaintenanceResult {
  partmanRan: boolean;
  manualPartitionsCreated: number;
}

export async function runPartitionMaintenance(): Promise<PartitionMaintenanceResult> {
  const db = getDb();

  // pg_partman rolls the premake window forward for every registered
  // parent. In practice every fully-migrated database has the schema:
  // `0051_funnel_partitions.sql` runs `CREATE SCHEMA IF NOT EXISTS
  // partman` + `CREATE EXTENSION IF NOT EXISTS pg_partman` UNGUARDED
  // and is NOT in `TIMESCALE_LEGACY_TAGS`, so it executes on the
  // fresh-install path too — verified against the local dev database
  // and the `rovenue_test_tpl` template, both of which carry the
  // schema and three registered parents. (0019 also installs it, but
  // 0019 is skipped on fresh installs; 0051 is what actually puts
  // partman there.)
  //
  // The guard therefore only catches a database that stopped before
  // 0051, or one whose server lacks the extension entirely — on which
  // 0051 itself would already have failed. It stays because the cost
  // of being wrong is asymmetric: calling run_maintenance_proc() on a
  // database without partman throws, and this worker would then never
  // reach the outgoing_webhooks step below. Skipping is recorded on
  // `rovenue_partition_maintenance_partman_ran` rather than left as a
  // log line, so a run that quietly does half its job is visible.
  const partmanRan = await runPartmanMaintenanceIfInstalled(db);

  // Hand-roll the next-month partition for outgoing_webhooks. This
  // is idempotent — `IF NOT EXISTS` guards re-runs.
  const manualPartitionsCreated = await createOutgoingWebhooksPartition();

  // Last, and never allowed to fail the run: reporting on the work is
  // not the work. A broken gauge query must not stop partitions from
  // being created.
  await publishPartitionMetrics(db, partmanRan);

  return { partmanRan, manualPartitionsCreated };
}

async function runPartmanMaintenanceIfInstalled(
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  const installed = await db.execute<{ present: boolean }>(
    sql`SELECT EXISTS (
          SELECT 1 FROM pg_namespace WHERE nspname = 'partman'
        ) AS present`,
  );
  if (!installed.rows[0]?.present) {
    log.warn("partman schema absent — skipping run_maintenance_proc", {
      reason:
        "no `partman` schema on this database; 0051_funnel_partitions creates " +
        "it on both install paths, so a fully-migrated database should never " +
        "reach here. Every partman-managed parent stops rolling forward while " +
        "this is true.",
    });
    return false;
  }
  // `run_maintenance_proc` is a PROCEDURE, not a function — `SELECT`
  // on it fails with 42809 "To call a procedure, use CALL". This was
  // the third independent reason this worker had never completed.
  await db.execute(sql`CALL partman.run_maintenance_proc()`);
  log.info("partman.run_maintenance_proc completed");
  return true;
}

// =============================================================
// Observability
// =============================================================
//
// Migration 0130 creates exactly ONE forward partition for
// `revenue_events` / `credit_ledger`; everything past it exists only
// because this worker calls run_maintenance_proc daily. Nothing
// observed that until these gauges — which is precisely how the
// original "partitions stop at 2029-01" defect survived: the only
// symptom it could produce was an insert failing on a date nobody had
// reached.

/**
 * Tables whose premake headroom is reported.
 *
 * MONTHLY-partitioned only, deliberately. `integration_deliveries`
 * (0060) is partitioned by DAY with a premake of 7, so its healthy
 * headroom is a quarter of a month — including it would put
 * `rovenue_partition_premake_months_remaining` permanently under the
 * `< 3` alert threshold and train everyone to ignore the alert.
 * `funnel_sessions` / `funnel_answers` (0051) are monthly but keep
 * partman's default premake of 4, close enough to 3 that a single
 * missed run reads as an incident.
 *
 * So this is the set this worker is actually responsible for keeping
 * ahead: the two parents 0130 registers, plus the one it hand-rolls.
 */
const WATCHED_PARTITIONED_TABLES = [
  "revenue_events",
  "credit_ledger",
  OUTGOING_WEBHOOKS_TABLE,
] as const;

/**
 * Seconds in an average Gregorian month (365.2425 / 12 days). Months
 * are not a fixed duration, so "months remaining" is a ratio against
 * the average rather than a calendar count — it stays monotonic as the
 * bound approaches, which is what an alert threshold needs. A calendar
 * `age()` truncates and would sit at a flat integer for weeks.
 */
const SECONDS_PER_AVERAGE_MONTH = 2_629_746;

/**
 * POSIX regex pulling the upper bound out of a child's
 * `FOR VALUES FROM ('…') TO ('…')` bound expression. A DEFAULT
 * partition's bound expression is the bare word `DEFAULT`, which
 * matches nothing and so drops out of the `max()` instead of
 * poisoning it. Same pattern as migration 0130 and
 * `parsePartitionBoundExpr` in retention-sweep.ts.
 */
const PARTITION_UPPER_BOUND_PATTERN = "TO \\('(.*?)'\\)";

/** `partman.check_default()` reports the DEFAULT CHILD; the gauges are
 *  labelled by parent so they line up with the premake gauge. */
const PUBLIC_SCHEMA = "public";

/**
 * `ARRAY['a','b']` built from WATCHED_PARTITIONED_TABLES.
 *
 * Interpolated rather than bound because drizzle renders a JS array as a
 * flat list of parameters, not as a Postgres array: `= ANY(${list})`
 * reaches the server as `= ANY($1)` with a scalar bound to it and fails
 * with `op ANY/ALL (array) requires array on right side`. Which it did —
 * the first run of the gauge test published no headroom series at all,
 * because publishPartitionMetrics caught the error and logged it. Every
 * element here is a module constant, never user input.
 */
function watchedTablesArrayLiteral(): string {
  return WATCHED_PARTITIONED_TABLES.map((t) => `'${t}'`).join(", ");
}

// `db.execute<T>` constrains T to Record<string, unknown>; `type` with
// an index signature satisfies it where a plain `interface` does not.
type PremakeRow = {
  table_name: string;
  months_remaining: string | number | null;
};

type DefaultRowsRow = {
  table_name: string;
  default_rows: string | number;
};

async function publishPartitionMetrics(
  db: ReturnType<typeof getDb>,
  partmanRan: boolean,
): Promise<void> {
  partitionMaintenancePartmanRan.set(partmanRan ? 1 : 0);
  try {
    await publishPremakeHeadroom(db);
    await publishDefaultPartitionRows(db, partmanRan);
  } catch (err) {
    // Deliberately swallowed: the partitions are already created by the
    // time we get here, and losing a gauge must not turn a successful
    // maintenance run into a BullMQ retry. Logged at error so the loss
    // of the signal is itself a signal.
    log.error("failed to publish partition metrics", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function publishPremakeHeadroom(
  db: ReturnType<typeof getDb>,
): Promise<void> {
  const rows = await db.execute<PremakeRow>(sql`
    SELECT parent.relname::text AS table_name,
           EXTRACT(EPOCH FROM (
             max((substring(
               pg_get_expr(child.relpartbound, child.oid)
               FROM ${PARTITION_UPPER_BOUND_PATTERN}
             ))::timestamptz) - now()
           )) / ${SECONDS_PER_AVERAGE_MONTH}::float8 AS months_remaining
      FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace pn ON pn.oid = parent.relnamespace
     WHERE pn.nspname = ${PUBLIC_SCHEMA}
       AND parent.relname::text = ANY(ARRAY[${sql.raw(watchedTablesArrayLiteral())}])
     GROUP BY parent.relname
  `);

  // Cleared first so a table that stops being partitioned stops
  // reporting stale headroom instead of freezing at its last value.
  partitionPremakeMonthsRemaining.reset();
  for (const row of rows.rows) {
    if (row.months_remaining === null) continue;
    partitionPremakeMonthsRemaining.set(
      { table: row.table_name },
      Number(row.months_remaining),
    );
  }
  log.debug("published partition premake headroom", {
    tables: rows.rows.length,
  });
}

async function publishDefaultPartitionRows(
  db: ReturnType<typeof getDb>,
  partmanRan: boolean,
): Promise<void> {
  partitionDefaultRows.reset();
  if (!partmanRan) {
    // check_default() lives in the partman schema. Without it there is
    // nothing to report — and leaving the gauge absent rather than
    // asserting 0 is the honest encoding of "not measured".
    return;
  }

  // `check_default()` only RETURNs NEXT for parents whose default child
  // has at least one row, so a healthy set produces zero rows. Seed
  // every watched table at 0 first: a gauge that only ever appears when
  // something is wrong is indistinguishable from a gauge that is broken.
  for (const table of WATCHED_PARTITIONED_TABLES) {
    partitionDefaultRows.set({ table }, 0);
  }

  const rows = await db.execute<DefaultRowsRow>(sql`
    SELECT parent.relname::text AS table_name,
           d."count"            AS default_rows
      FROM partman.check_default() d
      JOIN pg_class def       ON def.oid = d.default_table::regclass
      JOIN pg_inherits i      ON i.inhrelid = def.oid
      JOIN pg_class parent    ON parent.oid = i.inhparent
      JOIN pg_namespace pn    ON pn.oid = parent.relnamespace
     WHERE pn.nspname = ${PUBLIC_SCHEMA}
  `);

  for (const row of rows.rows) {
    const stranded = Number(row.default_rows);
    partitionDefaultRows.set({ table: row.table_name }, stranded);
    // Not recoverable by any automated path: the row permanently
    // blocks attaching that period's real partition.
    log.error("rows stranded in a DEFAULT partition", {
      table: row.table_name,
      rows: stranded,
    });
  }
}

// Partition bounds are inlined rather than bound (see below), so the
// value is checked against the exact shape Date#toISOString() emits
// before it ever reaches the statement. Anything else is a bug in the
// caller, not a value to escape.
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertIsoTimestamp(value: string): string {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(
      `partition-maintenance: refusing to inline a non-ISO timestamp: ${value}`,
    );
  }
  return value;
}

async function createOutgoingWebhooksPartition(): Promise<number> {
  const db = getDb();
  // Look 13 months ahead so we always have premake headroom even if
  // the worker misses a run. Idempotent CREATE TABLE IF NOT EXISTS.
  const now = new Date();
  let created = 0;
  for (
    let monthsAhead = 0;
    monthsAhead < OUTGOING_WEBHOOKS_MONTHS_AHEAD;
    monthsAhead++
  ) {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + monthsAhead,
        1,
      ),
    );
    const end = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth() + 1,
        1,
      ),
    );
    const yyyy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
    const partition = `${OUTGOING_WEBHOOKS_TABLE}_${yyyy}_${mm}`;
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    // CREATE TABLE IF NOT EXISTS ... PARTITION OF is supported on
    // PG 11+; the IF NOT EXISTS clause makes this idempotent.
    //
    // Partition bounds must be CONSTANTS. Interpolating them through
    // drizzle's `sql` tag binds them as $1/$2, which Postgres rejects
    // at PARSE time — before IF NOT EXISTS can short-circuit — so the
    // original form threw on the very first loop iteration whether or
    // not the partition already existed. That is why this worker had
    // never once completed. The values are machine-generated from
    // Date#toISOString(), never user input, and are asserted below
    // before being inlined.
    const result = await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${partition}"`)}
        PARTITION OF ${sql.raw(`"${OUTGOING_WEBHOOKS_TABLE}"`)}
        FOR VALUES FROM (${sql.raw(`'${assertIsoTimestamp(startIso)}'`)})
                     TO (${sql.raw(`'${assertIsoTimestamp(endIso)}'`)})
    `);
    // node-postgres CREATE TABLE returns command without rowCount;
    // count "created" loosely — log per partition for ops audit.
    log.debug("ensured outgoing_webhooks partition", {
      partition,
      from: startIso,
      to: endIso,
    });
    void result;
    created++;
  }
  return created;
}

let cachedQueue: Queue | undefined;

export function getPartitionMaintenanceQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(PARTITION_MAINTENANCE_QUEUE_NAME, {
    connection: createBullConnection("partition-maintenance"),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 30 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Schedule via cron-style pattern so it lands at 03:00 UTC daily.
 * BullMQ uses the `pattern` field for cron expressions.
 */
export async function schedulePartitionMaintenance(): Promise<void> {
  const queue = getPartitionMaintenanceQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: {
        pattern: `0 ${TARGET_HOUR_UTC} * * *`,
        tz: "UTC",
      },
    },
  );
  log.info("scheduled partition maintenance", {
    cron: `0 ${TARGET_HOUR_UTC} * * *`,
    tz: "UTC",
  });
}

let cachedWorker: Worker | undefined;

export function createPartitionMaintenanceWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    PARTITION_MAINTENANCE_QUEUE_NAME,
    async (_job: Job) => runPartitionMaintenance(),
    {
      connection: createBullConnection("partition-maintenance"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("partition maintenance job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });
  cachedWorker.on("completed", (job) => {
    log.debug("partition maintenance job completed", { jobId: job.id });
  });

  // Suppress unused warning while we keep both helpers exported.
  void drizzle;

  log.info("partition maintenance worker started", {
    queue: PARTITION_MAINTENANCE_QUEUE_NAME,
  });
  return cachedWorker;
}
