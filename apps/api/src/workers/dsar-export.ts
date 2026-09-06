import { Worker, type Job } from "bullmq";
import { HTTPException } from "hono/http-exception";
import { drizzle, type Db } from "@rovenue/db";
import { createBullConnection } from "../lib/redis";
import { logger } from "../lib/logger";
import { audit, type AuditEntry, type AuditTx } from "../lib/audit";
import { dsarExportCompletedTotal, dsarExportSkippedTotal } from "../lib/metrics";
import * as importStore from "../lib/import-store";
import {
  exportSubscriber,
  SUBSCRIBER_ERASED_STATUS,
  type SubscriberExport,
} from "../services/gdpr/export-subscriber";
import {
  DSAR_EXPORT_QUEUE_NAME,
  DSAR_EXPORT_JOB_NAME,
  type DsarJobData,
} from "../queues/dsar";

// =============================================================
// DSAR export worker (ROADMAP §9.1, Task 4)
// =============================================================
//
// Consumes `DSAR_EXPORT_QUEUE_NAME` (see queues/dsar.ts for why export
// and erasure now sit on two separate queues, not one). One job = one
// `dsar_requests` EXPORT row.
//
// Ordering, which is the entire point of this file:
//
//   1. Claim the row: conditional UPDATE PENDING -> RUNNING
//      (`claimDsarRequest`). A null result means another replica (or a
//      BullMQ retry racing a still-running earlier attempt) already has
//      it — that is NOT an error, it's the guard doing its job, so this
//      run no-ops rather than producing a second artifact.
//   2. Run the export (`exportSubscriber`) — a pure read, nothing
//      committed yet.
//   3. Write the artifact to storage and let the write's own promise
//      resolve fully before doing anything else — `putObject` uses
//      `@aws-sdk/lib-storage`'s `Upload`, which drives multipart itself
//      and does not resolve until the object is fully committed
//      server-side, so awaiting it to completion IS the confirmation.
//      Nothing about the request row is touched until this has
//      resolved.
//   4. ONLY THEN mark the row COMPLETED with the artifact's key and its
//      expiry. A customer who is told an export is ready must never
//      find nothing there — see the red-check in this worker's test
//      file, which moves this write to AFTER step 4 and shows the
//      "writes before marking COMPLETED" test catching it.
//
// A failure at any step marks the row FAILED with the error and never
// leaves it RUNNING forever — every exit out of the try block below
// goes through either the COMPLETED path or the FAILED path, never past
// the catch with the row still RUNNING. If the artifact was already
// written by the time something later fails (e.g. the COMPLETED update
// itself throws), the catch block deletes that now-orphaned object
// before marking FAILED — this bucket has no retention sweep that could
// ever reach a `dsar-exports/` key (import-retention.ts only deletes
// keys read off `import_jobs` rows), so leaving it behind would leak a
// PII export with no request row pointing at it, forever.
//
// Fails CLOSED when the subject has been erased in the meantime (Finding
// 2, roadmap-9a final fix wave): `exportSubscriber` itself checks the
// subscriber's `deletedAt` and throws before reading `purchases` /
// `subscriberAccess` / `creditLedger` — none of which `anonymizeSubscriber`
// ever touches, so a subscriberId that outlives erasure still has its
// full history sitting under it. This closes the EXPORT/ERASURE race the
// unique index alone cannot prevent (EXPORT and ERASURE are two different
// `type`s, so both can be open on this subject at once, on two
// independent queues): a job claimed before erasure completes but that
// finishes reading data after it now fails instead of manufacturing a
// fresh artifact full of exactly what the subject asked to have
// forgotten. See `SKIP_REASON_SUBSCRIBER_ERASED` below — this is an
// EXPECTED interlock outcome, not treated as a generic worker failure.
// A brand-new request for an already-erased subject never reaches this
// worker at all: `resolveSubscriber` (routes/v1/dsar.ts) 404s at request
// time, because a soft-deleted row with no live `mergedInto` survivor
// resolves to nothing.
//
// Fails CLOSED when storage is unconfigured: `isStorageConfigured()` is
// checked for real (never mocked into always-true), and a false result
// marks the row FAILED with a clear error rather than silently
// "succeeding" with a phantom artifact key. A customer told their
// export is ready who then finds nothing has been misinformed about a
// legal obligation.
//
// Every state change the row goes through is audited: PENDING -> RUNNING
// on claim, then RUNNING -> COMPLETED or RUNNING -> FAILED on the
// terminal outcome. This is separate from (and in addition to)
// `exportSubscriber`'s own "subscriber.exported" audit row, which
// records the underlying data read, not the request record's lifecycle.
//
// Modeled on workers/leaderboard-scheduler.ts: a `Deps` interface with
// `defaultDeps`, a pure injectable entry point (`runDsarExport`), a
// `*SkippedTotal` counter labelled by reason, per-job isolation handled
// by BullMQ itself (one job = one `runDsarExport` call, so a thrown
// error here fails only that job, never the worker process).

