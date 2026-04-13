import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import prisma from "@rovenue/db";
import {
  getStripeClient,
  type HandleStripeNotificationResult,
} from "../../services/stripe/stripe-webhook";
import { STRIPE_SIGNATURE_HEADER } from "../../services/stripe/stripe-types";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { loadStripeCredentials } from "../../lib/project-credentials";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:stripe");

export const stripeWebhookRoute = new Hono();

/**
 * Stripe webhook endpoint.
 *
 * Signature verification runs synchronously at the edge so the raw body
 * and webhook secret never leave the process. The verified {@link
 * Stripe.Event} is enqueued for async processing.
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

  const credentials = await loadStripeCredentials(projectId);
  if (!credentials) {
    throw new HTTPException(404, {
      message: "Project not configured for Stripe",
    });
  }

  const rawBody = await c.req.text();
  const stripe = getStripeClient(credentials.secretKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      credentials.webhookSecret,
    );
  } catch (err) {
    log.warn("signature verification failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(400, { message: "Invalid Stripe signature" });
  }

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
});

export type { HandleStripeNotificationResult };
