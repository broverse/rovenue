import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// invoice.created / invoice.finalized / invoice.updated handler
// =============================================================
//
// Single handler registered by the dispatcher (Task 17) under all
// three Stripe event types. Runs inside the dispatcher's
// db.transaction(async tx => ...) — MUST NOT open its own
// transaction.
//
// The repository's `upsertInvoiceFromStripe` uses
// `onConflictDoUpdate` on `stripeInvoiceId`, so re-fires
// (e.g. `invoice.finalized` after `invoice.created`) overwrite
// status / amounts / urls / attempt counters but leave the row's
// id, createdAt, and refundedAmount intact. Refund deltas flow
// through `incrementRefundedAmount` from the `charge.refunded`
// handler — never from this path.

export interface InvoiceUpsertContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

// Stripe's `Invoice.Status` is a union including null; we map it
// onto our `billing_invoices.status` enum, defaulting unexpected
// / null values to "draft" so the insert never fails on an
// unknown status string.
function statusFromStripe(
  s: Stripe.Invoice.Status | null,
): "draft" | "open" | "paid" | "uncollectible" | "void" {
  switch (s) {
    case "draft":
    case "open":
    case "paid":
    case "uncollectible":
    case "void":
      return s;
    default:
      return "draft";
  }
}

export async function handleInvoiceUpsert(
  ctx: InvoiceUpsertContext,
): Promise<void> {
  const inv = ctx.event.data.object as Stripe.Invoice;

  // Stripe sends amounts in the smallest currency unit (cents for
  // USD). Our `billing_invoices.amount_*` columns are
  // `numeric(12,4)` — convert cents → major units with 4 decimal
  // places.
  await drizzle.billingInvoiceRepo.upsertInvoiceFromStripe(ctx.tx, {
    projectId: ctx.projectId,
    stripeInvoiceId: inv.id,
    number: inv.number ?? inv.id,
    status: statusFromStripe(inv.status),
    amountDue: (inv.amount_due / 100).toFixed(4),
    amountPaid: (inv.amount_paid / 100).toFixed(4),
    currency: inv.currency,
    periodStart: new Date(inv.period_start * 1000),
    periodEnd: new Date(inv.period_end * 1000),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
    attemptCount: inv.attempt_count,
    nextPaymentAttempt: inv.next_payment_attempt
      ? new Date(inv.next_payment_attempt * 1000)
      : null,
    refundedAmount: "0",
  });
}
