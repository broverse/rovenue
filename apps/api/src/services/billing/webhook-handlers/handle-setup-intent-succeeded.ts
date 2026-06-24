import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { getPlatformStripe } from "../../../lib/stripe-billing";
import { logger } from "../../../lib/logger";
import { publishBillingPaymentMethodAdded } from "../billing-events";

// =============================================================
// setup_intent.succeeded handler
// =============================================================
//
// Runs inside the dispatcher's db.transaction(async tx => ...).
// MUST NOT open its own transaction.
//
// Two flavours, distinguished by intent.metadata.rovenue_flow:
//   - "upgrade" — first PM for an upgrading project; after the tx
//     commits we update the customer's default PM and create the
//     subscription (default_incomplete) on the indie/monthly price.
//   - "add_pm" (or unset) — just insert the PM row + outbox event.
//
// Stripe API calls inside the tx (paymentMethods.retrieve) match the
// Phase-1 webhook precedent; subscriptions.create is deferred to the
// followUp closure so a slow Stripe roundtrip never holds a Postgres
// tx open. The dispatcher (Task 17) runs the closure after commit.
// `idempotencyKey: "sub-create-${projectId}"` makes Stripe retries
// safe — two webhook deliveries can't double-create the subscription.

const log = logger.child("billing:webhook:setup_intent_succeeded");

export interface SetupIntentSucceededContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleSetupIntentSucceeded(
  ctx: SetupIntentSucceededContext,
): Promise<{ followUp?: () => Promise<void> }> {
  const intent = ctx.event.data.object as Stripe.SetupIntent;

  if (intent.status !== "succeeded" || !intent.payment_method) {
    log.warn("setup_intent not in usable state — skipping", {
      eventId: ctx.event.id,
      projectId: ctx.projectId,
      status: intent.status,
      hasPaymentMethod: Boolean(intent.payment_method),
    });
    return {};
  }

  const stripe = getPlatformStripe();
  if (!stripe) {
    // Surface to dispatcher's outer try → 500 → Stripe retries.
    throw new Error("Stripe client unavailable");
  }

  const pmId =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method.id;

  const pm = await stripe.paymentMethods.retrieve(pmId);

  if (pm.type !== "card" || !pm.card) {
    log.warn("payment method is not a card — skipping", {
      eventId: ctx.event.id,
      projectId: ctx.projectId,
      pmId,
      type: pm.type,
    });
    return {};
  }

  // Idempotent on re-run: a prior attempt may have committed the PM insert
  // and then had its post-commit follow-up (subscriptions.create) fail,
  // leaving the webhook re-claimable. Stripe's retry re-enters this handler,
  // so we must not re-insert (stripe_payment_method_id is UNIQUE → would
  // throw and starve the follow-up retry) or re-emit the outbox event.
  let inserted = await drizzle.billingPaymentMethodRepo.findByStripePaymentMethodId(
    ctx.tx,
    pm.id,
  );
  if (!inserted) {
    const existingDefault = await drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod(
      ctx.tx,
      ctx.projectId,
    );
    const isDefault = existingDefault === null;

    inserted = await drizzle.billingPaymentMethodRepo.insertPaymentMethod(
      ctx.tx,
      {
        projectId: ctx.projectId,
        stripePaymentMethodId: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        isDefault,
      },
    );

    await publishBillingPaymentMethodAdded(ctx.tx, {
      projectId: ctx.projectId,
      paymentMethodId: inserted.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
    });
  }

  const flow = intent.metadata?.rovenue_flow;
  if (flow !== "upgrade") {
    log.info("setup_intent processed (no upgrade follow-up)", {
      eventId: ctx.event.id,
      projectId: ctx.projectId,
      flow: flow ?? null,
      paymentMethodId: inserted.id,
    });
    return {};
  }

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits || !limits.stripePriceId) {
    throw new Error(
      "billing_tier_limits row for (indie, monthly) is missing or has no stripe_price_id — cannot create subscription",
    );
  }

  const priceId = limits.stripePriceId;
  const customerId = intent.customer as string;

  return {
    followUp: async () => {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
      try {
        await stripe.subscriptions.create(
          {
            customer: customerId,
            items: [{ price: priceId }],
            default_payment_method: pmId,
            payment_behavior: "default_incomplete",
            expand: ["latest_invoice.payment_intent"],
            metadata: { rovenue_project_id: ctx.projectId },
          },
          { idempotencyKey: `sub-create-${ctx.projectId}` },
        );
      } catch (e) {
        log.error("subscriptions.create failed", {
          projectId: ctx.projectId,
          err: (e as Error).message,
        });
        throw e;
      }
    },
  };
}
