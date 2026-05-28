// =============================================================
// Refund Shield Responder — CONSUMPTION_REQUEST polling worker
// =============================================================
//
// Every 30s this worker:
//   1. Claims a batch of PENDING refund_shield_responses rows whose
//      `scheduledFor` has arrived, using FOR UPDATE SKIP LOCKED so
//      multiple replicas can run safely against the same backlog.
//   2. For each row, re-verifies that the project is still enabled
//      and the subscriber row is present — operators can flip the
//      feature off after a CONSUMPTION_REQUEST was queued, and the
//      consent acknowledgement is read here too.
//   3. Calls `processRefundShieldResponse` (T13) which composes
//      signal aggregation (T12) + bucket mapping (T7) + the Apple
//      Server API call (T8) and returns a discriminated outcome.
//   4. Persists SENT / RETRY / FAILED via the repo writers — never
//      hand-rolling the SQL so the responder code stays focused on
//      orchestration.
//
// The actual per-row business logic — SLA gating, retry backoff,
// signal aggregation, payload mapping — lives in T13. Anything new
// here is *only* orchestration: claim → re-verify → dispatch →
// persist.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle, type Db } from "@rovenue/db";
import { audit, type AuditTx } from "../lib/audit";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { getClickHouseClient } from "../lib/clickhouse";
import {
  incRefundShieldFailed,
  incRefundShieldSent,
  observeRefundShieldSlaRemainingSeconds,
  type RefundShieldFailureReason,
} from "../lib/metrics-refund-shield";
import { loadAppleCredentials } from "../lib/project-credentials";
import type { ProjectAppleContext } from "../services/apple/apple-auth";
import { processRefundShieldResponse } from "../services/refund-shield/process-response";

// Apple's CONSUMPTION_REQUEST -> response SLA is documented as 12h.
// Used by the SENT-branch histogram to record how much head-room
// remained when we dispatched.
const APPLE_CONSUMPTION_SLA_MS = 12 * 60 * 60 * 1000;

// =============================================================
// Audit + metric helpers — wrapped in try/catch so a failed audit
// or metric write can never crash the worker mid-batch. Worker
// resilience > observability fidelity (per plan §"Audit failure
// resilience").
// =============================================================

