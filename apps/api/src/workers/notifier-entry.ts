import { getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { assertTopic, getKafka } from "../lib/kafka";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import {
  createPrefsCache,
  type PrefsCache,
} from "../services/notifications/prefs-cache";
import {
  processNotification,
  type ProcessNotificationDeps,
} from "../services/notifications/process-notification";
import type {
  SendEmailJob,
  SendEmailQueue,
  SendPushJob,
  SendPushQueue,
} from "../queues/notifier";
import {
  NOTIFICATIONS_DLQ_TOPIC,
  NOTIFICATIONS_TOPIC,
  startNotifier,
  type NotifyPayload,
} from "./notifier";

// =============================================================
// notifier-entry — standalone process bootstrapper
// =============================================================
//
// Assembles dependencies for the notifier worker and starts the
// Kafka consumer. Default deps:
//
//   db          → singleton @rovenue/db pool
//   prefsCache  → LRU + Redis pub/sub invalidation (Phase 9.2)
//   sendQueues  → log-only stubs (Phase 10 replaces with BullMQ)
//
// Tests can pass `overrides` to inject in-memory queues + a fresh
// cache without touching the singletons.

let running: Awaited<ReturnType<typeof startNotifier>> | null = null;
let activeCache: PrefsCache | null = null;

// Phase 10 will swap these for real BullMQ queues. Until then the
// notifier-worker process boots and consumes correctly but emails
// and push notifications are only logged — the delivery rows still
// land in Postgres with status='queued' so a follow-up redeploy of
// the send workers can drain them once they exist.
function buildStubQueues(): { email: SendEmailQueue; push: SendPushQueue } {
  return {
    email: {
      add: async (job: SendEmailJob) => {
        logger.info("notifier.stub.email", {
          deliveryId: job.deliveryId,
          to: job.to,
          subject: job.subject,
        });
      },
    },
    push: {
      add: async (job: SendPushJob) => {
        logger.info("notifier.stub.push", {
          deliveryId: job.deliveryId,
          userId: job.userId,
          title: job.title,
        });
      },
    },
  };
}

export interface RunNotifierOverrides {
  processMessage?: (payload: NotifyPayload) => Promise<void>;
  deps?: Partial<ProcessNotificationDeps>;
}

export async function runNotifier(
  overrides: RunNotifierOverrides = {},
): Promise<void> {
  const kafka = getKafka();
  if (!kafka) {
    logger.warn("notifier-entry: KAFKA_BROKERS unset, skipping worker");
    return;
  }

  await assertTopic(NOTIFICATIONS_TOPIC);
  await assertTopic(NOTIFICATIONS_DLQ_TOPIC);

  // Build the prefs cache once per process. Tests that pass an
  // override skip this so they don't open a real Redis subscriber.
  if (!activeCache && !overrides.deps?.prefsCache) {
    activeCache = createPrefsCache(redis);
  }

  const stubs = buildStubQueues();
  const deps: ProcessNotificationDeps = {
    db: overrides.deps?.db ?? getDb(),
    env: overrides.deps?.env ?? {
      DASHBOARD_URL: env.DASHBOARD_URL,
      UNSUB_SIGNING_KEY: env.UNSUB_SIGNING_KEY ?? "",
      UNSUB_MAILTO: env.UNSUB_MAILTO,
    },
    prefsCache: overrides.deps?.prefsCache ?? activeCache!,
    sendEmailQueue: overrides.deps?.sendEmailQueue ?? stubs.email,
    sendPushQueue: overrides.deps?.sendPushQueue ?? stubs.push,
  };

  const processMessage =
    overrides.processMessage ??
    (async (payload: NotifyPayload) => {
      try {
        await processNotification(deps, payload);
      } catch (err) {
        // Re-throw so the notifier worker routes the message to the
        // DLQ — `processNotification` itself only throws on
        // catastrophic upstream failures (schema mismatch, DB down).
        logger.error("notifier.process_failed", {
          eventKey: payload.eventKey,
          eventId: payload.eventId,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

  running = await startNotifier({
    kafka,
    logger,
    processMessage,
  });

  logger.info("notifier-entry: started");
}

export async function stopNotifier(): Promise<void> {
  if (running) {
    await running.stop();
    running = null;
  }
  if (activeCache) {
    await activeCache.close();
    activeCache = null;
  }
}
