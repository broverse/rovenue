import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { publishBillingInvoicePaid } from "../billing-events";

// =============================================================
// invoice.payment_succeeded handler
// =============================================================
//
// Domain-meaningful event (someone got paid). Two outputs:
//   1. Upsert the `billing_invoices` row with `status="paid"`. The
//      earlier `invoice.created` may have already written it; this
//      handler converges the status / amounts / attempt counters.
//   2. Look up the upserted row to get its cuid2 id, then publish
//      a `billing.invoice.paid` outbox event with that id —
//      downstream analytics consumers prefer our internal id over
//      the Stripe in_* identifier.
//
// Runs inside the dispatcher's db.transaction(async tx => ...) —
// MUST NOT open its own transaction. Same tx-bound Db convention
// as the rest of the webhook-handlers / billing-events
// publishers.
//
// Phase 2 deliberately stops short of dunning recovery semantics
// (clearing billing_dunning_state + emitting billing.recovered).
// Those require the dunning row, which only P5 introduces writes
// for.

export interface InvoicePaidContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleInvoicePaymentSucceeded(
  ctx: InvoicePaidContext,
): Promise<void> {
  const inv = ctx.event.data.object as Stripe.Invoice;
  await drizzle.billingInvoiceRepo.upsertInvoiceFromStripe(ctx.tx, {
    projectId: ctx.projectId,
    stripeInvoiceId: inv.id,
    number: inv.number ?? inv.id,
    status: "paid",
    amountDue: (inv.amount_due / 100).toFixed(4),
    amountPaid: (inv.amount_paid / 100).toFixed(4),
    currency: inv.currency,
    periodStart: new Date(inv.period_start * 1000),
    periodEnd: new Date(inv.period_end * 1000),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
    attemptCount: inv.attempt_count,
    nextPaymentAttempt: null,
    refundedAmount: "0",
  });

  const stored = await drizzle.billingInvoiceRepo.findInvoiceByStripeId(
    ctx.tx,
    inv.id,
  );
  if (!stored) throw new Error("invoice row missing after upsert");

  await publishBillingInvoicePaid(ctx.tx, {
    projectId: ctx.projectId,
    invoiceId: stored.id,
    stripeInvoiceId: inv.id,
    amountPaid: (inv.amount_paid / 100).toFixed(4),
  });

  // P5 will additionally clear billing_dunning_state and publish
  // billing.recovered. Phase 2 stops short of that — recovery
  // semantics require the dunning row, which P5 introduces writes
  // for.
}
