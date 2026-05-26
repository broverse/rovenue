import { createHash, createHmac } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { OutgoingWebhookStatus, drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { captureNotifierError } from "../lib/sentry-notifications";
import { emitNotification } from "../services/notifications/emit";

// =============================================================
// Outgoing webhook delivery worker
// =============================================================
//
// Polls `outgoing_webhooks` for rows in PENDING or FAILED (whose
// nextRetryAt has arrived) and attempts HTTP delivery. On success
// the row is marked SENT. On failure the retry schedule applies
// exponential backoff up to MAX_ATTEMPTS. After exhaustion the
// row enters DEAD — visible in the dashboard's Failed Webhooks
// view with a Retry button that resets the counter.

const log = logger.child("webhook-delivery");

export const DELIVERY_QUEUE_NAME = "rovenue-webhook-delivery";
export const MAX_ATTEMPTS = 5;
export const BACKOFF_SCHEDULE_MS = [
  1 * 60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
];
const BATCH_SIZE = 50;
const REPEAT_EVERY_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 10_000;

type FetchFn = typeof globalThis.fetch;

// =============================================================
// Core delivery loop — pure function for testability
// =============================================================

export async function deliverWebhooks(
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ delivered: number; failed: number; dead: number }> {
  const now = new Date();

  // `FOR UPDATE SKIP LOCKED` prevents two replicas from grabbing
  // the same row. Falls back silently on backends that don't
  // support it (e.g. SQLite); tests mock the repo method so the
  // raw query path is only hit in real Postgres deploys.
  const pending = (await drizzle.outgoingWebhookRepo.claimPendingWebhooks(
    drizzle.db,
    now,
    BATCH_SIZE,
  )) as WebhookRow[];

  let delivered = 0;
  let failed = 0;
  let dead = 0;

  for (const wh of pending) {
    try {
      const result = await attemptDelivery(wh, fetchFn);
      if (result === "SENT") delivered += 1;
      else if (result === "DEAD") dead += 1;
      else failed += 1;
    } catch (err) {
      log.error("webhook delivery unexpected error", {
        webhookId: wh.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (pending.length > 0) {
    log.info("webhook delivery batch complete", {
      total: pending.length,
      delivered,
      failed,
      dead,
    });
  }

  return { delivered, failed, dead };
}

interface WebhookRow {
  id: string;
  url: string;
  payload: unknown;
  attempts: number;
  projectId: string;
  projectWebhookSecret: string | null;
}

type DeliveryResult = "SENT" | "FAILED" | "DEAD";

export function signPayload(
  body: string,
  timestamp: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

async function attemptDelivery(
  wh: WebhookRow,
  fetchFn: FetchFn,
): Promise<DeliveryResult> {
  const now = new Date();
  const newAttempts = wh.attempts + 1;

  let httpStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DELIVERY_TIMEOUT_MS,
    );

    const body = JSON.stringify(wh.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-rovenue-event-id": wh.id,
      "x-rovenue-timestamp": String(timestamp),
    };
    if (wh.projectWebhookSecret) {
      headers["x-rovenue-signature"] = `t=${timestamp},v1=${signPayload(body, timestamp, wh.projectWebhookSecret)}`;
    }

    const res = await fetchFn(wh.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    httpStatus = res.status;
    responseBody = await res.text().catch(() => null);

    if (res.ok) {
      await drizzle.outgoingWebhookRepo.updateOutgoingWebhook(
        drizzle.db,
        wh.id,
        {
          status: OutgoingWebhookStatus.SENT,
          httpStatus,
          responseBody,
          attempts: newAttempts,
          sentAt: now,
          nextRetryAt: null,
        },
      );
      return "SENT";
    }

    errorMessage = responseBody ?? `HTTP ${httpStatus}`;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Failed — dead letter or schedule retry
  if (newAttempts >= MAX_ATTEMPTS) {
    await drizzle.outgoingWebhookRepo.updateOutgoingWebhook(
      drizzle.db,
      wh.id,
      {
        status: OutgoingWebhookStatus.DEAD,
        httpStatus,
        responseBody,
        lastErrorMessage: errorMessage,
        attempts: newAttempts,
        deadAt: now,
        nextRetryAt: null,
      },
    );
    log.warn("webhook moved to dead letter", {
      webhookId: wh.id,
      attempts: newAttempts,
      lastError: errorMessage,
    });
    return "DEAD";
  }

  const backoffMs = BACKOFF_SCHEDULE_MS[newAttempts - 1] ?? BACKOFF_SCHEDULE_MS.at(-1)!;
  const nextRetryAt = new Date(now.getTime() + backoffMs);

  await drizzle.outgoingWebhookRepo.updateOutgoingWebhook(
    drizzle.db,
    wh.id,
    {
      status: OutgoingWebhookStatus.FAILED,
      httpStatus,
      responseBody,
      lastErrorMessage: errorMessage,
      attempts: newAttempts,
      nextRetryAt,
    },
  );

  // Fire `integration.webhook.failing` on the third consecutive
  // failure. We dedup at the notifier layer via a per-endpoint
  // per-day eventId, so a burst of failing rows for the same URL
  // surfaces a single notification a day instead of one per row.
  if (newAttempts === 3) {
    await safeEmitWebhookFailing(wh, newAttempts, now);
  }
  return "FAILED";
}

/**
 * Best-effort notification emit. Wraps the call in a tx + try/catch
 * so a project-name lookup miss or notifier-side schema mismatch
 * can't break the webhook delivery loop. The webhook write that
 * happened just before this call is already committed.
 */
async function safeEmitWebhookFailing(
  wh: WebhookRow,
  consecutiveFailures: number,
  now: Date,
): Promise<void> {
  try {
    const [proj] = await drizzle.db
      .select({ name: drizzle.schema.projects.name })
      .from(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, wh.projectId))
      .limit(1);
    const projectName = proj?.name ?? wh.projectId;
    const urlDigest = createHash("sha256")
      .update(wh.url)
      .digest("hex")
      .slice(0, 12);
    const dayBucket = now.toISOString().slice(0, 10);
    await drizzle.db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "integration.webhook.failing",
        eventId: `webhook.failing:${wh.projectId}:${urlDigest}:${dayBucket}`,
        projectId: wh.projectId,
        context: {
          projectId: wh.projectId,
          projectName,
          webhookId: wh.id,
          endpointUrl: wh.url,
          consecutiveFailures,
        },
      });
    });
  } catch (err) {
    log.warn("integration.webhook.failing emit skipped", {
      webhookId: wh.id,
      err: err instanceof Error ? err.message : String(err),
    });
    captureNotifierError(err, {
      component: "webhook-failing-emit",
      projectId: wh.projectId,
      reason: "emit_failed",
    });
  }
}

// =============================================================
// BullMQ queue + worker
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getDeliveryQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(DELIVERY_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleDelivery(): Promise<void> {
  const queue = getDeliveryQueue();
  await queue.add(
    "deliver",
    {},
    {
      jobId: "webhook-delivery-repeatable",
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled webhook delivery", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createDeliveryWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    DELIVERY_QUEUE_NAME,
    async (_job: Job) => deliverWebhooks(),
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("delivery job failed", {
      jobId: job?.id,
      err: err.message,
    });
  });

  log.info("webhook delivery worker started", { queue: DELIVERY_QUEUE_NAME });
  return cachedWorker;
}
