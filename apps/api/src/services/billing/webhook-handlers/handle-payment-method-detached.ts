import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";

export interface PaymentMethodDetachedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handlePaymentMethodDetached(
  ctx: PaymentMethodDetachedContext,
): Promise<void> {
  const pm = ctx.event.data.object as Stripe.PaymentMethod;
  await drizzle.billingPaymentMethodRepo.deleteByStripePaymentMethodId(
    ctx.tx,
    pm.id,
  );
}
