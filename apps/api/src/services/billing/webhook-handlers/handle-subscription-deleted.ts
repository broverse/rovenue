import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";

const log = logger.child("billing:webhook:subscription_deleted");

export interface SubscriptionDeletedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

/**
 * `customer.subscription.deleted` — the project's paid plan was canceled or
 * ended in Stripe. Downgrade the billing record back to the free plan so the
 * project stops getting paid-tier capabilities/limits. Mirror image of
 * `handle-subscription-created`; without it a lapsed plan kept its elevated
 * tier forever (audit SB1).
 */
export async function handleSubscriptionDeleted(
  ctx: SubscriptionDeletedContext,
): Promise<void> {
  const sub = ctx.event.data.object as Stripe.Subscription;

  const existing = await drizzle.billingSubscriptionRepo.findBySubscriptionId(
    ctx.tx,
    sub.id,
  );
  if (!existing) {
    // Unknown / already reconciled — nothing to downgrade.
    log.warn("subscription.deleted for unknown subscription", {
      stripeSubscriptionId: sub.id,
    });
    return;
  }

  await drizzle.billingSubscriptionRepo.downgradeToFreeOnDeleted(
    ctx.tx,
    sub.id,
  );

  log.info("billing subscription downgraded to free on stripe deletion", {
    projectId: ctx.projectId,
    stripeSubscriptionId: sub.id,
  });
}
