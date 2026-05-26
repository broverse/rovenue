// =============================================================
// send-workers-entry — boots the BullMQ send consumers
// =============================================================
//
// Phase 10 ships the workers themselves (send-email-worker /
// send-push-worker); this module packages them into a single
// `startSendWorkers()` so Phase 15 can drop one call into the
// shared index.ts (or a dedicated process). Tests construct the
// workers directly and don't go through here.

import { Redis } from "ioredis";
import type { Worker } from "bullmq";
import { getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { mailer as defaultMailer } from "../lib/mailer";
import { createPushTransports } from "../lib/push";
import type { SendEmailJob, SendPushJob } from "../queues/notifier";
import { startSendEmailWorker } from "./send-email-worker";
import { startSendPushWorker } from "./send-push-worker";

interface RunningWorkers {
  email: Worker<SendEmailJob>;
  push: Worker<SendPushJob>;
  connection: Redis;
}

let running: RunningWorkers | null = null;

export function startSendWorkers(): RunningWorkers {
  if (running) return running;

  // Dedicated connection — BullMQ workers require
  // `maxRetriesPerRequest: null` on their connection, which
  // would weaken the app-wide redis singleton if we reused it.
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  connection.on("error", (err: Error) => {
    logger.error("send-workers.connection", { err: err.message });
  });

  const db = getDb();
  const transports = createPushTransports(env);
  if (!transports.ios && !transports.android) {
    logger.warn("send-workers: no push transports configured");
  }

  running = {
    connection,
    email: startSendEmailWorker({
      connection,
      db,
      mailer: defaultMailer(),
      logger,
    }),
    push: startSendPushWorker({
      connection,
      db,
      transports,
      logger,
    }),
  };
  logger.info("send-workers: started");
  return running;
}

export async function stopSendWorkers(): Promise<void> {
  if (!running) return;
  await Promise.all([running.email.close(), running.push.close()]);
  running.connection.disconnect();
  running = null;
}
