import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { drizzle } from "@rovenue/db";
import {
  findRetentionPolicy,
  resolveProjectPolicyWindowDays,
  RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
} from "@rovenue/shared/retention";
import * as importStore from "../lib/import-store";
import { logger } from "../lib/logger";

// Deliberately imports resolveProjectPolicyWindowDays from
// @rovenue/shared/retention directly, NOT from ./retention-sweep (which
// re-exports it for backward compatibility) — retention-sweep.ts pulls
// in ../lib/audit, metrics, and BullMQ Queue/Worker wiring that this
// worker has no reason to load just to resolve a window.

// =============================================================
// import_jobs file retention sweeper (Task 8, controller Ruling 7;
// ROADMAP §9.2 Task 6)
// =============================================================
//
// Uploaded import files (and their generated NDJSON reports) are
// end-user PII — a customer's RevenueCat/Adapty export — sitting in the
// dedicated private import bucket (lib/import-store.ts). Until this
// worker existed, `IMPORT_FILE_RETENTION_DAYS` was a promise with no
// mechanism: nothing ever deleted them.
//
// KEPT, not folded into the generic registry-driven sweep
// (workers/retention-sweep.ts), and that is deliberate: this worker
// deletes object-storage FILES alongside the `import_jobs` row and
// tracks that with the `filesDeletedAt` column so a re-run cannot
// re-select the same job. Folding that into the generic sweep would
// either lose that idempotency guard or push storage semantics into
// every policy. `import_jobs` DOES carry a registry entry
// (`@rovenue/shared/retention`, strategy `EXTERNAL_WORKER`) — that
// entry exists purely so this worker's WINDOW is resolved by the exact
// same tier+override+floor rules (`resolveProjectPolicyWindowDays`)
// every other table uses, not so the generic sweep acts on it. Do not
// "finish the job" by giving `import_jobs` a DELETE_ROWS/DROP_PARTITION
// strategy or by moving its deletion into runRetentionSweep — either
// would delete rows while leaving their files behind.
//
// Before this task, every project's import files were deleted after a
// single hardcoded `IMPORT_FILE_RETENTION_DAYS` (7) regardless of
// billing tier or self-host status. Under the registry's general rule
// a project with no tier and no override for "import_jobs" now resolves
// NO window and keeps its files indefinitely — the same "unconfigured
// means keep everything, self-host opts in via an override" rule every
// other table follows — and a tiered project's window can now run well
// past 7 days, up to that tier's own `retentionDays`. See the retention
// guide (apps/docs/content/docs/guides/retention-policies.mdx) for the
// full explanation; this is a real behaviour change from before Task 6,
// not merely a refactor.

const log = logger.child("import-retention");

export const IMPORT_RETENTION_QUEUE_NAME = "rovenue-import-retention";

const IMPORT_JOBS_TABLE = "import_jobs";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000; // nightly
const REPEATABLE_JOB_NAME = "import:retention";
const REPEATABLE_JOB_ID = "import-retention-repeatable";

// Fix round 1, FIX 6: hoisted out of getImportRetentionQueue's inline
// object literal, matching this file's own RETENTION_WINDOW_MS /
// REPEAT_EVERY_MS convention.
const JOB_RETENTION_KEEP_COUNT = 30;
const FAILED_JOB_RETENTION_KEEP_COUNT = 100;
const JOB_RETENTION_KEEP_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface ImportRetentionResult {
  /** Number of import_jobs rows whose files were swept this run. */
  deletedJobs: number;
  /** Number of individual objects deleted (source file + the dry-run
   *  report, when the job has one, + every Phase-A writer report part). */
  deletedFiles: number;
  /** Number of projects this run could not resolve a window for
   *  (no tier and no override) — their jobs are left untouched. */
  projectsSkipped: number;
  cutoff: string; // ISO8601 of the loosest cutoff used, for log inspection
}