const log = logger.child("worker:dsar-export");

// No TTL was specified upstream for how long a completed export stays
// downloadable. 30 days mirrors common DSAR/data-portability download
// windows (e.g. Apple's and Google's own subject-access tooling) and
// gives a customer's backend a full month to fetch the artifact through
// GET /v1/dsar/:id/download before the row's `expiresAt` disables it.
// Named here so this is the one place the policy would change.
export const DSAR_ARTIFACT_TTL_DAYS = 30;

const DSAR_ARTIFACT_TTL_MS = DSAR_ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000;

// Distinct from `IMPORT_STORAGE_PREFIX` ("imports") per Ruling A: DSAR
// exports live in the SAME private bucket as import uploads
// (`import-store.ts`) but under their own prefix, so
// `workers/import-retention.ts`'s job-row-driven sweep — which only
// ever deletes keys it read off an `import_jobs` row, never scans the
// bucket — can never reach into this namespace even by accident.
export const DSAR_EXPORT_STORAGE_PREFIX = "dsar-exports";

/** `{DSAR_EXPORT_STORAGE_PREFIX}/{projectId}/{dsarRequestId}.json` —
 *  scoped by project and request so two exports never collide, and the
 *  request id in the key lets a human match an artifact back to the row
 *  that owns it without a lookup. */
function buildDsarExportStorageKey(projectId: string, dsarRequestId: string): string {
  return `${DSAR_EXPORT_STORAGE_PREFIX}/${projectId}/${dsarRequestId}.json`;
}

const DSAR_EXPORT_CONTENT_TYPE = "application/json";

// dsarExportSkippedTotal reason labels.
const SKIP_REASON_RACE = "race";
const SKIP_REASON_STORAGE_UNCONFIGURED = "storage-unconfigured";
// Finding 2 (roadmap-9a final fix wave): the subject was erased between
// this job being claimed and `exportSubscriber` actually reading their
// data — see export-subscriber.ts's own deletedAt check. Labelled
// separately from a generic "error" so this EXPECTED interlock outcome
// (the export correctly refusing to manufacture fresh PII for an erased
// subject) never gets triaged as an unexpected worker failure.
const SKIP_REASON_SUBSCRIBER_ERASED = "subscriber-erased";
const SKIP_REASON_ERROR = "error";

// The worker has no dashboard session to attribute audit rows or the
// underlying `exportSubscriber` read to — mirrors
// leaderboard-scheduler.ts's `userId: "system"` for its own audit call.
const SYSTEM_ACTOR = "system";

export type DsarExportOutcome =
  | { outcome: "completed"; artifactKey: string }
  | { outcome: "skipped_race" }
  | { outcome: "failed"; error: string };

export interface DsarExportDeps {
  claimDsarRequest: typeof drizzle.dsarRequestRepo.claimDsarRequest;
  completeDsarRequest: typeof drizzle.dsarRequestRepo.completeDsarRequest;
  failDsarRequest: typeof drizzle.dsarRequestRepo.failDsarRequest;
  lockSubscriberDeletionState: typeof drizzle.dsarRequestRepo.lockSubscriberDeletionState;
  exportSubscriber: (input: {
    subscriberId: string;
    projectId: string;
    actorUserId: string;
  }) => Promise<SubscriberExport>;
  putObject: typeof importStore.putObject;
  deleteObject: typeof importStore.deleteObject;
  isStorageConfigured: typeof importStore.isStorageConfigured;
  audit: (entry: AuditEntry, tx?: AuditTx) => Promise<void>;
  // Every DB write this worker makes is paired with its own audit row
  // in the SAME transaction (CLAUDE.md: "audit() runs inside the
  // caller's Drizzle tx"), so a crash between the two can never leave
  // one without the other. The storage write sits OUTSIDE every
  // transaction here on purpose — an S3 call cannot participate in a
  // Postgres transaction, which is exactly why the ordering rule
  // above is enforced by the CODE PATH (storage write, then a single
  // atomic claim/complete/fail + audit transaction) rather than by a
  // database transaction spanning both.
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  now: () => Date;
}

