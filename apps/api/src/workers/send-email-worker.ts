// =============================================================
// send-email worker
// =============================================================
//
// BullMQ consumer for `notifier:send-email`. Per job:
//   1. Re-check the suppression list (the notifier already
//      gated on it, but a row may have been added between
//      enqueue and execution).
//   2. Hand off to the injected `Mailer`.
//   3. Transition the notification_delivery row.
//
// Retries are handled by BullMQ via `attempts` on the queue;
// permanent failure (attempts exhausted) is materialised in the
// delivery row from the `failed` handler so the dashboard shows
// it without a periodic scan.

import { Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import { drizzle, type Db } from "@rovenue/db";
import type { Mailer } from "../lib/mailer";
import type { Logger } from "../lib/logger";
import {
  incDispatched,
  observeSendDuration,
} from "../lib/metrics-notifications";
import { isEmailSuppressed } from "../services/notifications/suppression";
import { SEND_EMAIL_QUEUE_NAME, type SendEmailJob } from "../queues/notifier";

const { notificationDeliveryRepo } = drizzle;

export interface SendEmailWorkerDeps {
  connection: IORedis;
  db: Db;
  mailer: Mailer;
  logger: Logger;
  /** Defaults to 10 — matches the plan's BullMQ shape. */
  concurrency?: number;
  /** SES sandbox default of 14/s; configurable for prod tier or tests. */
  rateLimit?: { max: number; duration: number };
}

export function startSendEmailWorker(
  deps: SendEmailWorkerDeps,
): Worker<SendEmailJob> {
  const log = deps.logger.child("notifier.send-email");

  const worker = new Worker<SendEmailJob>(
    SEND_EMAIL_QUEUE_NAME,
    async (job: Job<SendEmailJob>) => {
      const { data } = job;
      const to = data.to.toLowerCase();

      if (await isEmailSuppressed(deps.db, to)) {
        await notificationDeliveryRepo.markDeliveryStatus(
          deps.db,
          data.deliveryId,
          "suppressed",
          { providerResponse: { reason: "suppressed_list" } },
        );
        incDispatched("unknown", "email", "suppressed");
        log.info("suppressed", { deliveryId: data.deliveryId });
        return;
      }

      await notificationDeliveryRepo.incrementDeliveryAttempts(
        deps.db,
        data.deliveryId,
      );

      const startMs = performance.now();
      const result = await deps.mailer.send({
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
        headers: data.headers,
        correlationId: data.deliveryId,
      });
      observeSendDuration("email", "ses", "ok", performance.now() - startMs);

      await notificationDeliveryRepo.markDeliveryStatus(
        deps.db,
        data.deliveryId,
        "sent",
        { providerMessageId: result.messageId },
      );
      incDispatched("unknown", "email", "delivered");
      log.info("sent", {
        deliveryId: data.deliveryId,
        providerMessageId: result.messageId,
      });
    },
    {
      connection: deps.connection,
      concurrency: deps.concurrency ?? 10,
      limiter: deps.rateLimit ?? { max: 14, duration: 1_000 },
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    log.warn("attempt_failed", {
      deliveryId: job.data.deliveryId,
      attemptsMade: job.attemptsMade,
      attempts,
      err: err?.message,
    });
    if (job.attemptsMade >= attempts) {
      try {
        await notificationDeliveryRepo.markDeliveryStatus(
          deps.db,
          job.data.deliveryId,
          "failed",
          { providerResponse: { error: err?.message ?? "unknown" } },
        );
        incDispatched("unknown", "email", "failed");
      } catch (markErr) {
        log.error("mark_failed_error", {
          deliveryId: job.data.deliveryId,
          err: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
    }
  });

  worker.on("error", (err) => {
    log.error("worker_error", { err: err.message });
  });

  return worker;
}
