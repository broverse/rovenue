import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";
import { isBillingEnabled } from "../../lib/billing-flags";
import { logger } from "../../lib/logger";
import { dispatchStripeBillingEvent } from "../../services/billing/webhook-handlers";

const log = logger.child("billing:webhook");

// =============================================================
// /billing/stripe/webhook
// =============================================================
//
// Phase 1: signature verification + audit log only. No state writes.
// Phase 2 swaps the no-op handler body for the real reducer.
//
// Verification uses Stripe's HMAC scheme via stripe.webhooks
// .constructEvent — keeps us compatible with future apiVersion bumps.
// Rejects:
//   - billing disabled              → 404
//   - missing stripe-signature      → 400
//   - signature verification fails  → 400
//   - replay-tolerance exceeded     → 400 (handled inside constructEvent)

export const billingWebhookRoute = new Hono().post("/", async (c) => {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  const stripe = getPlatformStripe();
  if (!stripe || !env.STRIPE_BILLING_WEBHOOK_SECRET) {
    log.error("BILLING_ENABLED=true but Stripe client/secret unavailable");
    throw new HTTPException(503, { message: "Billing not configured" });
  }

  const sig = c.req.header("stripe-signature");
  if (!sig) {
    throw new HTTPException(400, { message: "Missing stripe-signature" });
  }

  // We need the raw bytes; Hono's c.req.text() returns the body string
  // before any JSON parsing, which is what constructEvent expects.
  const raw = await c.req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      sig,
      env.STRIPE_BILLING_WEBHOOK_SECRET,
    );
  } catch (err) {
    log.warn("stripe webhook signature verification failed", {
      err: (err as Error).message,
    });
    throw new HTTPException(400, { message: "Invalid signature" });
  }

  const result = await dispatchStripeBillingEvent(event);
  log.info("billing webhook dispatched", {
    eventId: event.id,
    eventType: event.type,
    result: result.status,
  });
  return c.json({ received: true, result: result.status }, 200);
});
