import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createBullConnection } from "../lib/redis";
import type Stripe from "stripe";
import {
  ProductType,
  drizzle,
} from "@rovenue/db";
import { toWebhookEventCategory } from "@rovenue/shared";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { loadGoogleCredentials } from "../lib/project-credentials";
import { requireConnectedStripe } from "../lib/stripe-platform";
import { syncAccess } from "./access-engine";
import { grantPurchaseCurrencies } from "./purchase-credits";
import {
  handleAppleNotification,
  type HandleAppleNotificationResult,
} from "./apple/apple-webhook";
import {
  handleGoogleNotification,
  type GooglePubSubPushBody,
  type GoogleServiceAccountCredentials,
  type GoogleVerifyConfig,
  type HandleGoogleNotificationResult,
} from "./google";
import {
  processStripeEvent,
  type HandleStripeNotificationResult,
} from "./stripe/stripe-webhook";

const log = logger.child("webhook-processor");

export const WEBHOOK_QUEUE_NAME = "rovenue-webhooks";

// =============================================================
// Job shapes
// =============================================================

export type WebhookJobData =
  | {
      source: "APPLE";
      projectId: string;
      signedPayload: string;
    }
  | {
      source: "GOOGLE";
      projectId: string;
      pushBody: GooglePubSubPushBody;
    }
  | {
      // NOTE: Stripe events are verified synchronously at the route edge
      // so the raw body and webhook secret never land in Redis. The worker
      // only re-processes the parsed event.
      source: "STRIPE";
      projectId: string;
      event: Stripe.Event;
    };

export type WebhookJobResult =
  | HandleAppleNotificationResult
  | HandleGoogleNotificationResult
  | HandleStripeNotificationResult;

/**
 * Side-effect hook the processor injects into every handler. Handlers
 * call it AFTER their domain writes but BEFORE marking the
 * webhook_events row PROCESSED: if a side effect fails, the handler's
 * catch marks the row FAILED (re-claimable) and rethrows so BullMQ
 * retries — marking PROCESSED first would make the retry dedupe to
 * `duplicate` and lose the side effect permanently (e.g. a
 * webhook-only consumable credit grant). All side effects are
 * idempotent on re-run (`guardStatusWrite`, addCredits' purchase
 * dedupe, the outgoing enqueue's webhookEventId dedupe).
 */
export type WebhookPostProcess = (ctx: {
  webhookEventId: string;
  eventType: string;
  subscriberId?: string;
  purchaseId?: string;
}) => Promise<void>;

// =============================================================
// BullMQ connection + queue
// =============================================================

// -------------------------------------------------------------
// Retry/lease invariant: total retry span > claim lease.
//
// A worker that dies mid-claim leaves the webhook_events row
// PROCESSING with a live lease (WEBHOOK_CLAIM_LEASE_MS = 5 min,
// packages/db webhook-events repo); every BullMQ retry inside that
// lease sees claimWebhookEvent → "in_progress" and throws, so at
// least one retry MUST land after the lease expires or all attempts
// burn on the stale claim and the event strands until the reaper.
// Exponential backoff from 5s over 8 attempts spans
// 5+10+20+40+80+160+320 = 635s > 300s. The invariant is asserted by
// webhook-processor.test.ts against the exported lease constant.
// -------------------------------------------------------------
export const WEBHOOK_JOB_ATTEMPTS = 8;
export const WEBHOOK_JOB_BACKOFF_INITIAL_MS = 5_000;

/** Sum of BullMQ exponential-backoff delays across all retries. */
export function webhookRetrySpanMs(
  attempts: number,
  initialDelayMs: number,
): number {
  let span = 0;
  for (let retry = 0; retry < attempts - 1; retry++) {
    span += initialDelayMs * 2 ** retry;
  }
  return span;
}

let cachedQueue: Queue<WebhookJobData, WebhookJobResult> | undefined;

