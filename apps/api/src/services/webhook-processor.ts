import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type Stripe from "stripe";
import prisma, {
  CreditLedgerType,
  OutgoingWebhookStatus,
  ProductType,
  type Prisma as PrismaTypes,
} from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  loadGoogleCredentials,
  loadStripeCredentials,
} from "../lib/project-credentials";
import { syncAccess } from "./access-engine";
import { addCredits } from "./credit-engine";
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
  getStripeClient,
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

// =============================================================
// BullMQ connection + queue
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue<WebhookJobData, WebhookJobResult> | undefined;

export function getWebhookQueue(): Queue<WebhookJobData, WebhookJobResult> {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue<WebhookJobData, WebhookJobResult>(
    WEBHOOK_QUEUE_NAME,
    {
      connection: createBullConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
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

  const result = await dispatchToHandler(data);

  if (result.status === "processed" && result.subscriberId) {
    await runPostProcessing({
      projectId: data.projectId,
      subscriberId: result.subscriberId,
      purchaseId: result.purchaseId,
      eventType: extractEventType(result),
    });
  }

  return result;
}

async function dispatchToHandler(
  data: WebhookJobData,
): Promise<WebhookJobResult> {
  switch (data.source) {
    case "APPLE":
      return handleAppleNotification({
        projectId: data.projectId,
        signedPayload: data.signedPayload,
      });
    case "GOOGLE": {
      const verifyConfig = await resolveGoogleVerifyConfig(data.projectId);
      return handleGoogleNotification({
        projectId: data.projectId,
        pushBody: data.pushBody,
        verifyConfig,
      });
    }
    case "STRIPE": {
      const credentials = await loadStripeCredentials(data.projectId);
      if (!credentials) {
        throw new Error(
          `Stripe credentials not configured for project ${data.projectId}`,
        );
      }
      const stripe = getStripeClient(credentials.secretKey);
      return processStripeEvent({
        projectId: data.projectId,
        event: data.event,
        stripe,
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

function extractEventType(result: WebhookJobResult): string {
  if ("notificationType" in result) return String(result.notificationType);
  if ("kind" in result) return result.kind;
  if ("eventType" in result) return result.eventType;
  return "unknown";
}

// =============================================================
// Post-processing: access sync + credit add + outgoing webhook
// =============================================================

interface PostProcessingArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
}

async function runPostProcessing(args: PostProcessingArgs): Promise<void> {
  try {
    await syncAccess(args.subscriberId);
  } catch (err) {
    log.warn("access sync failed", {
      subscriberId: args.subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (args.purchaseId) {
    try {
      await maybeCreditConsumablePurchase(args.subscriberId, args.purchaseId);
    } catch (err) {
      log.warn("consumable credit add failed", {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await enqueueOutgoingWebhook({
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      eventType: args.eventType,
    });
  } catch (err) {
    log.warn("outgoing webhook enqueue failed", {
      projectId: args.projectId,
      eventType: args.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function maybeCreditConsumablePurchase(
  subscriberId: string,
  purchaseId: string,
): Promise<void> {
  const purchase = await prisma.purchase.findUnique({
    where: { id: purchaseId },
    include: {
      product: { select: { type: true, creditAmount: true } },
    },
  });
  if (!purchase) return;
  if (purchase.product.type !== ProductType.CONSUMABLE) return;
  if (!purchase.product.creditAmount || purchase.product.creditAmount <= 0) {
    return;
  }

  const existing = await prisma.creditLedger.findFirst({
    where: {
      subscriberId,
      referenceType: "purchase",
      referenceId: purchaseId,
    },
    select: { id: true },
  });
  if (existing) return;

  await addCredits({
    subscriberId,
    amount: purchase.product.creditAmount,
    type: CreditLedgerType.PURCHASE,
    referenceType: "purchase",
    referenceId: purchaseId,
    description: `Credits granted for purchase ${purchaseId}`,
  });

  log.debug("credited consumable purchase", {
    subscriberId,
    purchaseId,
    amount: purchase.product.creditAmount,
  });
}

interface EnqueueOutgoingWebhookArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
}

async function enqueueOutgoingWebhook(
  args: EnqueueOutgoingWebhookArgs,
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { webhookUrl: true },
  });
  if (!project?.webhookUrl) return;

  if (args.purchaseId) {
    const existing = await prisma.outgoingWebhook.findFirst({
      where: {
        projectId: args.projectId,
        eventType: args.eventType,
        purchaseId: args.purchaseId,
        subscriberId: args.subscriberId,
      },
      select: { id: true },
    });
    if (existing) return;
  }

  const payload: PrismaTypes.InputJsonValue = {
    eventType: args.eventType,
    subscriberId: args.subscriberId,
    purchaseId: args.purchaseId ?? null,
    timestamp: new Date().toISOString(),
  };

  await prisma.outgoingWebhook.create({
    data: {
      projectId: args.projectId,
      eventType: args.eventType,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      payload,
      url: project.webhookUrl,
      status: OutgoingWebhookStatus.PENDING,
    },
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
      connection: createBullConnection(),
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
