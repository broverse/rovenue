import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { verifyGoogleWebhook } from "../../middleware/webhook-verify";
import { webhookReplayGuard } from "../../middleware/webhook-replay-guard";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:google");

export const pushBodySchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string(),
    publishTime: z.string(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string(),
});

/**
 * Google Play Real-time Developer Notifications webhook (Pub/Sub push).
 *
 * The middleware verifies the Pub/Sub OIDC Bearer token (matches the
 * configured audience). The handler then validates the project exists
 * and enqueues the RTDN payload for async processing.
 */
export const googleWebhookRoute = new Hono().post(
  "/:projectId",
  verifyGoogleWebhook,
  webhookReplayGuard({ source: "google" }),
  zValidator("json", pushBodySchema),
  async (c) => {
    const projectId = c.req.param("projectId");

    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      projectId,
    );
    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    const pushBody = c.req.valid("json");

    const job = await enqueueWebhookEvent({
      source: "GOOGLE",
      projectId,
      pushBody,
    });

    log.info("google notification enqueued", { projectId, jobId: job.id });

    return c.json(ok({ status: "enqueued", jobId: job.id }), 202);
  },
);