export function getWebhookQueue(): Queue<WebhookJobData, WebhookJobResult> {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue<WebhookJobData, WebhookJobResult>(
    WEBHOOK_QUEUE_NAME,
    {
      connection: createBullConnection("webhook-processor"),
      defaultJobOptions: {
        attempts: WEBHOOK_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: WEBHOOK_JOB_BACKOFF_INITIAL_MS },
        removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
        removeOnFail: { count: 1000, age: 7 * 24 * 60 * 60 },
      },
    },
  );
  log.debug("webhook queue initialised");
  return cachedQueue;
}

export async function enqueueWebhookEvent(
  data: WebhookJobData,
): Promise<Job<WebhookJobData, WebhookJobResult>> {
  return getWebhookQueue().add(`${data.source}:${data.projectId}`, data);
}

// =============================================================
// processWebhookEvent — BullMQ job body
// =============================================================

export async function processWebhookEvent(
  data: WebhookJobData,
): Promise<WebhookJobResult> {
  log.info("processing webhook event", {
    source: data.source,
    projectId: data.projectId,
  });

  // Handlers invoke this between their domain writes and the PROCESSED
  // mark (see WebhookPostProcess). A throw here surfaces through the
  // handler's catch: row → FAILED, job → retry.
  const postProcess: WebhookPostProcess = async (ctx) => {
    if (!ctx.subscriberId) return;
    await runPostProcessing({
      projectId: data.projectId,
      subscriberId: ctx.subscriberId,
      purchaseId: ctx.purchaseId,
      eventType: ctx.eventType,
      webhookEventId: ctx.webhookEventId,
    });
  };

  return dispatchToHandler(data, postProcess);
}

async function dispatchToHandler(
  data: WebhookJobData,
  postProcess: WebhookPostProcess,
): Promise<WebhookJobResult> {
  switch (data.source) {
    case "APPLE":
      return handleAppleNotification({
        projectId: data.projectId,
        signedPayload: data.signedPayload,
        postProcess,
      });
    case "GOOGLE": {
      const verifyConfig = await resolveGoogleVerifyConfig(data.projectId);
      return handleGoogleNotification({
        projectId: data.projectId,
        pushBody: data.pushBody,
        verifyConfig,
        postProcess,
      });
    }
    case "STRIPE": {
      // Throws StripeNotConnectedError when the project has no active
      // connection, which BullMQ treats as a retry signal (same as the
      // old "credentials not configured" throw did).
      const connected = await requireConnectedStripe(data.projectId);
      return processStripeEvent({
        projectId: data.projectId,
        event: data.event,
        // Already bound to the customer's connected account, so nothing
        // dispatch does can reach Rovenue's own Stripe account.
        account: connected.account,
        postProcess,
      });
    }
  }
}

async function resolveGoogleVerifyConfig(
  projectId: string,
): Promise<GoogleVerifyConfig | undefined> {
  const creds = await loadGoogleCredentials(projectId);
  if (!creds) return undefined;
  return {
    packageName: creds.packageName,
    credentials: creds.serviceAccount as GoogleServiceAccountCredentials,
  };
}

// =============================================================
// Post-processing: access sync + credit add + outgoing webhook
// =============================================================

interface PostProcessingArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
  webhookEventId: string;
}

/**
 * Runs the three side effects, in order, and PROPAGATES the first
 * failure. The handler then marks the webhook_events row FAILED and
 * rethrows so BullMQ retries the whole job — every step here is
 * idempotent on re-run, so a partial success simply replays. Never
 * swallow these: with the row already PROCESSED a swallowed failure
 * was permanently lost (redeliveries dedupe to `duplicate`).
 */