async function safeAudit(
  entry: Parameters<typeof audit>[0],
  tx: AuditTx,
): Promise<void> {
  try {
    await audit(entry, tx);
  } catch (err) {
    log.warn("refund-shield audit write failed", {
      action: entry.action,
      resourceId: entry.resourceId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function classifyFailureReason(
  error: string,
  httpStatus: number | null | undefined,
): RefundShieldFailureReason {
  if (error.includes("MAX_RETRIES_EXHAUSTED")) return "max_retries";
  if (error.includes("APPLE_CREDENTIALS_MISSING")) return "apple_ctx_missing";
  if (error.includes("PROJECT_NOT_FOUND")) return "project_not_found";
  if (error.includes("SLA_EXCEEDED") || error.includes("sla_exceeded"))
    return "sla_exceeded";
  if (error.startsWith("INTERNAL_ERROR")) return "internal_error";
  if (typeof httpStatus === "number") {
    if (httpStatus >= 500) return "apple_5xx";
    if (httpStatus >= 400) return "apple_4xx";
  }
  return "internal_error";
}

const log = logger.child("refund-shield-responder");

export const REFUND_SHIELD_RESPONDER_QUEUE_NAME =
  "rovenue-refund-shield-responder";

const REPEATABLE_JOB_NAME = "refund-shield-responder:sweep";
const REPEATABLE_JOB_ID = "refund-shield-responder-repeatable";

/** Worker tuning. Exported so tests can assert against them. */
export const BATCH_SIZE = 50;
export const MAX_RETRIES = 5;
export const POLL_INTERVAL_MS = 30_000;

// =============================================================
// Tick body
// =============================================================
//
// One transaction per tick — the FOR UPDATE locks are released
// when the tx commits. Per-row failures inside the loop log and
// continue so a single poison row can't starve the rest of the
// batch (the row's status is updated either way).

export interface TickInput {
  now: Date;
}

export async function runRefundShieldResponderTick(
  input: TickInput,
): Promise<{
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}> {
  let claimed = 0;
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;

  await drizzle.db.transaction(async (tx) => {
    const due = await drizzle.refundShieldResponseRepo.claimPendingResponses(
      tx as unknown as Db,
      {
        now: input.now,
        batchSize: BATCH_SIZE,
        maxRetries: MAX_RETRIES,
      },
    );
    claimed = due.length;

    for (const row of due) {
      try {
        const result = await processOneRow({
          row,
          tx: tx as unknown as Db,
          now: input.now,
        });
        if (result === "SENT") sent += 1;
        else if (result === "RETRY") retried += 1;
        else if (result === "FAILED") failed += 1;
        else skipped += 1;
      } catch (err) {
        // Defensive: anything thrown from processOneRow that isn't
        // an outcome-bearing return path means we couldn't even
        // persist a status — mark FAILED so we don't re-claim the
        // row in a tight loop. The catch here keeps one bad row
        // from rolling back the whole batch.
        failed += 1;
        log.error("refund-shield responder row processing threw", {
          rowId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
        try {
          await drizzle.refundShieldResponseRepo.markResponseFailed(
            tx as unknown as Db,
            {
              id: row.id,
              error: `INTERNAL_ERROR: ${err instanceof Error ? err.message : String(err)}`,
              updatedAt: input.now,
            },
          );
        } catch (markErr) {
          log.error("failed to mark row FAILED after internal error", {
            rowId: row.id,
            err:
              markErr instanceof Error ? markErr.message : String(markErr),
          });
        }
      }
    }
  });

  if (claimed > 0) {
    log.info("refund-shield responder tick complete", {
      claimed,
      sent,
      retried,
      failed,
      skipped,
    });
  }

  return { claimed, sent, retried, failed, skipped };
}

// =============================================================
// Per-row processor (orchestration only — T13 owns the logic)
// =============================================================

type RowResult = "SENT" | "RETRY" | "FAILED" | "SKIPPED";

async function processOneRow(args: {
  row: Awaited<
    ReturnType<
      typeof drizzle.refundShieldResponseRepo.claimPendingResponses
    >
  >[number];
  tx: Db;
  now: Date;
}): Promise<RowResult> {
  const { row, tx, now } = args;

  // Re-verify project state — the feature may have been disabled
  // between webhook enqueue and worker dispatch.
  const project = await drizzle.projectRepo.findProjectById(tx, row.projectId);
  if (!project) {
    await drizzle.refundShieldResponseRepo.markResponseFailed(tx, {
      id: row.id,
      error: "PROJECT_NOT_FOUND",
      updatedAt: now,
    });
    incRefundShieldFailed(row.projectId, "project_not_found");
    return "FAILED";
  }
  if (!project.refundShieldEnabled) {
    await drizzle.refundShieldResponseRepo.markResponseSkipped(tx, {
      id: row.id,
      status: "SKIPPED_DISABLED",
      updatedAt: now,
    });
    return "SKIPPED";
  }
  if (row.subscriberId === null) {
    // Defensive: the webhook handler (T10) inserts SKIPPED_NOT_FOUND
    // for unknown subscribers before they ever land as PENDING, so
    // this branch only fires on operator-issued requeues.
    await drizzle.refundShieldResponseRepo.markResponseSkipped(tx, {
      id: row.id,
      status: "SKIPPED_NOT_FOUND",
      updatedAt: now,
    });
    return "SKIPPED";
  }

  // Load Apple credentials. The worker can't recover from missing
  // creds, so a missing config is a terminal FAILED for the row —
  // an operator must wire the project before retrying. The
  // environment is read off the row (captured from the JWS at T10
  // webhook receive time) so this dispatch hits the same base URL
  // Apple originally addressed.
  const ctx = await loadAppleContextForProject(
    row.projectId,
    row.appleEnvironment as "PRODUCTION" | "SANDBOX",
  );
  if (!ctx) {
    await drizzle.refundShieldResponseRepo.markResponseFailed(tx, {
      id: row.id,
      error: "APPLE_CREDENTIALS_MISSING",
      updatedAt: now,
    });
    incRefundShieldFailed(row.projectId, "apple_ctx_missing");
    return "FAILED";
  }

  // T13 owns SLA gating, retry backoff, and the Apple POST.
  const ch = getClickHouseClient();
  const outcome = await processRefundShieldResponse({
    row: {
      id: row.id,
      projectId: row.projectId,
      subscriberId: row.subscriberId,
      appleNotificationUuid: row.appleNotificationUuid,
      appleOriginalTransactionId: row.appleOriginalTransactionId,
      appleTransactionId: row.appleTransactionId,
      detectedAt: row.detectedAt,
      scheduledFor: row.scheduledFor,
      status: row.status,
      retryCount: row.retryCount,
    },
    ctx,
    customerConsented: project.refundShieldConsentAcknowledgedAt !== null,
    db: tx,
    ch,
    now,
  });

  if (outcome.status === "SENT") {
    await drizzle.refundShieldResponseRepo.markResponseSent(tx, {
      id: row.id,
      requestPayload: outcome.payload,
      appleHttpStatus: outcome.httpStatus,
      sentAt: now,
    });
    // Metrics: increment SENT counter and record how much of Apple's
    // 12h SLA was still on the clock when we dispatched. The
    // histogram lets Grafana surface "we keep cutting it close"
    // before it manifests as a missed-SLA SENT_LATE row.
    incRefundShieldSent(row.projectId);
    const slaRemainingMs =
      row.detectedAt.getTime() + APPLE_CONSUMPTION_SLA_MS - now.getTime();
    observeRefundShieldSlaRemainingSeconds(
      row.projectId,
      Math.max(0, Math.floor(slaRemainingMs / 1000)),
    );
    // Audit: actor is "system" — the responder runs without a user
    // session. The audit row commits in the same tx as markResponseSent
    // so a rollback removes both atomically.
    await safeAudit(
      {
        projectId: row.projectId,
        userId: "system",
        action: "refund_shield.response.sent",
        resource: "refund_shield_response",
        resourceId: row.id,
        before: null,
        after: {
          appleHttpStatus: outcome.httpStatus,
          appleNotificationUuid: row.appleNotificationUuid,
          appleOriginalTransactionId: row.appleOriginalTransactionId,
        },
        ipAddress: null,
        userAgent: null,
      },
      tx as unknown as AuditTx,
    );
    return "SENT";
  }

  if (outcome.status === "RETRY") {
    // Coerce to terminal FAILED at the retry boundary. The claim
    // query filters `retry_count < MAX_RETRIES`, so a row left
    // PENDING with retryCount === MAX_RETRIES would never be
    // reclaimed — a silent black hole. Promote it to FAILED here.
    if (row.retryCount + 1 >= MAX_RETRIES) {
      const finalError = `MAX_RETRIES_EXHAUSTED (last_error: ${outcome.error})`;
      await drizzle.refundShieldResponseRepo.markResponseFailed(tx, {
        id: row.id,
        error: finalError,
        appleHttpStatus: null,
        appleResponseBody: null,
        updatedAt: now,
      });
      incRefundShieldFailed(row.projectId, "max_retries");
      await safeAudit(
        {
          projectId: row.projectId,
          userId: "system",
          action: "refund_shield.response.failed",
          resource: "refund_shield_response",
          resourceId: row.id,
          before: null,
          after: {
            error: finalError,
            reason: "max_retries",
            retryCount: row.retryCount + 1,
            appleNotificationUuid: row.appleNotificationUuid,
          },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );
      return "FAILED";
    }
    await drizzle.refundShieldResponseRepo.markResponseRetry(tx, {
      id: row.id,
      retryCount: row.retryCount + 1,
      scheduledFor: new Date(now.getTime() + outcome.retryDelayMs),
      error: outcome.error,
      updatedAt: now,
    });
    return "RETRY";
  }

  // outcome.status === "FAILED"
  await drizzle.refundShieldResponseRepo.markResponseFailed(tx, {
    id: row.id,
    error: outcome.error,
    appleHttpStatus: outcome.httpStatus ?? null,
    appleResponseBody: outcome.responseBody ?? null,
    updatedAt: now,
  });
  const reason = classifyFailureReason(outcome.error, outcome.httpStatus);
  incRefundShieldFailed(row.projectId, reason);
  await safeAudit(
    {
      projectId: row.projectId,
      userId: "system",
      action: "refund_shield.response.failed",
      resource: "refund_shield_response",
      resourceId: row.id,
      before: null,
      after: {
        error: outcome.error,
        reason,
        appleHttpStatus: outcome.httpStatus ?? null,
        appleNotificationUuid: row.appleNotificationUuid,
      },
      ipAddress: null,
      userAgent: null,
    },
    tx as unknown as AuditTx,
  );
  return "FAILED";
}

// =============================================================
// Apple context loader
// =============================================================
//
// Reuses `loadAppleCredentials` (which already handles encrypted-
// column decode + schema validation) and pulls all four signing
// fields. `appAppleId` is optional on the schema but the responder
// hits the Server API by transactionId, not appAppleId, so we only
// require the JWT signing inputs.
//
// Environment selection: the per-row `apple_environment` column is
// captured from the JWS at webhook receive time (T10) and persisted
// alongside the rest of the CONSUMPTION_REQUEST work-queue row.
// This is correct even for hybrid deployments where one Rovenue API
// serves both TestFlight (SANDBOX) and production (PRODUCTION)
// traffic — every row carries the environment it actually arrived
// with, so we can re-target the correct base URL hours later
// without a fresh JWS or a NODE_ENV fallback.

async function loadAppleContextForProject(
  projectId: string,
  environment: "PRODUCTION" | "SANDBOX",
): Promise<ProjectAppleContext | null> {
  const creds = await loadAppleCredentials(projectId);
  if (!creds) return null;
  if (!creds.keyId || !creds.issuerId || !creds.privateKey) {
    log.warn("apple credentials missing signing fields", { projectId });
    return null;
  }
  return {
    bundleId: creds.bundleId,
    keyId: creds.keyId,
    issuerId: creds.issuerId,
    privateKey: creds.privateKey,
    environment,
  };
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================
//
// We re-use the BullMQ-as-cron pattern the rest of the codebase
// adopts (see rovi-reaper.ts, custom-domain-cert-poller.ts). The
// job body is a no-op that just calls runRefundShieldResponderTick;
// concurrency stays at 1 because the heavy lifting happens inside
// the SKIP LOCKED tx, not in the Worker.

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getRefundShieldResponderQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(REFUND_SHIELD_RESPONDER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleRefundShieldResponder(): Promise<void> {
  const queue = getRefundShieldResponderQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: POLL_INTERVAL_MS },
    },
  );
  log.info("scheduled refund-shield responder", {
    everyMs: POLL_INTERVAL_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createRefundShieldResponderWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    REFUND_SHIELD_RESPONDER_QUEUE_NAME,
    async (_job: Job) => runRefundShieldResponderTick({ now: new Date() }),
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("refund-shield responder job failed", {
      jobId: job?.id,
      err: err.message,
    });
  });

  log.info("refund-shield responder worker started", {
    queue: REFUND_SHIELD_RESPONDER_QUEUE_NAME,
  });
  return cachedWorker;
}
