import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma from "@rovenue/db";
import { handleStripeNotification } from "../../services/stripe/stripe-webhook";
import {
  STRIPE_SIGNATURE_HEADER,
  type StripeProjectCredentials,
} from "../../services/stripe/stripe-types";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:stripe");

const stripeCredentialsSchema = z
  .object({
    secretKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .passthrough();

async function loadCredentials(
  projectId: string,
): Promise<StripeProjectCredentials | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { stripeCredentials: true },
  });
  if (!project?.stripeCredentials) return null;

  const parsed = stripeCredentialsSchema.safeParse(project.stripeCredentials);
  if (!parsed.success) {
    log.warn("project stripeCredentials failed schema validation", {
      projectId,
      issues: parsed.error.issues,
    });
    return null;
  }
  return {
    secretKey: parsed.data.secretKey,
    webhookSecret: parsed.data.webhookSecret,
  };
}

export const stripeWebhookRoute = new Hono();

/**
 * Stripe webhook endpoint.
 *
 * Configure `project.stripeCredentials` to `{ secretKey, webhookSecret }`.
 * The raw request body is read via `c.req.text()` BEFORE any JSON parsing
 * so `stripe.webhooks.constructEvent` can verify the Stripe-Signature
 * header against the webhook secret.
 */
stripeWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  const signature = c.req.header(STRIPE_SIGNATURE_HEADER);
  if (!signature) {
    throw new HTTPException(400, {
      message: "Missing Stripe-Signature header",
    });
  }

  const credentials = await loadCredentials(projectId);
  if (!credentials) {
    throw new HTTPException(404, {
      message: "Project not configured for Stripe",
    });
  }

  const rawBody = await c.req.text();

  const result = await handleStripeNotification({
    projectId,
    rawBody,
    signature,
    credentials,
  });

  log.info("stripe notification handled", {
    projectId,
    status: result.status,
    type: result.eventType,
  });

  return c.json(ok(result));
});