export const defaultDeps: DsarExportDeps = {
  claimDsarRequest: drizzle.dsarRequestRepo.claimDsarRequest,
  completeDsarRequest: drizzle.dsarRequestRepo.completeDsarRequest,
  failDsarRequest: drizzle.dsarRequestRepo.failDsarRequest,
  lockSubscriberDeletionState:
    drizzle.dsarRequestRepo.lockSubscriberDeletionState,
  exportSubscriber,
  putObject: importStore.putObject,
  deleteObject: importStore.deleteObject,
  isStorageConfigured: importStore.isStorageConfigured,
  audit,
  transaction: (fn) => drizzle.db.transaction((tx) => fn(tx as unknown as Db)),
  now: () => new Date(),
};

/**
 * Pure, directly-testable body — no BullMQ types cross this boundary.
 * See the module doc above for the ordering guarantee this function
 * exists to enforce.
 */
export async function runDsarExport(
  jobData: DsarJobData,
  deps: DsarExportDeps = defaultDeps,
): Promise<DsarExportOutcome> {
  const { dsarRequestId, projectId, subscriberId } = jobData;

  // Claim + its audit row in ONE transaction: a crash between the two
  // must never leave a RUNNING row with no record of who/what claimed
  // it, and must never leave an audit row for a claim that didn't
  // actually commit.
  const claimed = await deps.transaction(async (tx) => {
    const row = await deps.claimDsarRequest(tx, dsarRequestId);
    if (!row) return null;
    await deps.audit(
      {
        projectId,
        userId: SYSTEM_ACTOR,
        action: "dsar_request.claimed",
        resource: "dsar_request",
        resourceId: dsarRequestId,
        before: { status: "PENDING" },
        after: { status: "RUNNING" },
        ipAddress: null,
        userAgent: null,
      },
      tx as unknown as AuditTx,
    );
    return row;
  });

  if (!claimed) {
    dsarExportSkippedTotal.inc({ reason: SKIP_REASON_RACE });
    log.info("dsar export: claim lost, another replica already has this row", {
      dsarRequestId,
    });
    return { outcome: "skipped_race" };
  }

  // Tracks whether THIS run's putObject already resolved, so the catch
  // block below knows whether there is an orphaned artifact to clean up
  // before marking the row FAILED.
  let artifactKey: string | null = null;

  try {
    // Fail CLOSED — checked for real, never assumed. A customer told
    // their export is ready who then finds nothing has been misinformed
    // about a legal obligation.
    if (!deps.isStorageConfigured()) {
      throw new Error(
        "DSAR export storage is not configured — refusing to fabricate a completed export",
      );
    }

    const data = await deps.exportSubscriber({
      subscriberId,
      projectId,
      actorUserId: SYSTEM_ACTOR,
    });

    const key = buildDsarExportStorageKey(projectId, dsarRequestId);
    const body = Buffer.from(JSON.stringify(data), "utf-8");

    // Write AND confirm: `putObject` (Upload.done()) does not resolve
    // until the object is fully committed server-side, so awaiting it
    // to completion here — BEFORE anything below touches the request
    // row — is itself the confirmation the ordering requirement asks
    // for.
    await deps.putObject(key, body, DSAR_EXPORT_CONTENT_TYPE);
    artifactKey = key;

    const expiresAt = new Date(deps.now().getTime() + DSAR_ARTIFACT_TTL_MS);

    await deps.transaction(async (tx) => {
      // The LAST word on whether this artifact may exist. Finding 2 put
      // a deletedAt check in `exportSubscriber`, at the point the data
      // is read; that closes the common case but not the race, because
      // an erasure committing between that read and this point would
      // leave the artifact written and referenced with nothing to catch
      // it. Locking the subscriber row here makes the two serialise
      // against `anonymizeSubscriberRow` — see
      // `lockSubscriberDeletionState` for why either interleaving now
      // ends with no artifact.
      //
      // Throwing (rather than returning) hands this to the catch below,
      // which already deletes the orphaned artifact, marks the row
      // FAILED and labels the metric SKIP_REASON_SUBSCRIBER_ERASED —
      // the same terminal state as losing the race one step earlier,
      // reached by the same code path rather than a parallel one.
      const subject = await deps.lockSubscriberDeletionState(tx, subscriberId);
      if (subject?.deletedAt) {
        throw new HTTPException(SUBSCRIBER_ERASED_STATUS, {
          message:
            "Subscriber was erased while this export was being written — refusing to publish the artifact",
        });
      }

      await deps.completeDsarRequest(tx, {
        id: dsarRequestId,
        artifactKey: key,
        expiresAt,
      });
      await deps.audit(
        {
          projectId,
          userId: SYSTEM_ACTOR,
          action: "dsar_request.export_completed",
          resource: "dsar_request",
          resourceId: dsarRequestId,
          before: { status: "RUNNING" },
          after: {
            status: "COMPLETED",
            artifactKey: key,
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );
    });

    dsarExportCompletedTotal.inc();
    log.info("dsar export completed", { dsarRequestId, projectId });
    return { outcome: "completed", artifactKey: key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isStorageUnconfigured = !deps.isStorageConfigured();
    // Finding 2: `exportSubscriber` throws this SPECIFIC status when the
    // subject was erased between claim and read — never a bare 404 (that
    // one is a genuine "no such subscriber" bug, not an expected race)
    // and never treated as storage-unconfigured or a generic error.
    const isSubscriberErased =
      err instanceof HTTPException && err.status === SUBSCRIBER_ERASED_STATUS;

    if (artifactKey) {
      // The artifact was written and confirmed, but something AFTER
      // that (the COMPLETED update, the audit write) still failed.
      // Best-effort cleanup so a PII export never lingers unreferenced
      // in a bucket nothing ever sweeps.
      try {
        await deps.deleteObject(artifactKey);
      } catch (cleanupErr) {
        // Finding 5 (roadmap-9a final fix wave): the key itself is not
        // logged here — it is not a capability (the download route
        // re-authorises on every call) and carries no subject
        // identifier, but `dsarRequestId` alone already lets an
        // operator look the row up (and its artifactKey) if the cleanup
        // genuinely needs following up, so there is no reason to also
        // put the raw storage key in a log line.
        log.error("dsar export: failed to clean up orphaned artifact", {
          dsarRequestId,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    await deps.transaction(async (tx) => {
      await deps.failDsarRequest(tx, dsarRequestId, message);
      await deps.audit(
        {
          projectId,
          userId: SYSTEM_ACTOR,
          action: "dsar_request.export_failed",
          resource: "dsar_request",
          resourceId: dsarRequestId,
          before: { status: "RUNNING" },
          after: { status: "FAILED", error: message },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );
    });

    dsarExportSkippedTotal.inc({
      reason: isSubscriberErased
        ? SKIP_REASON_SUBSCRIBER_ERASED
        : isStorageUnconfigured
          ? SKIP_REASON_STORAGE_UNCONFIGURED
          : SKIP_REASON_ERROR,
    });
    if (isSubscriberErased) {
      log.info("dsar export skipped: subscriber was erased before export could run", {
        dsarRequestId,
        projectId,
      });
    } else {
      log.error("dsar export failed", { dsarRequestId, projectId, err: message });
    }
    return { outcome: "failed", error: message };
  }
}

// =============================================================
// BullMQ worker
// =============================================================

let cachedWorker: Worker<DsarJobData> | undefined;

export function createDsarExportWorker(): Worker<DsarJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<DsarJobData>(
    DSAR_EXPORT_QUEUE_NAME,
    async (job: Job<DsarJobData>) => {
      return runDsarExport(job.data);
    },
    {
      connection: createBullConnection("dsar-export"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("dsar export job failed", {
      jobId: job?.id,
      dsarRequestId: job?.data?.dsarRequestId,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}

/** Single entry point for boot wiring (apps/api/src/index.ts). */
export function ensureDsarExportWorker(): void {
  createDsarExportWorker();
  log.info("dsar export worker started", { queue: DSAR_EXPORT_QUEUE_NAME });
}

// Re-exported so callers of this worker file don't also need to import
// from queues/dsar.ts for the one constant they need (the task brief's
// "Produces" list names this alongside runDsarExport/ensureDsarExportWorker).
export { DSAR_EXPORT_JOB_NAME, DSAR_EXPORT_QUEUE_NAME };
