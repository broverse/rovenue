import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { importJobs, type ImportJob, type NewImportJob } from "../schema";
import { importJobStatus } from "../enums";

// =============================================================
// import_jobs repository
// =============================================================
//
// One row per operator-initiated bulk history import (RevenueCat first).
// Row-level per-record outcomes are NOT stored here — they stream to a
// report file in object storage (`reportStorageKey`); this table holds
// only aggregate `counters`. See packages/shared/src/import/ (Tasks 1-3)
// for the pure parsing/mapping core this persistence layer sits behind.

export type ImportJobStatus = (typeof importJobStatus.enumValues)[number];

// ---------------------------------------------------------------------------
// createImportJob
// ---------------------------------------------------------------------------

export async function createImportJob(
  db: Db,
  values: NewImportJob,
): Promise<ImportJob> {
  const [row] = await db.insert(importJobs).values(values).returning();
  if (!row) throw new Error("createImportJob: no row returned");
  return row;
}

// ---------------------------------------------------------------------------
// getImportJob — project-scoped lookup by id
// ---------------------------------------------------------------------------

export async function getImportJob(
  db: Db,
  projectId: string,
  id: string,
): Promise<ImportJob | null> {
  const rows = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.projectId, projectId), eq(importJobs.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// getImportJobById — plain lookup by the cuid2 id alone
// ---------------------------------------------------------------------------
//
// Not project-scoped, matching integration-deliveries.ts's `getDeliveryById`
// precedent: `id` is already a full, unguessable scope on its own, and the
// dry-run planner / writer are internal job processors that only ever have
// the jobId (picked up from `import_jobs` itself, not from a caller-supplied
// URL param that would need tenant-membership re-checking).

export async function getImportJobById(
  db: Db,
  id: string,
): Promise<ImportJob | null> {
  const rows = await db.select().from(importJobs).where(eq(importJobs.id, id));
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listImportJobs — project-scoped, newest first
// ---------------------------------------------------------------------------

export interface ListImportJobsOptions {
  limit?: number;
}

export async function listImportJobs(
  db: Db,
  projectId: string,
  options: ListImportJobsOptions = {},
): Promise<ImportJob[]> {
  const query = db
    .select()
    .from(importJobs)
    .where(eq(importJobs.projectId, projectId))
    .orderBy(desc(importJobs.createdAt));
  if (options.limit !== undefined) {
    return query.limit(options.limit);
  }
  return query;
}

// ---------------------------------------------------------------------------
// updateImportJobMapping
// ---------------------------------------------------------------------------
//
// `mapping` is the operator-confirmed column mapping produced by the
// dashboard's mapping step. `sourceLabel` stays untouched — it is a
// free-text label the operator chose at upload time, never schema.

export async function updateImportJobMapping(
  db: Db,
  projectId: string,
  id: string,
  mapping: Record<string, unknown>,
): Promise<ImportJob> {
  const [row] = await db
    .update(importJobs)
    .set({ mapping, updatedAt: new Date() })
    .where(and(eq(importJobs.projectId, projectId), eq(importJobs.id, id)))
    .returning();
  if (!row) throw new Error(`updateImportJobMapping: id=${id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// setImportJobStatus
// ---------------------------------------------------------------------------

export interface SetImportJobStatusInput {
  status: ImportJobStatus;
  errorMessage?: string | null;
  reportStorageKey?: string | null;
  /** Cumulative count of Phase-A writer report PARTS written so far
   *  (Task 8 fix round 1, FIX 5) — see `import-runner.ts`'s
   *  `ensureReportWriter`. Distinct from `reportStorageKey`, which stays
   *  the dry-run planner's single report object. */
  reportPartCount?: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export async function setImportJobStatus(
  db: Db,
  projectId: string,
  id: string,
  input: SetImportJobStatusInput,
): Promise<ImportJob> {
  const patch: Partial<NewImportJob> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
  if (input.reportStorageKey !== undefined) {
    patch.reportStorageKey = input.reportStorageKey;
  }
  if (input.reportPartCount !== undefined) {
    patch.reportPartCount = input.reportPartCount;
  }
  if (input.startedAt !== undefined) patch.startedAt = input.startedAt;
  if (input.finishedAt !== undefined) patch.finishedAt = input.finishedAt;

  const [row] = await db
    .update(importJobs)
    .set(patch)
    .where(and(eq(importJobs.projectId, projectId), eq(importJobs.id, id)))
    .returning();
  if (!row) throw new Error(`setImportJobStatus: id=${id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// saveImportJobCheckpoint
// ---------------------------------------------------------------------------
//
// `checkpointLine` is what lets a crashed/restarted worker (Task 8) resume
// instead of re-processing already-imported rows. The WHERE clause enforces
// monotonicity atomically at the database — a write for a line at or below
// the stored value is a silent no-op (the row's current, higher checkpoint
// is returned unchanged) instead of ever regressing it, which would
// silently re-import rows.

export async function saveImportJobCheckpoint(
  db: Db,
  projectId: string,
  id: string,
  checkpointLine: number,
): Promise<ImportJob> {
  const [row] = await db
    .update(importJobs)
    .set({ checkpointLine, updatedAt: new Date() })
    .where(
      and(
        eq(importJobs.projectId, projectId),
        eq(importJobs.id, id),
        sql`${importJobs.checkpointLine} < ${checkpointLine}`,
      ),
    )
    .returning();
  if (row) return row;

  const existing = await getImportJob(db, projectId, id);
  if (!existing) throw new Error(`saveImportJobCheckpoint: id=${id} not found`);
  return existing;
}

// ---------------------------------------------------------------------------
// incrementImportJobCounters
// ---------------------------------------------------------------------------
//
// Additive increments into the `counters` jsonb object — one key per
// outcome bucket (bucket list owned by Task 6). Never overwrites the
// object wholesale, so concurrent increments from different keys (or
// repeated increments of the same key) always accumulate.

export async function incrementImportJobCounters(
  db: Db,
  projectId: string,
  id: string,
  deltas: Record<string, number>,
): Promise<ImportJob> {
  const entries = Object.entries(deltas);
  if (entries.length === 0) {
    const existing = await getImportJob(db, projectId, id);
    if (!existing) {
      throw new Error(`incrementImportJobCounters: id=${id} not found`);
    }
    return existing;
  }

  const pairs = sql.join(
    entries.map(
      ([key, delta]) =>
        sql`${key}::text, COALESCE((${importJobs.counters}->>${key}::text)::bigint, 0) + ${delta}::bigint`,
    ),
    sql`, `,
  );

  const [row] = await db
    .update(importJobs)
    .set({
      counters: sql`${importJobs.counters} || jsonb_build_object(${pairs})`,
      updatedAt: new Date(),
    })
    .where(and(eq(importJobs.projectId, projectId), eq(importJobs.id, id)))
    .returning();
  if (!row) throw new Error(`incrementImportJobCounters: id=${id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// setImportJobCounters — OVERWRITE, not additive
// ---------------------------------------------------------------------------
//
// Task 9 fix round 1, FIX 6: Phase B's `verifyAnchorNotFound` and
// `verifyAnchorPending` counts are NOT checkpointed the way
// `verifyAnchorVerified` is (a not-found or still-throttled anchor never
// gets `purchases.verifiedAt` set — that is the whole point of rule 1: it
// must look exactly like an unverified imported row). So every resumed
// `verifyImportedAnchors` call rediscovers the SAME not-found/pending
// anchors from scratch — additively incrementing those two keys would
// inflate them without bound across resumes, and Task 10/11 surface these
// numbers to the operator. This sets specific keys to the CALLER-SUPPLIED
// value (this call's fresh, complete count), leaving every other key in
// the jsonb object — including `verifyAnchorVerified` and every Phase-A
// outcome bucket — untouched.

export async function setImportJobCounters(
  db: Db,
  projectId: string,
  id: string,
  values: Record<string, number>,
): Promise<ImportJob> {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    const existing = await getImportJob(db, projectId, id);
    if (!existing) {
      throw new Error(`setImportJobCounters: id=${id} not found`);
    }
    return existing;
  }

  const pairs = sql.join(
    entries.map(([key, value]) => sql`${key}::text, ${value}::bigint`),
    sql`, `,
  );

  const [row] = await db
    .update(importJobs)
    .set({
      counters: sql`${importJobs.counters} || jsonb_build_object(${pairs})`,
      updatedAt: new Date(),
    })
    .where(and(eq(importJobs.projectId, projectId), eq(importJobs.id, id)))
    .returning();
  if (!row) throw new Error(`setImportJobCounters: id=${id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// listImportJobsEligibleForFileRetention
// ---------------------------------------------------------------------------
//
// Task 8's retention sweep (IMPORT_FILE_RETENTION_DAYS): the uploaded
// source file and its report artefact are end-user PII sitting in object
// storage, so once a job is DONE (terminal) and has been for longer than
// the retention window, its files are deleted. A job that is still
// RUNNING (or hasn't started) is never eligible regardless of age — the
// worker is the only writer of `finishedAt`, so a null value here is a
// reliable signal the job isn't finished yet, not a data gap to guess
// around.

// Task 9 fix round 1, FIX 7 (deliberate, not an oversight):
// `VERIFICATION_INCOMPLETE` is NOT in this list. A job left there is
// resumable — a later `verifyImportedAnchors` call can still finish
// Phase B — and that resume needs to re-read the job's SOURCE FILE
// (the Google purchase token lives nowhere else; see
// services/import/verify.ts). Sweeping a `VERIFICATION_INCOMPLETE`
// job's file the same way as a truly terminal one would delete the one
// copy of that data and strand the job incomplete forever. Only once a
// resumed Phase B call moves the job to COMPLETED does it become
// eligible here.
const TERMINAL_IMPORT_JOB_STATUSES: readonly ImportJobStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export interface RetentionEligibleImportJob {
  id: string;
  projectId: string;
  storageKey: string;
  reportStorageKey: string | null;
  reportPartCount: number;
}

// `filesDeletedAt IS NULL` (fix round 1, FIX 3) excludes a job the sweep
// already handled — without it, a terminal job past the window matches
// this query FOREVER, so every nightly run re-selects the entire history
// of swept jobs and re-issues (harmless but wasted) `deleteObject` calls
// against objects that no longer exist. Paired with
// `import_jobs_status_finished_at_idx` (status, finishedAt) so this is an
// index scan, not a full table scan, as the table grows.
export async function listImportJobsEligibleForFileRetention(
  db: Db,
  cutoff: Date,
): Promise<RetentionEligibleImportJob[]> {
  return db
    .select({
      id: importJobs.id,
      projectId: importJobs.projectId,
      storageKey: importJobs.storageKey,
      reportStorageKey: importJobs.reportStorageKey,
      reportPartCount: importJobs.reportPartCount,
    })
    .from(importJobs)
    .where(
      and(
        inArray(importJobs.status, TERMINAL_IMPORT_JOB_STATUSES),
        sql`${importJobs.finishedAt} IS NOT NULL AND ${importJobs.finishedAt} < ${cutoff}`,
        sql`${importJobs.filesDeletedAt} IS NULL`,
      ),
    );
}

// ---------------------------------------------------------------------------
// markImportJobFilesDeleted
// ---------------------------------------------------------------------------
//
// Called by the retention sweep once it has deleted a job's uploaded
// file, dry-run report and every report part — excludes the job from
// `listImportJobsEligibleForFileRetention` on every future run. Not
// project-scoped, matching `getImportJobById`'s precedent: the sweep is
// an internal worker process with the id already in hand, not a
// caller-supplied URL param.

export async function markImportJobFilesDeleted(
  db: Db,
  id: string,
  deletedAt: Date,
): Promise<void> {
  await db
    .update(importJobs)
    .set({ filesDeletedAt: deletedAt, updatedAt: new Date() })
    .where(eq(importJobs.id, id));
}
