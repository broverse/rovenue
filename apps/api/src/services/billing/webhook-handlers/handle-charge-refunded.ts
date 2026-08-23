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
  // `amount_refunded` is the charge's CUMULATIVE refunded total — one
  // `charge.refunded` event fires per refund, each carrying the growing
  // cumulative, so summing it across serial partial refunds over-counts.
  // Record this refund's own amount from the newest refund object (Stripe
  // orders `refunds.data` most-recent-first); fall back to the cumulative
  // only when the sub-list is absent. Mirrors applyChargeRefunded in
  // services/stripe/stripe-webhook.ts.
  const cumulativeRefunded = charge.amount_refunded ?? 0;
  const latestRefund = charge.refunds?.data?.[0];
  const refundedMinor = latestRefund?.amount ?? cumulativeRefunded;
  const delta = (refundedMinor / 100).toFixed(4);
  await drizzle.billingInvoiceRepo.incrementRefundedAmount(
    ctx.tx,
    stripeInvoiceId,
    delta,
  );
}
