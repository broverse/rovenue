import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { sql } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

// =============================================================
// Partition maintenance worker (Plan 3 §F.3)
// =============================================================
//
// Runs daily at 03:00 UTC. Two jobs:
//
//   1. `SELECT partman.run_maintenance_proc()` — pg_partman creates
//      premake-window partitions and drops retention-aged partitions
//      across `revenue_events` and `credit_ledger` (registered by
//      migration 0019).
//
//   2. Manually pre-create the next-month partition for
//      `outgoing_webhooks`. That table is intentionally NOT
//      pg_partman-managed because its retention predicate is
//      composite (status + age) — the existing webhook-retention
//      worker handles row-level deletion. Without this manual step
//      the table would refuse rows for any month past 2028-12 (the
//      end of the bulk-created window in migration 0017).
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

export interface PartitionMaintenanceResult {
  partmanRan: boolean;
  manualPartitionsCreated: number;
}

export async function runPartitionMaintenance(): Promise<PartitionMaintenanceResult> {
  const db = getDb();

  // pg_partman handles revenue_events + credit_ledger (premake &
  // retention) — but ONLY on databases that actually ran migration
  // 0019. A fresh-install database never does: `fresh-install.ts`
  // marks the TimescaleDB-era migrations applied-without-executing,
  // and 0019 falls in that range. So self-hosted installs, CI and the
  // test databases have no `partman` schema at all, and calling
  // run_maintenance_proc() there throws before this worker reaches
  // the outgoing_webhooks step below. Skip it when absent rather than
  // failing the whole run — the hand-rolled partitions are exactly
  // what those databases depend on.
  const partmanRan = await runPartmanMaintenanceIfInstalled(db);

  // Hand-roll the next-month partition for outgoing_webhooks. This
  // is idempotent — `IF NOT EXISTS` guards re-runs.
  const manualPartitionsCreated = await createOutgoingWebhooksPartition();

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
    log.info("partman schema absent — skipping run_maintenance_proc", {
      reason: "migration 0019 does not execute on fresh-install databases",
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
  for (let monthsAhead = 0; monthsAhead < 13; monthsAhead++) {
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
    const partition = `outgoing_webhooks_${yyyy}_${mm}`;
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
        PARTITION OF "outgoing_webhooks"
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
