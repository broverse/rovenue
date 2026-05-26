// =============================================================
// send-push worker
// =============================================================
//
// BullMQ consumer for `notifier-send-push`. Per job:
//   1. List the user's active push_devices.
//   2. Fan out to the per-platform transport (APNs / FCM).
//   3. Permanent failures revoke the device token; transient
//      failures retry via BullMQ's attempts budget.
//   4. First successful send marks the delivery row 'sent'. If
//      every device fails permanently we mark 'failed' on the
//      spot (no retry would help). If every device fails
//      transiently we rethrow so BullMQ retries the whole job.
//
// v1 records exactly one delivery row per push channel — the
// row stands for "we tried push for this user" rather than a
// per-device receipt. The dashboard can drill into per-device
// outcomes via providerResponse once feedback webhooks land.

import { Worker, UnrecoverableError, type Job } from "bullmq";
import type IORedis from "ioredis";
import { drizzle, type Db } from "@rovenue/db";
import type {
  PushMessage,
  PushSendOutcome,
  PushTransport,
} from "../lib/push";
import type { PushTransports } from "../lib/push";
import type { Logger } from "../lib/logger";
import {
  incDispatched,
  incPushDevicesRevoked,
} from "../lib/metrics-notifications";
import { captureNotifierError } from "../lib/sentry-notifications";
import { SEND_PUSH_QUEUE_NAME, type SendPushJob } from "../queues/notifier";

const { notificationDeliveryRepo, pushDeviceRepo } = drizzle;

export interface SendPushWorkerDeps {
  connection: IORedis;
  db: Db;
  transports: PushTransports;
  logger: Logger;
  concurrency?: number;
  /** APNs/FCM both publish ~per-app limits; default 60/s is conservative. */
  rateLimit?: { max: number; duration: number };
}

interface DeviceOutcome {
  platform: "ios" | "android";
  token: string;
  outcome: PushSendOutcome;
}

export function startSendPushWorker(
  deps: SendPushWorkerDeps,
): Worker<SendPushJob> {
  const log = deps.logger.child("notifier.send-push");

  const worker = new Worker<SendPushJob>(
    SEND_PUSH_QUEUE_NAME,
    async (job: Job<SendPushJob>) => {
      const { data } = job;

      const devices = await pushDeviceRepo.listActivePushDevicesForUser(
        deps.db,
        data.userId,
      );
      if (devices.length === 0) {
        await notificationDeliveryRepo.markDeliveryStatus(
          deps.db,
          data.deliveryId,
          "failed",
          { providerResponse: { reason: "no_active_devices" } },
        );
        // No retry — device list won't change inside the BullMQ window.
        throw new UnrecoverableError("no active devices for user");
      }

      await notificationDeliveryRepo.incrementDeliveryAttempts(
        deps.db,
        data.deliveryId,
      );

      const outcomes: DeviceOutcome[] = [];
      for (const device of devices) {
        const transport: PushTransport | undefined =
          device.platform === "ios" ? deps.transports.ios : deps.transports.android;
        if (!transport) {
          outcomes.push({
            platform: device.platform,
            token: device.token,
            outcome: {
              ok: false,
              error: "no_transport",
              permanent: false,
            },
          });
          continue;
        }
        const msg: PushMessage = {
          deviceToken: device.token,
          title: data.title,
          body: data.body,
          data: data.data,
        };
        try {
          outcomes.push({
            platform: device.platform,
            token: device.token,
            outcome: await transport.send(msg),
          });
        } catch (err) {
          outcomes.push({
            platform: device.platform,
            token: device.token,
            outcome: {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              permanent: false,
            },
          });
        }
      }

      // Revoke permanently-invalid tokens regardless of how the
      // overall delivery resolves. Doing it inside the worker
      // keeps the device table clean even if we end up retrying.
      for (const r of outcomes) {
        if (!r.outcome.ok && r.outcome.permanent) {
          await pushDeviceRepo.revokePushDeviceByToken(
            deps.db,
            r.platform,
            r.token,
          );
          incPushDevicesRevoked(r.platform, r.outcome.error);
        }
      }

      const firstOk = outcomes.find(
        (o): o is DeviceOutcome & { outcome: { ok: true; providerMessageId: string } } =>
          o.outcome.ok,
      );

      if (firstOk) {
        await notificationDeliveryRepo.markDeliveryStatus(
          deps.db,
          data.deliveryId,
          "sent",
          {
            providerMessageId: firstOk.outcome.providerMessageId,
            providerResponse: { devices: summariseOutcomes(outcomes) },
          },
        );
        incDispatched("unknown", "push", "delivered");
        log.info("sent", {
          deliveryId: data.deliveryId,
          devices: outcomes.length,
        });
        return;
      }

      // No device succeeded. Distinguish permanent-all (no point
      // retrying) from transient-any (BullMQ should retry).
      const anyTransient = outcomes.some(
        (o) => !o.outcome.ok && !o.outcome.permanent,
      );
      if (anyTransient) {
        log.warn("all_failed_transient", {
          deliveryId: data.deliveryId,
          outcomes: summariseOutcomes(outcomes),
        });
        throw new Error("all push sends failed (transient)");
      }

      await notificationDeliveryRepo.markDeliveryStatus(
        deps.db,
        data.deliveryId,
        "failed",
        { providerResponse: { devices: summariseOutcomes(outcomes) } },
      );
      incDispatched("unknown", "push", "failed");
      captureNotifierError(
        new Error("all push sends failed (permanent)"),
        {
          component: "send-push",
          channel: "push",
          userId: data.userId,
          deliveryId: data.deliveryId,
          reason: "all_devices_permanent",
        },
      );
      throw new UnrecoverableError("all push sends failed (permanent)");
    },
    {
      connection: deps.connection,
      concurrency: deps.concurrency ?? 10,
      limiter: deps.rateLimit ?? { max: 60, duration: 1_000 },
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
    if (err instanceof UnrecoverableError) {
      // Status row was already written before the throw; nothing else to do.
      return;
    }
    if (job.attemptsMade >= attempts) {
      try {
        await notificationDeliveryRepo.markDeliveryStatus(
          deps.db,
          job.data.deliveryId,
          "failed",
          { providerResponse: { error: err?.message ?? "unknown" } },
        );
        captureNotifierError(err ?? new Error("unknown push failure"), {
          component: "send-push",
          channel: "push",
          userId: job.data.userId,
          deliveryId: job.data.deliveryId,
          reason: "attempts_exhausted",
        });
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

function summariseOutcomes(outcomes: DeviceOutcome[]) {
  return outcomes.map((o) => ({
    platform: o.platform,
    token: o.token.slice(0, 6) + "…",
    ...(o.outcome.ok
      ? { ok: true, providerMessageId: o.outcome.providerMessageId }
      : {
          ok: false,
          permanent: o.outcome.permanent,
          error: o.outcome.error,
        }),
  }));
}
