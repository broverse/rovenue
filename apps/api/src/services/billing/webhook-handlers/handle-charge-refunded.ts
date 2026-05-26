import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";

const log = logger.child("billing:webhook:charge_refunded");

export interface ChargeRefundedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleChargeRefunded(
  ctx: ChargeRefundedContext,
): Promise<void> {
  const charge = ctx.event.data.object as Stripe.Charge;
  if (!charge.invoice) {
    log.info("charge.refunded with no invoice — skipping", { id: charge.id });
    return;
  }
  const stripeInvoiceId =
    typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id;
  const delta = (charge.amount_refunded / 100).toFixed(4);
  await drizzle.billingInvoiceRepo.incrementRefundedAmount(
    ctx.tx,
    stripeInvoiceId,
    delta,
  );
}
