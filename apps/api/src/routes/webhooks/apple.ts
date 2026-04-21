import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyAppleWebhook } from "../../middleware/webhook-verify";
import { webhookReplayGuard } from "../../middleware/webhook-replay-guard";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:apple");

/**
 * App Store Server Notifications V2 webhook.
 *
 * The middleware verifies the JWS signature (x5c chain validated
 * against Apple's root CA) before the handler runs. The verified
 * signedPayload is then enqueued for async processing — the worker
 * re-verifies as defence-in-depth before touching the database.
 */
export const appleWebhookRoute = new Hono().post(
  "/:projectId",
  verifyAppleWebhook,
  webhookReplayGuard({ source: "apple" }),
  async (c) => {
    const projectId = c.req.param("projectId");
    const verified = c.get("verifiedWebhook");
    if (!verified || verified.source !== "APPLE") {
      throw new HTTPException(500, { message: "Verified payload missing" });
    }

    const job = await enqueueWebhookEvent({
      source: "APPLE",
      projectId,
      signedPayload: verified.signedPayload,
    });

    log.info("apple notification enqueued", {
      projectId,
      jobId: job.id,
      notificationType: verified.notification.notificationType,
      notificationUUID: verified.notification.notificationUUID,
    });

    return c.json(ok({ status: "enqueued", jobId: job.id }), 202);
  },
);
