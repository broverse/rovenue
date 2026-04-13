import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import prisma, {
  CreditLedgerType,
  OutgoingWebhookStatus,
  ProductType,
  type Prisma as PrismaTypes,
} from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
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
  handleStripeNotification,
  type HandleStripeNotificationResult,
  type StripeProjectCredentials,
} from "./stripe";

const log = logger.child("webhook-processor");

export const WEBHOOK_QUEUE_NAME = "rovenue:webhooks";

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
      source: "STRIPE";
      projectId: string;
      rawBody: string;
      signature: string;
    };

export type WebhookJobResult =
  | HandleAppleNotificationResult
  | HandleGoogleNotificationResult
  | HandleStripeNotificationResult;

// =============================================================
// BullMQ connection + queue
// =============================================================

function createBullConnection(): Redis {
  // BullMQ requires maxRetriesPerRequest: null; the shared lib/redis.ts
  // client uses retries for general command safety, so we use a dedicated
  // connection for the queue.
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

/**
 * Process a verified webhook event end-to-end:
 *  1. Dispatch to the store handler (idempotent via WebhookEvent dedup).
 *  2. Reconcile subscriber entitlements via access-engine.syncAccess.
 *  3. Credit consumable purchases idempotently via credit-engine.
 *  4. Insert a pending row into outgoing_webhooks for downstream delivery.
 */
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
      const verifyConfig = await loadGoogleVerifyConfig(data.projectId);
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
      return handleStripeNotification({
        projectId: data.projectId,
        rawBody: data.rawBody,
        signature: data.signature,
        credentials,
      });
    }
  }
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
  // Defensive access reconciliation — handlers already update access inline,
  // this catches any drift from edge cases.
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

  // Idempotency: if this purchase has already been credited, skip.
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

  // Idempotency: dedupe on (projectId, eventType, purchaseId, subscriberId).
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
// Per-project credential loaders (worker-side)
// =============================================================

const googleCredentialsSchema = z
  .object({
    packageName: z.string().min(1),
    serviceAccount: z
      .object({
        client_email: z.string().email(),
        private_key: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

async function loadGoogleVerifyConfig(
  projectId: string,
): Promise<GoogleVerifyConfig | undefined> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { googleCredentials: true },
  });
  if (!project?.googleCredentials) return undefined;

  const parsed = googleCredentialsSchema.safeParse(project.googleCredentials);
  if (!parsed.success) {
    log.warn("project googleCredentials failed schema validation", {
      projectId,
      issues: parsed.error.issues,
    });
    return undefined;
  }
  return {
    packageName: parsed.data.packageName,
    credentials: parsed.data.serviceAccount as GoogleServiceAccountCredentials,
  };
}

const stripeCredentialsSchema = z
  .object({
    secretKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .passthrough();

async function loadStripeCredentials(
  projectId: string,
): Promise<StripeProjectCredentials | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { stripeCredentials: true },
  });
  if (!project?.stripeCredentials) return null;

  const parsed = stripeCredentialsSchema.safeParse(project.stripeCredentials);
  if (!parsed.success) {
    log.warn("project stripeCredentials failed schema validation", {
      projectId,
      issues: parsed.error.issues,
    });
    return null;
  }
  return {
    secretKey: parsed.data.secretKey,
    webhookSecret: parsed.data.webhookSecret,
  };
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
