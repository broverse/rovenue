import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma from "@rovenue/db";
import { STRIPE_SIGNATURE_HEADER } from "../../services/stripe/stripe-types";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:stripe");

export const stripeWebhookRoute = new Hono();

/**
 * Stripe webhook endpoint.
 *
 * Reads the raw body (required for signature verification inside the
 * worker), checks the project exists, and enqueues the event for async
 * processing. The worker loads stripeCredentials from the project and
 * verifies the Stripe-Signature header inside the store handler.
 */
stripeWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  const signature = c.req.header(STRIPE_SIGNATURE_HEADER);
  if (!signature) {
    throw new HTTPException(400, {
      message: "Missing Stripe-Signature header",
    });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const rawBody = await c.req.text();

  const job = await enqueueWebhookEvent({
    source: "STRIPE",
    projectId,
    rawBody,
    signature,
  });

  log.info("stripe notification enqueued", { projectId, jobId: job.id });

  return c.json(ok({ status: "enqueued", jobId: job.id }), 202);
});
