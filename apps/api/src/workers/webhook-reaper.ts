// =============================================================
// Webhook Reaper — inbound webhook stale-claim recovery worker (W2.4)
// =============================================================
//
// Per-minute BullMQ repeatable job that resets PROCESSING
// webhook_events rows whose claimedAt predates the 5-minute lease.
// This is the safety-net for cases where the claim was acquired but
// the processing worker crashed before completing (BullMQ job lost,
// pod OOM-killed, etc.). Each reclaimed row becomes FAILED +
// retryCount++ AND is re-enqueued as a fresh processing job rebuilt
// from the stored payload — nothing else ever retries these events:
// the provider never redelivers (the route acked with a 202) and the
// original job's BullMQ attempts are exhausted by the time the lease
// expires.
//
// Invariant: reclaimStaleWebhookEvents() is idempotent and safe to
// run from multiple instances — only rows that are actually stale
// are updated (the WHERE guard is atomic in Postgres), and the
// deterministic replay jobId (event id + post-reclaim retryCount)
// makes a duplicate enqueue for the same reclaim a BullMQ no-op,
// while a later reclaim of the same event (retryCount moved on) can
// enqueue again.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type Stripe from "stripe";
import { drizzle, type WebhookEvent } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { webhookEventsReclaimedTotal } from "../lib/metrics";
// Type-only: keeps this module import-light for unit tests (the real
// queue is reached through a lazy dynamic import below).
import type { WebhookJobData } from "../services/webhook-processor";
import type { GooglePubSubPushBody } from "../services/google";

const log = logger.child("webhook-reaper");

export const WEBHOOK_REAPER_QUEUE_NAME = "rovenue-webhook-reaper";

const REPEAT_EVERY_MS = 60_000; // per-minute — matches rovi-reaper cadence
const REPEATABLE_JOB_NAME = "webhook-reaper:sweep";
const REPEATABLE_JOB_ID = "webhook-reaper-repeatable";

// A reclaimed row whose retryCount already exceeds this is left FAILED
// (visible to alerting) instead of being re-enqueued — the event has
// consistently failed and endless replays would just churn.
export const MAX_REAPER_REQUEUES = 5;

// Deterministic replay-job id prefix: `webhook-replay:{eventId}:{retryCount}`.
const REPLAY_JOB_ID_PREFIX = "webhook-replay";

// =============================================================
// Job body
// =============================================================

export interface WebhookReaperResult {
  reclaimed: number;
  requeued: number;
}

/** Enqueue seam — injected in tests, real BullMQ queue in production. */
export type ReplayEnqueue = (
  data: WebhookJobData,
  opts: { jobId: string },
) => Promise<unknown>;

async function defaultReplayEnqueue(
  data: WebhookJobData,
  opts: { jobId: string },
): Promise<unknown> {
  // Lazy import: webhook-processor pulls in the whole handler graph and
  // opens a Redis connection for its queue — only needed when a row is
  // actually being replayed.
  const { getWebhookQueue } = await import("../services/webhook-processor");
  return getWebhookQueue().add(`${data.source}:${data.projectId}`, data, opts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Rebuild the original processing-job input from a reclaimed row's
 * stored payload. Returns null when the payload cannot drive a replay:
 * rows persisted before the payload shapes carried the raw inputs
 * (legacy Apple/Google rows), or sources processed outside the store
 * webhook queue (STRIPE_BILLING has its own pipeline).
 */
function buildReplayJobData(row: WebhookEvent): WebhookJobData | null {
  const payload: unknown = row.payload;
  switch (row.source) {
    case "APPLE": {
      if (isRecord(payload) && typeof payload.signedPayload === "string") {
        return {
          source: "APPLE",
          projectId: row.projectId,
          signedPayload: payload.signedPayload,
        };
      }
      return null;
    }
    case "GOOGLE": {
      if (
        isRecord(payload) &&
        isRecord(payload.pushBody) &&
        isRecord(payload.pushBody.message) &&
        typeof payload.pushBody.message.messageId === "string"
      ) {
        return {
          source: "GOOGLE",
          projectId: row.projectId,
          pushBody: payload.pushBody as unknown as GooglePubSubPushBody,
        };
      }
      return null;
    }
    case "STRIPE": {
      // The stored payload IS the verified Stripe event.
      if (
        isRecord(payload) &&
        typeof payload.id === "string" &&
        typeof payload.type === "string"
      ) {
        return {
          source: "STRIPE",
          projectId: row.projectId,
          event: payload as unknown as Stripe.Event,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export async function runWebhookReaper(
  now: Date = new Date(),
  enqueueReplay: ReplayEnqueue = defaultReplayEnqueue,
): Promise<WebhookReaperResult> {
  const rows = await drizzle.webhookEventRepo.reclaimStaleWebhookEvents(
    drizzle.db,
    now,
  );
  if (rows.length > 0) {
    log.warn("reclaimed orphaned PROCESSING webhook_events", {
      reclaimed: rows.length,
    });
    webhookEventsReclaimedTotal.inc(rows.length);
  }

  let requeued = 0;
  for (const row of rows) {
    // retryCount here is already post-increment (the reclaim bumped it).
    if (row.retryCount > MAX_REAPER_REQUEUES) {
      log.error("webhook event exceeded reaper requeue cap; leaving FAILED", {
        webhookEventId: row.id,
        source: row.source,
        eventType: row.eventType,
        retryCount: row.retryCount,
        cap: MAX_REAPER_REQUEUES,
      });
      continue;
    }

    const jobData = buildReplayJobData(row);
    if (!jobData) {
      log.error(
        "cannot rebuild webhook job from stored payload; leaving FAILED",
        {
          webhookEventId: row.id,
          source: row.source,
          eventType: row.eventType,
        },
      );
      continue;
    }

    await enqueueReplay(jobData, {
      jobId: `${REPLAY_JOB_ID_PREFIX}:${row.id}:${row.retryCount}`,
    });
    requeued++;
  }

  if (requeued > 0) {
    log.warn("re-enqueued stranded webhook events", { requeued });
  }
  return { reclaimed: rows.length, requeued };
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getWebhookReaperQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(WEBHOOK_REAPER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the per-minute repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleWebhookReaper(): Promise<void> {
  const queue = getWebhookReaperQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled webhook reaper", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createWebhookReaperWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    WEBHOOK_REAPER_QUEUE_NAME,
    async (_job: Job): Promise<WebhookReaperResult> => runWebhookReaper(),
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("webhook reaper job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job, result: WebhookReaperResult) => {
    log.debug("webhook reaper job completed", {
      jobId: job.id,
      reclaimed: result.reclaimed,
      requeued: result.requeued,
    });
  });

  log.info("webhook reaper worker started", {
    queue: WEBHOOK_REAPER_QUEUE_NAME,
  });
  return cachedWorker;
}