async function runPostProcessing(args: PostProcessingArgs): Promise<void> {
  try {
    await syncAccess(args.subscriberId);
  } catch (err) {
    log.error("access sync failed; failing job for retry", {
      subscriberId: args.subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (args.purchaseId) {
    try {
      await maybeCreditConsumablePurchase(args.subscriberId, args.purchaseId);
    } catch (err) {
      log.error("consumable credit add failed; failing job for retry", {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  try {
    await enqueueOutgoingWebhook({
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      eventType: args.eventType,
      webhookEventId: args.webhookEventId,
    });
  } catch (err) {
    log.error("outgoing webhook enqueue failed; failing job for retry", {
      projectId: args.projectId,
      eventType: args.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function maybeCreditConsumablePurchase(
  subscriberId: string,
  purchaseId: string,
): Promise<void> {
  const purchase = await drizzle.purchaseExtRepo.findPurchaseWithCreditInfo(
    drizzle.db,
    purchaseId,
  );
  if (!purchase) return;
  if (purchase.product.type !== ProductType.CONSUMABLE) return;

  await grantPurchaseCurrencies({
    subscriberId,
    productId: purchase.product.id,
    purchaseId,
    productIdentifier: purchase.product.identifier,
  });

  log.debug("credited consumable purchase", { subscriberId, purchaseId });
}

interface EnqueueOutgoingWebhookArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
  /** Inbound webhook_events row id — the retry-safe dedup key. */
  webhookEventId: string;
}

async function enqueueOutgoingWebhook(
  args: EnqueueOutgoingWebhookArgs,
): Promise<void> {
  const config = await drizzle.projectRepo.findProjectWebhookConfig(
    drizzle.db,
    args.projectId,
  );
  if (!config?.url) return;

  // Category filter — empty list means "all events". For a non-empty
  // list, drop events whose category isn't subscribed. Unmapped events
  // (category === null) fail open so unknown/new types aren't lost.
  if (config.eventCategories.length > 0) {
    const category = toWebhookEventCategory(args.eventType);
    if (category !== null && !config.eventCategories.includes(category)) {
      return;
    }
  }

  // Idempotency across BullMQ retries (post-processing re-runs whole):
  // purchase events dedupe on (project, subscriber, type, purchase);
  // purchase-less events dedupe on the inbound webhookEventId stamped
  // into the outgoing payload below.
  if (args.purchaseId) {
    const existing =
      await drizzle.outgoingWebhookRepo.findRecentOutgoingByPurchaseAndType(
        drizzle.db,
        args.projectId,
        args.subscriberId,
        args.eventType,
        args.purchaseId,
      );
    if (existing) return;
  } else {
    const existing =
      await drizzle.outgoingWebhookRepo.findOutgoingByWebhookEvent(
        drizzle.db,
        args.projectId,
        args.subscriberId,
        args.eventType,
        args.webhookEventId,
      );
    if (existing) return;
  }

  const payload = {
    eventType: args.eventType,
    subscriberId: args.subscriberId,
    purchaseId: args.purchaseId ?? null,
    webhookEventId: args.webhookEventId,
    timestamp: new Date().toISOString(),
  };

  await drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook(drizzle.db, {
    projectId: args.projectId,
    eventType: args.eventType,
    subscriberId: args.subscriberId,
    purchaseId: args.purchaseId ?? null,
    payload,
    url: config.url,
  });
}

// =============================================================
// Worker
// =============================================================

let cachedWorker: Worker<WebhookJobData, WebhookJobResult> | undefined;

export function createWebhookWorker(): Worker<
  WebhookJobData,
  WebhookJobResult
> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<WebhookJobData, WebhookJobResult>(
    WEBHOOK_QUEUE_NAME,
    async (job) => processWebhookEvent(job.data),
    {
      connection: createBullConnection("webhook-processor"),
      concurrency: 8,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("webhook job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("webhook job completed", { jobId: job.id });
  });

  log.info("webhook worker started", { queue: WEBHOOK_QUEUE_NAME });
  return cachedWorker;
}

export {
  enqueueOutgoingWebhook as __test_enqueueOutgoingWebhook,
  maybeCreditConsumablePurchase as __test_maybeCreditConsumablePurchase,
  runPostProcessing as __test_runPostProcessing,
};
