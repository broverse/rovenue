import type Stripe from "stripe";
import { drizzle, db, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";
import { handleSetupIntentSucceeded } from "./handle-setup-intent-succeeded";
import { handleSubscriptionCreated } from "./handle-subscription-created";
import { handleSubscriptionUpdated } from "./handle-subscription-updated";
import { handleSubscriptionDeleted } from "./handle-subscription-deleted";
import { handleInvoiceUpsert } from "./handle-invoice-upsert";
import { handleInvoicePaymentSucceeded } from "./handle-invoice-payment-succeeded";
import { handleChargeRefunded } from "./handle-charge-refunded";
import { handlePaymentMethodDetached } from "./handle-payment-method-detached";

// =============================================================
// Stripe billing webhook dispatcher
// =============================================================
//
// Single seam between Stripe's HTTP delivery and the per-event
// handlers. Responsibilities:
//   1. Filter to event types we handle (else `ignored`).
//   2. Resolve project from the event's customer field — handlers
//      receive a `projectId`, never a customer id.
//   3. Dedupe via `webhook_events` keyed on (source, storeEventId)
//      so Stripe's at-least-once retries collapse to one effect.
//   4. Run the matched handler inside a single Postgres tx; the
//      handler MUST NOT open its own transaction.
//   5. Execute any post-commit follow-up the handler returned
//      (currently only `setup_intent.succeeded` returns one — the
//      `stripe.subscriptions.create` roundtrip is too slow to hold
//      a tx open for). The follow-up itself must be idempotent
//      (use a Stripe `idempotencyKey`) so a webhook retry that
//      re-runs the follow-up is safe.

const log = logger.child("billing:webhook:dispatch");

export type DispatchResult =
  | { status: "ok" }
  | { status: "ignored" }
  | { status: "duplicate" }
  | { status: "project_not_found" };

type HandlerResult = { followUp?: () => Promise<void> } | void;

interface Ctx {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

const handlers: Record<string, (ctx: Ctx) => Promise<HandlerResult>> = {
  "setup_intent.succeeded": (ctx) => handleSetupIntentSucceeded(ctx),
  "customer.subscription.created": (ctx) => handleSubscriptionCreated(ctx),
  "customer.subscription.updated": (ctx) => handleSubscriptionUpdated(ctx),
  "customer.subscription.deleted": (ctx) => handleSubscriptionDeleted(ctx),
  "invoice.created": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.finalized": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.updated": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.payment_succeeded": (ctx) => handleInvoicePaymentSucceeded(ctx),
  "charge.refunded": (ctx) => handleChargeRefunded(ctx),
  "payment_method.detached": (ctx) => handlePaymentMethodDetached(ctx),
};

function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data.object as {
    customer?: string | { id: string } | null;
  };
  if (!obj.customer) return null;
  return typeof obj.customer === "string" ? obj.customer : obj.customer.id;
}

export async function dispatchStripeBillingEvent(
  event: Stripe.Event,
): Promise<DispatchResult> {
  const handler = handlers[event.type];
  if (!handler) {
    log.debug("ignored event type", { type: event.type, id: event.id });
    return { status: "ignored" };
  }

  const customerId = extractCustomerId(event);
  if (!customerId) {
    log.warn("event has no customer field", {
      type: event.type,
      id: event.id,
    });
    return { status: "project_not_found" };
  }

  const sub = await drizzle.billingSubscriptionRepo.findByStripeCustomerId(
    db,
    customerId,
  );
  if (!sub) {
    log.warn("no billing_subscriptions row for customer", {
      customerId,
      eventId: event.id,
    });
    return { status: "project_not_found" };
  }

  const projectId = sub.projectId;

  // Atomic single-flight claim via webhook_events dedupe table. The
  // claim sets PROCESSING itself (folding the prior RECEIVED step).
  // FAILED/RECEIVED rows stay re-claimable so Stripe's at-least-once
  // retries re-process. This closes the double-dispatch race the old no-op
  // upsert + `status === PROCESSED` guard left open under worker
  // concurrency.
  const claimResult = await drizzle.webhookEventRepo.claimWebhookEvent(db, {
    projectId,
    // Distinct from the per-project store "STRIPE" source: this is the
    // platform billing account, whose Stripe event-id space is independent.
    // Sharing the source risked a silent cross-account dedup collision.
    source: "STRIPE_BILLING",
    eventType: event.type,
    storeEventId: event.id,
    payload: event as unknown,
  });
  if (claimResult.outcome === "duplicate") {
    return { status: "duplicate" };
  }
  if (claimResult.outcome === "in_progress") {
    // Another worker holds a fresh claim. Throw so BullMQ retries with
    // backoff instead of acking — prevents the historical bug where a
    // retry of our own crashed attempt silently dropped the event.
    throw new Error(`webhook ${event.id} claim in progress; retry`);
  }
  const whRow = claimResult.row;

  let followUp: (() => Promise<void>) | undefined;

  await db.transaction(async (tx) => {
    const result = await handler({ tx, event, projectId });
    if (result && "followUp" in result && result.followUp) {
      followUp = result.followUp;
    }
    await drizzle.webhookEventRepo.updateWebhookEvent(tx, whRow.id, {
      status: "PROCESSED",
      processedAt: new Date(),
    });
  });

  // Stripe API call AFTER tx commit. If it throws, Stripe will
  // retry the webhook; our webhook_events dedupe means handlers
  // are no-ops on the second attempt. The follow-up itself uses
  // stripe.subscriptions.create with an idempotency key, so a retry
  // is a no-op there too.
  if (followUp) {
    await followUp();
  }

  return { status: "ok" };
}
