import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";

const log = logger.child("billing:webhook:subscription_updated");

export interface SubscriptionUpdatedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleSubscriptionUpdated(
  ctx: SubscriptionUpdatedContext,
): Promise<void> {
  const sub = ctx.event.data.object as Stripe.Subscription;
  const existing = await drizzle.billingSubscriptionRepo.findBySubscriptionId(
    ctx.tx,
    sub.id,
  );
  if (!existing) {
    // Out-of-order: subscription.updated arrived before .created.
    // No-op; the next subscription sync (P4 cron) will reconcile.
    log.warn("subscription.updated arrived before .created", {
      stripeSubscriptionId: sub.id,
    });
    return;
  }

  const item = sub.items.data[0];
  if (!item) throw new Error("subscription has no items");

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits?.stripePriceId) {
    throw new Error("missing indie/monthly stripe_price_id");
  }
  // Phase 2: only Indie/monthly is recognised; any other price id is
  // refused so a Phase-4 price swap can't silently downgrade us.
  if (item.price.id !== limits.stripePriceId) {
    throw new Error(`unexpected price_id in P2: ${item.price.id}`);
  }

  await drizzle.billingSubscriptionRepo.updateAfterStripeUpdated(
    ctx.tx,
    sub.id,
    {
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    },
  );

  // Upgrading raises limits — release any usage lock immediately rather
  // than waiting for the next daily usage-cap sweep.
  await drizzle.projectRepo.setUsageLockedAt(ctx.tx, ctx.projectId, null);

  // P2: past_due / dunning state is not yet driven by this handler;
  // P5 layers the dunning_state writes on top.
}
