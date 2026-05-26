import { Redis } from "ioredis";
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
import {
  createNotifierQueues,
  type NotifierQueues,
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
let activeQueues: NotifierQueues | null = null;
let queueConnection: Redis | null = null;

// BullMQ requires its connection to never throw on retries
// (`maxRetriesPerRequest: null`), so we open a second ioredis
// client dedicated to the queue producers rather than reusing
// the app-wide singleton.
function getQueueConnection(): Redis {
  if (queueConnection) return queueConnection;
  queueConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  queueConnection.on("error", (err: Error) => {
    logger.error("notifier-entry.queue_connection", { err: err.message });
  });
  return queueConnection;
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

  // Build the BullMQ producer queues lazily so the test path
  // (which always passes overrides.deps.sendEmailQueue +
  // sendPushQueue) never opens a queue Redis connection.
  const needsProdQueues =
    !overrides.deps?.sendEmailQueue || !overrides.deps?.sendPushQueue;
  if (needsProdQueues && !activeQueues) {
    activeQueues = createNotifierQueues(getQueueConnection());
  }

  const deps: ProcessNotificationDeps = {
    db: overrides.deps?.db ?? getDb(),
    env: overrides.deps?.env ?? {
      DASHBOARD_URL: env.DASHBOARD_URL,
      UNSUB_SIGNING_KEY: env.UNSUB_SIGNING_KEY ?? "",
      UNSUB_MAILTO: env.UNSUB_MAILTO,
    },
    prefsCache: overrides.deps?.prefsCache ?? activeCache!,
    sendEmailQueue:
      overrides.deps?.sendEmailQueue ?? activeQueues!.emailEnqueue,
    sendPushQueue:
      overrides.deps?.sendPushQueue ?? activeQueues!.pushEnqueue,
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
  if (activeQueues) {
    await activeQueues.close();
    activeQueues = null;
  }
  if (queueConnection) {
    queueConnection.disconnect();
    queueConnection = null;
  }
}
