import { Hono } from "hono";
import { z } from "zod";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:apple");

const bodySchema = z.object({
  signedPayload: z.string().min(1),
});

export const appleWebhookRoute = new Hono();

/**
 * App Store Server Notifications V2 webhook.
 *
 * Enqueues the signed payload for async processing and returns 202. The
 * worker verifies + dispatches the notification via the store handler.
 */
appleWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const body = bodySchema.parse(await c.req.json());

  const job = await enqueueWebhookEvent({
    source: "APPLE",
    projectId,
    signedPayload: body.signedPayload,
  });

  log.info("apple notification enqueued", { projectId, jobId: job.id });

  return c.json(ok({ status: "enqueued", jobId: job.id }), 202);
});
