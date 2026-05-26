import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// billing-events — BILLING aggregate outbox publishers
// =============================================================
//
// Three thin wrappers around drizzle.outboxRepo.insert that emit
// BILLING aggregate events for the Stripe webhook handlers (Phase 2).
//
// Callers pass a tx-bound Db so the outbox insert lands in the same
// transaction as the caller's OLTP write (billing_subscriptions /
// billing_payment_methods / billing_invoices). The dispatcher
// (Task 17) runs each handler inside db.transaction(...) and passes
// the tx-bound Db in — publishers must never open their own
// transaction. Same pattern as event-bus.publishExposure.
//
// payload columns are JSON (jsonb); Dates serialise as ISO strings.

export interface BillingActivatedInput {
  projectId: string;
  tier: string;
  cycle: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export async function publishBillingActivated(
  tx: Db,
  input: BillingActivatedInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.subscription.activated",
    payload: {
      projectId: input.projectId,
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart.toISOString(),
      currentPeriodEnd: input.currentPeriodEnd.toISOString(),
    },
  });
}

export interface BillingPaymentMethodAddedInput {
  projectId: string;
  paymentMethodId: string; // billing_payment_methods.id (cuid2), NOT Stripe pm_*
  brand: string;
  last4: string;
}

export async function publishBillingPaymentMethodAdded(
  tx: Db,
  input: BillingPaymentMethodAddedInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.payment_method.added",
    payload: input,
  });
}

export interface BillingInvoicePaidInput {
  projectId: string;
  invoiceId: string; // billing_invoices.id (cuid2)
  stripeInvoiceId: string;
  amountPaid: string; // numeric(12,4) as decimal string — preserves precision over JSON
}

export async function publishBillingInvoicePaid(
  tx: Db,
  input: BillingInvoicePaidInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.invoice.paid",
    payload: input,
  });
}
