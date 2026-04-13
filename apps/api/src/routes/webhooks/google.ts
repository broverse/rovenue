import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { BEARER_SCHEME, HEADER } from "@rovenue/shared";
import prisma from "@rovenue/db";
import { verifyPubSubPushToken } from "../../services/google/google-auth";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { env } from "../../lib/env";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:google");

const pushBodySchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string(),
    publishTime: z.string(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string(),
});

async function enforcePubSubAuth(
  authHeader: string | undefined,
): Promise<void> {
  if (!env.PUBSUB_PUSH_AUDIENCE) return;

  const prefix = `${BEARER_SCHEME.toLowerCase()} `;
  if (!authHeader || !authHeader.toLowerCase().startsWith(prefix)) {
    throw new HTTPException(401, { message: "Pub/Sub Bearer token required" });
  }

  const idToken = authHeader.slice(prefix.length).trim();
  try {
    await verifyPubSubPushToken(idToken, {
      audience: env.PUBSUB_PUSH_AUDIENCE,
      serviceAccountEmail: env.PUBSUB_PUSH_SERVICE_ACCOUNT,
    });
  } catch (err) {
    log.warn("pubsub token verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid Pub/Sub token" });
  }
}

export const googleWebhookRoute = new Hono();

/**
 * Google Play Real-time Developer Notifications webhook (Pub/Sub push).
 *
 * Verifies the Pub/Sub OIDC token (if PUBSUB_PUSH_AUDIENCE is set), checks
 * the project exists, then enqueues the RTDN payload for async processing.
 */
googleWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  await enforcePubSubAuth(c.req.header(HEADER.AUTHORIZATION));

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const pushBody = pushBodySchema.parse(await c.req.json());

  const job = await enqueueWebhookEvent({
    source: "GOOGLE",
    projectId,
    pushBody,
  });

  log.info("google notification enqueued", { projectId, jobId: job.id });

  return c.json(ok({ status: "enqueued", jobId: job.id }), 202);
});
