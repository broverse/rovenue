import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { audit } from "../../../lib/audit";
import { publishBillingActivated } from "../billing-events";

// =============================================================
// customer.subscription.created handler
// =============================================================
//
// Runs inside the dispatcher's db.transaction(async tx => ...).
// MUST NOT open its own transaction — the domain write, the audit
// chain row, and the outbox event must all commit atomically.
//
// Phase 2 only recognises the canonical Indie/monthly price; any
// other price id throws. Phase 4 (Pro/Scale/Growth) and Phase 6
// (annual) extend `tierFromPriceId`.

export interface SubscriptionCreatedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

function tierFromPriceId(
  priceId: string,
  indieMonthlyPriceId: string,
): "indie" {
  if (priceId === indieMonthlyPriceId) return "indie";
  throw new Error(`Unknown stripe_price_id: ${priceId}`);
}

export async function handleSubscriptionCreated(
  ctx: SubscriptionCreatedContext,
): Promise<void> {
  const sub = ctx.event.data.object as Stripe.Subscription;

  const item = sub.items.data[0];
  if (!item) throw new Error("subscription has no items");

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits || !limits.stripePriceId) {
    throw new Error("missing indie/monthly stripe_price_id");
  }

  const tier = tierFromPriceId(item.price.id, limits.stripePriceId);

  // Stripe periods are unix seconds.
  const currentPeriodStart = new Date(sub.current_period_start * 1000);
  const currentPeriodEnd = new Date(sub.current_period_end * 1000);

  await drizzle.billingSubscriptionRepo.updateAfterStripeCreated(
    ctx.tx,
    ctx.projectId,
    {
      stripeSubscriptionId: sub.id,
      tier,
      cycle: "monthly",
      currentPeriodStart,
      currentPeriodEnd,
    },
  );

  await audit(
    {
      projectId: ctx.projectId,
      userId: "stripe-webhook",
      action: "billing.subscription.activated",
      resource: "billing_subscription",
      resourceId: sub.id,
      before: null,
      after: {
        tier,
        cycle: "monthly",
        state: "active",
        currentPeriodStart: currentPeriodStart.toISOString(),
        currentPeriodEnd: currentPeriodEnd.toISOString(),
      },
    },
    ctx.tx,
  );

  await publishBillingActivated(ctx.tx, {
    projectId: ctx.projectId,
    tier,
    cycle: "monthly",
    currentPeriodStart,
    currentPeriodEnd,
  });
}
