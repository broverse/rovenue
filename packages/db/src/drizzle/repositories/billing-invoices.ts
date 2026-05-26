import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingInvoices,
  type BillingInvoice,
  type NewBillingInvoice,
} from "../schema";

export async function upsertInvoiceFromStripe(
  db: Db,
  row: Omit<NewBillingInvoice, "id" | "createdAt">,
): Promise<BillingInvoice> {
  const rows = await db
    .insert(billingInvoices)
    .values(row)
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        status: row.status,
        amountDue: row.amountDue,
        amountPaid: row.amountPaid,
        hostedInvoiceUrl: row.hostedInvoiceUrl ?? null,
        pdfUrl: row.pdfUrl ?? null,
        attemptCount: row.attemptCount,
        nextPaymentAttempt: row.nextPaymentAttempt ?? null,
      },
    })
    .returning();
  return rows[0]!;
}

export async function listInvoicesForProject(
  db: Db,
  projectId: string,
): Promise<BillingInvoice[]> {
  return db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.projectId, projectId))
    .orderBy(desc(billingInvoices.createdAt));
}

export async function findInvoiceByStripeId(
  db: Db,
  stripeInvoiceId: string,
): Promise<BillingInvoice | null> {
  const rows = await db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.stripeInvoiceId, stripeInvoiceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function incrementRefundedAmount(
  db: Db,
  stripeInvoiceId: string,
  delta: string,
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({
      refundedAmount: sql`${billingInvoices.refundedAmount} + ${delta}::numeric`,
    })
    .where(eq(billingInvoices.stripeInvoiceId, stripeInvoiceId));
}
