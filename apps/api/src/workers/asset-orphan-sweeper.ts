import { sql } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { ASSET_ORPHAN_GRACE_HOURS } from "@rovenue/shared";
import { env } from "../lib/env";
import * as store from "../lib/asset-store";
import { logger } from "../lib/logger";

// =============================================================
// asset-orphan-sweeper
// =============================================================
//
// The other half of "never put an S3 write inside a transaction"
// (design spec §5.8). Creating writes the object first and commits the
// row second; if the commit fails, the object is orphaned. Deleting
// tombstones the row first and deletes the object second; if the object
// delete fails, the object is orphaned. Both land here.
//
// The grace window is not a tuning knob — it is correctness. An upload
// that has put its object but not yet committed its row is
// INDISTINGUISHABLE from an orphan, so sweeping without a window
// destroys live uploads.
//
// Runs ONLY in the dedicated `dispatcher` docker-compose service (wired
// in outbox-dispatcher-process.ts), never in the `api` service, which
// scales to N replicas via API_REPLICAS. Unlike the BullMQ-jobId
// idempotency that makes the *other* maintenance workers safe to run
// in every replica, this one's actual work — listing the whole bucket
// and deleting keys — happens outside any per-job lock, so N replicas
// would each list the whole bucket and race to delete the same keys:
// wasteful, and a source of spurious "object already deleted" errors.

const log = logger.child("asset-orphan-sweeper");

const MS_PER_HOUR = 60 * 60 * 1000;

export interface AssetSweepResult {
  reclaimed: number;
}

/**
 * `now` defaults to the real clock but is accepted explicitly so tests
 * can assert grace-window behavior without depending on a real S3
 * object's `LastModified` being backdatable (it isn't).
 */
export async function sweepOrphanedAssets(
  now: Date = new Date(),
): Promise<AssetSweepResult> {
  if (!store.isStorageConfigured()) return { reclaimed: 0 };

  const cutoff = new Date(now.getTime() - ASSET_ORPHAN_GRACE_HOURS * MS_PER_HOUR);

  const liveKeys = new Set(
    (
      await drizzle.db.execute(sql`
        SELECT "paywall_assets"."storageKey" AS "storageKey"
        FROM "paywall_assets"
        WHERE "paywall_assets"."deletedAt" IS NULL
      `)
    ).rows.map((r) => (r as { storageKey: string }).storageKey),
  );

  const allKeys = await store.listAllKeys();
  let reclaimed = 0;
  for (const key of allKeys) {
    if (liveKeys.has(key)) continue;
    // Age comes from the object's own LastModified, not the DB — an
    // orphan by definition may have no row to read a timestamp from.
    // A null age (HeadObject came back NotFound) is NOT proof the
    // object is gone — read-after-write lag or a transient S3 error can
    // surface as NotFound while the object still exists and may be
    // live. "Could not confirm this object's age" must resolve to
    // "leave it alone", not "delete it": skipping costs one more sweep
    // cycle of retained bytes; deleting wrongly costs a published
    // paywall's asset.
    const lastModified = await store.getObjectLastModified(key);
    if (lastModified === null || lastModified > cutoff) continue;
    await store.deleteObject(key);
    reclaimed += 1;
  }

  // A reservation whose upload died before committing would otherwise
  // hold its bytes against the project's storage cap forever.
  await drizzle.db.execute(sql`
    DELETE FROM "paywall_asset_reservations"
    WHERE "paywall_asset_reservations"."createdAt" < ${cutoff}
  `);

  log.info("asset orphan sweep complete", { reclaimed });
  return { reclaimed };
}

// =============================================================
// BullMQ queue + worker + scheduling
//
// Same shape as workers/usage-cap-sweeper.ts: a daily repeatable job,
// jobId-idempotent registration, concurrency 1.
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

export const ASSET_ORPHAN_SWEEP_QUEUE_NAME = "rovenue-asset-orphan-sweep";
const REPEATABLE_JOB_NAME = "asset-orphan:sweep";
const REPEATABLE_JOB_ID = "asset-orphan:sweep:repeatable";
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000;

let cachedQueue: Queue | undefined;

export function getAssetOrphanSweepQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(ASSET_ORPHAN_SWEEP_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the daily repeatable job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleAssetOrphanSweep(): Promise<void> {
  const queue = getAssetOrphanSweepQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("asset orphan sweep repeatable job registered", {
    everyMs: REPEAT_EVERY_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createAssetOrphanSweeperWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    ASSET_ORPHAN_SWEEP_QUEUE_NAME,
    async (_job: Job) => {
      return sweepOrphanedAssets();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("asset orphan sweep job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}