export async function runImportRetention(
  now: Date = new Date(),
): Promise<ImportRetentionResult> {
  const policy = findRetentionPolicy(IMPORT_JOBS_TABLE);
  if (!policy) {
    // A registry entry with this table name is a compile-time fact this
    // module depends on — its absence means the registry drifted out
    // from under this worker, not an ordinary runtime condition to
    // degrade gracefully from.
    throw new Error(
      `import-retention: no retention policy registered for "${IMPORT_JOBS_TABLE}"`,
    );
  }

  const projects = await drizzle.billingSubscriptionRepo.listProjectsWithTier(
    drizzle.db,
  );

  // Resolve every project's own window for import_jobs, exactly the way
  // workers/retention-sweep.ts resolves every other table's: tier window
  // (if any), clamped down by an override, floored at the policy's
  // minimum. A project this run cannot resolve a window for (no tier,
  // no override) is skipped entirely — its files are left in place, not
  // defaulted to the old fixed 7-day constant, matching the fleet-wide
  // rule that "unconfigured" must read as "keep everything."
  const projectWindows = new Map<string, number>();
  let minResolvedDays: number | null = null;
  let projectsSkipped = 0;

  for (const project of projects) {
    const hasTier = Boolean(project.tier && project.cycle);
    try {
      const overrides =
        await drizzle.retentionOverrideRepo.listRetentionOverrides(
          drizzle.db,
          project.projectId,
        );
      const tierLimits = hasTier
        ? await drizzle.billingTierLimitsRepo.findByTierAndCycle(
            drizzle.db,
            project.tier!,
            project.cycle!,
          )
        : null;

      const resolution = resolveProjectPolicyWindowDays(
        policy,
        hasTier,
        tierLimits,
        overrides.get(IMPORT_JOBS_TABLE),
      );

      if (resolution.kind === "skip") {
        projectsSkipped += 1;
        if (resolution.reason === RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND) {
          log.warn(
            "billing_tier_limits has no row for this project's tier/cycle; skipping import file retention",
            { projectId: project.projectId, tier: project.tier, cycle: project.cycle },
          );
        }
        continue;
      }

      projectWindows.set(project.projectId, resolution.days);
      minResolvedDays =
        minResolvedDays === null
          ? resolution.days
          : Math.min(minResolvedDays, resolution.days);
    } catch (err) {
      projectsSkipped += 1;
      log.error("import retention failed to resolve a project's window", {
        projectId: project.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (minResolvedDays === null) {
    // No project resolved a window this run — nothing to sweep. Every
    // project's files are left exactly where they are.
    log.info(
      "import file retention sweep: no project resolved a window, nothing to sweep",
      { projectsSkipped },
    );
    return {
      deletedJobs: 0,
      deletedFiles: 0,
      projectsSkipped,
      cutoff: now.toISOString(),
    };
  }

  // The loosest possible cutoff across the fleet — the earliest a job
  // COULD be eligible under any project's own (shortest) resolved
  // window. Fetching once with this bound and re-checking each row
  // against its OWN project's resolved window below avoids an N+1
  // eligibility query per project.
  const looseCutoff = new Date(now.getTime() - minResolvedDays * MS_PER_DAY);
  const jobs = await drizzle.importJobRepo.listImportJobsEligibleForFileRetention(
    drizzle.db,
    looseCutoff,
  );

  let deletedJobs = 0;
  let deletedFiles = 0;

  for (const job of jobs) {
    const days = projectWindows.get(job.projectId);
    // This project's window is unresolved this run (no-window, or its
    // window-resolution attempt errored above) — leave its files alone
    // rather than falling back to the loosest bound, which belongs to
    // some OTHER project.
    if (days === undefined) continue;
    // Belt and braces: the eligibility query already requires
    // `finishedAt IS NOT NULL`, but this loop re-derives eligibility
    // per project from the raw column rather than trusting that.
    if (job.finishedAt === null) continue;

    const projectCutoff = new Date(now.getTime() - days * MS_PER_DAY);
    if (job.finishedAt >= projectCutoff) continue; // not old enough under THIS project's own window yet

    await importStore.deleteObject(job.storageKey);
    deletedFiles += 1;
    if (job.reportStorageKey) {
      await importStore.deleteObject(job.reportStorageKey);
      deletedFiles += 1;
    }
    // Fix round 1, FIX 5: the Phase-A writer's report is one or more
    // numbered PARTS, not the single `reportStorageKey` object above —
    // every part this job ever wrote needs its own delete call.
    for (let partNumber = 1; partNumber <= job.reportPartCount; partNumber++) {
      await importStore.deleteObject(
        importStore.buildReportPartStorageKey(job.projectId, job.id, partNumber),
      );
      deletedFiles += 1;
    }
    // Fix round 1, FIX 3: mark this job's files handled so it drops out
    // of `listImportJobsEligibleForFileRetention` on every future run —
    // without this, the eligible set only ever grows.
    await drizzle.importJobRepo.markImportJobFilesDeleted(drizzle.db, job.id, now);
    deletedJobs += 1;
  }

  log.info("import file retention sweep complete", {
    deletedJobs,
    deletedFiles,
    projectsWithWindow: projectWindows.size,
    projectsSkipped,
    minResolvedDays,
    looseCutoff: looseCutoff.toISOString(),
  });
  return {
    deletedJobs,
    deletedFiles,
    projectsSkipped,
    cutoff: looseCutoff.toISOString(),
  };
}

let cachedQueue: Queue | undefined;

export function getImportRetentionQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(IMPORT_RETENTION_QUEUE_NAME, {
    connection: createBullConnection("import-retention"),
    defaultJobOptions: {
      removeOnComplete: {
        count: JOB_RETENTION_KEEP_COUNT,
        age: JOB_RETENTION_KEEP_AGE_SECONDS,
      },
      removeOnFail: {
        count: FAILED_JOB_RETENTION_KEEP_COUNT,
        age: JOB_RETENTION_KEEP_AGE_SECONDS,
      },
    },
  });
  return cachedQueue;
}

/**
 * Register the nightly repeatable job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleImportRetention(): Promise<void> {
  const queue = getImportRetentionQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled import file retention", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createImportRetentionWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    IMPORT_RETENTION_QUEUE_NAME,
    async (_job: Job) => {
      return runImportRetention();
    },
    {
      connection: createBullConnection("import-retention"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("import retention job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("import retention job completed", { jobId: job.id });
  });

  log.info("import retention worker started", {
    queue: IMPORT_RETENTION_QUEUE_NAME,
  });
  return cachedWorker;
}

/**
 * Single entry point for boot wiring: creates the worker and, unless
 * `autoStart` is explicitly false, registers the repeatable job.
 * Follows the same convention as `ensureLeaderboardScheduler`
 * (workers/leaderboard-scheduler.ts).
 */
export function ensureImportRetention(opts: { autoStart?: boolean } = {}): void {
  createImportRetentionWorker();
  if (opts.autoStart === false) return;

  scheduleImportRetention().catch((err: unknown) => {
    log.error("failed to schedule import retention", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
