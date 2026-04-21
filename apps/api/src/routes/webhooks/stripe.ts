import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { verifyStripeWebhook } from "../../middleware/webhook-verify";
import { type HandleStripeNotificationResult } from "../../services/stripe/stripe-webhook";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:stripe");

/**
 * Stripe webhook endpoint.
 *
 * The middleware verifies the Stripe-Signature header (HMAC with a
 * 300s tolerance) using the per-project webhook secret. The handler
 * then checks the project exists and enqueues the already-verified
 * event for async processing.
 */
export const stripeWebhookRoute = new Hono().post(
  "/:projectId",
  verifyStripeWebhook,
  async (c) => {
    const projectId = c.req.param("projectId");

    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      projectId,
    );
    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    const verified = c.get("verifiedWebhook");
    if (!verified || verified.source !== "STRIPE") {
      throw new HTTPException(500, { message: "Verified payload missing" });
    }

    const event = verified.event;

    const job = await enqueueWebhookEvent({
      source: "STRIPE",
      projectId,
      event: JSON.parse(JSON.stringify(event)) as Stripe.Event,
    });

    log.info("stripe notification enqueued", {
      projectId,
      eventType: event.type,
      eventId: event.id,
      jobId: job.id,
    });

    const response: { status: "enqueued"; jobId: string | undefined } = {
      status: "enqueued",
      jobId: job.id,
    };
    return c.json(ok(response), 202);
  },
);

export type { HandleStripeNotificationResult };
