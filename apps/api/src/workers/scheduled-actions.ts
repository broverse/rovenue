import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import {
  drizzle,
  type Store,
} from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { getStripeClient } from "../services/stripe/stripe-webhook";

type ScheduledActionRow =
  typeof drizzle.schema.scheduledSubscriptionActions.$inferSelect;

// =============================================================
// Scheduled-actions sweep worker
// =============================================================
//
// Runs every 60 seconds via a BullMQ repeatable job. Claims up to
// BATCH_SIZE PENDING rows whose dueAt <= NOW() using SELECT … FOR
// UPDATE SKIP LOCKED, then executes each action inside the same tx.

const log = logger.child("scheduled-actions");

export const SCHEDULED_ACTIONS_QUEUE_NAME = "rovenue-scheduled-actions";

const BATCH_SIZE = 200;
const REPEAT_EVERY_MS = 60 * 1000;
const REPEATABLE_JOB_NAME = "scheduled-actions:sweep";
const REPEATABLE_JOB_ID = "scheduled-actions-repeatable";

// =============================================================
// Core sweep
// =============================================================

export type SweepResult = { executed: number; failed: number };

export async function runScheduledActionsSweep(): Promise<SweepResult> {
  let executed = 0;
  let failed = 0;

  await drizzle.db.transaction(async (tx) => {
    const rows = await drizzle.scheduledActionsRepo.claimDueBatch(
      tx as unknown as typeof drizzle.db,
      BATCH_SIZE,
    );

    for (const row of rows) {
      try {
        await executeAction(tx as unknown as typeof drizzle.db, row);
        await drizzle.scheduledActionsRepo.markExecuted(
          tx as unknown as typeof drizzle.db,
          row.id,
        );
        executed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("scheduled action failed", {
          actionId: row.id,
          purchaseId: row.purchaseId,
          err: message,
        });
        await drizzle.scheduledActionsRepo.markFailed(
          tx as unknown as typeof drizzle.db,
          row.id,
          message,
        );
        failed += 1;
      }
    }
  });

  log.info("scheduled actions sweep complete", { executed, failed });
  return { executed, failed };
}

// =============================================================
// Action executor
// =============================================================

async function executeAction(
  tx: typeof drizzle.db,
  row: ScheduledActionRow,
): Promise<void> {
  const { purchases, subscriberAccess } = drizzle.schema;

  // 1. Load purchase
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(eq(purchases.id, row.purchaseId))
    .limit(1);

  if (!purchase) {
    throw new Error(`executeAction: purchase ${row.purchaseId} not found`);
  }

  const now = new Date();
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const revokeNow = payload.revokeImmediately === true;
  const store = purchase.store as Store;

  switch (store) {
    case "MANUAL": {
      if (revokeNow) {
        // Expire immediately
        await tx
          .update(purchases)
          .set({
            status: "EXPIRED",
            expiresDate: now,
            autoRenewStatus: false,
            cancellationDate: now,
            updatedAt: now,
          })
          .where(eq(purchases.id, purchase.id));

        // Deactivate subscriber_access rows
        await tx
          .update(subscriberAccess)
          .set({ isActive: false, updatedAt: now })
          .where(eq(subscriberAccess.purchaseId, purchase.id));

        // Outbox: CANCELLATION revenue event
        await drizzle.outboxRepo.insert(tx, {
          aggregateType: "REVENUE_EVENT",
          aggregateId: purchase.id,
          eventType: "revenue.event.recorded",
          payload: {
            purchaseId: purchase.id,
            projectId: purchase.projectId,
            subscriberId: purchase.subscriberId,
            productId: purchase.productId,
            type: "CANCELLATION",
            store: "MANUAL",
            amount: "0",
            amountUsd: "0",
            currency: purchase.priceCurrency ?? "USD",
            eventDate: now.toISOString(),
          },
        });
      } else {
        // Soft-cancel: flip autoRenew off, leave expiresDate untouched
        await tx
          .update(purchases)
          .set({
            autoRenewStatus: false,
            cancellationDate: now,
            updatedAt: now,
          })
          .where(eq(purchases.id, purchase.id));
      }
      break;
    }

    case "STRIPE": {
      // Load project Stripe credentials
      const credRow = await drizzle.projectRepo.findProjectCredentials(
        drizzle.db,
        purchase.projectId,
        "stripe",
      );
      const credentials = credRow?.value as
        | { secretKey?: string }
        | null
        | undefined;
      if (!credentials?.secretKey) {
        throw new Error(
          `executeAction: no Stripe secret key for project ${purchase.projectId}`,
        );
      }
      const stripe = getStripeClient(credentials.secretKey);
      await stripe.subscriptions.update(purchase.originalTransactionId, {
        cancel_at_period_end: true,
      });

      await tx
        .update(purchases)
        .set({
          autoRenewStatus: false,
          cancellationDate: now,
          updatedAt: now,
        })
        .where(eq(purchases.id, purchase.id));
      break;
    }

    case "APP_STORE":
    case "PLAY_STORE": {
      // Intent marker only; truth-of-record comes back via store webhook
      await tx
        .update(purchases)
        .set({
          cancellationDate: now,
          updatedAt: now,
        })
        .where(eq(purchases.id, purchase.id));

      // Get the project's webhook URL for outgoing notification
      const webhookUrl = await drizzle.projectRepo.findProjectWebhookUrl(
        drizzle.db,
        purchase.projectId,
      );
      if (webhookUrl) {
        await drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook(tx, {
          projectId: purchase.projectId,
          eventType: "subscription.cancel_requested",
          subscriberId: purchase.subscriberId,
          purchaseId: purchase.id,
          payload: {
            purchaseId: purchase.id,
            subscriberId: purchase.subscriberId,
            store,
            requestedAt: now.toISOString(),
          },
          url: webhookUrl,
        });
      }
      break;
    }

    default: {
      // Exhaustiveness guard
      const _exhaustive: never = store;
      throw new Error(`executeAction: unhandled store ${String(_exhaustive)}`);
    }
  }

  // 4. Audit log
  await audit(
    {
      projectId: purchase.projectId,
      userId: row.createdBy ?? "system",
      action: "subscription.cancel_executed",
      resource: "purchase",
      resourceId: purchase.id,
      before: null,
      after: {
        revokeImmediately: revokeNow,
        store: purchase.store,
        scheduledActionId: row.id,
      },
      ipAddress: null,
      userAgent: null,
    },
    tx,
  );
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

export function getScheduledActionsQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(SCHEDULED_ACTIONS_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the 60-second repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function ensureRepeatable(): Promise<void> {
  const queue = getScheduledActionsQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled actions repeatable job registered", {
    everyMs: REPEAT_EVERY_MS,
  });
}

let cachedWorker: Worker | undefined;

export function getScheduledActionsWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    SCHEDULED_ACTIONS_QUEUE_NAME,
    async (_job: Job) => {
      return runScheduledActionsSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("scheduled-actions job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("scheduled-actions job completed", { jobId: job.id });
  });

  log.info("scheduled-actions worker started", {
    queue: SCHEDULED_ACTIONS_QUEUE_NAME,
  });
  return cachedWorker;
}
