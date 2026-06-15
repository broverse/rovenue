import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingInvoices,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertInvoiceFromStripe,
  listInvoicesForProject,
  findInvoiceByStripeId,
  incrementRefundedAmount,
} from "../../packages/db/src/drizzle/repositories/billing-invoices";

const PID = "proj_test_inv";

async function setup() {
  await db.delete(billingInvoices).where(eq(billingInvoices.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db
    .insert(user)
    .values({
      id: "usr_demo",
      name: "Demo User",
      email: "demo@rovenue.io",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(projects).values({
    id: PID,
    slug: "test-inv",
    name: "Test Inv",
    ownerId: "usr_demo",
  });
}

const STRIPE_FIXTURE = {
  stripeInvoiceId: "in_test_001",
  number: "INV-2026-0001",
  periodStart: new Date("2026-05-01T00:00:00Z"),
  periodEnd: new Date("2026-06-01T00:00:00Z"),
  amountDue: "9900",
  amountPaid: "9900",
  refundedAmount: "0",
  currency: "usd",
  status: "paid" as const,
  hostedInvoiceUrl: "https://stripe.test/invoice/in_test_001",
  pdfUrl: "https://stripe.test/invoice/in_test_001/pdf",
  attemptCount: 1,
  nextPaymentAttempt: null,
};

describe("billing-invoices repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsertInvoiceFromStripe inserts on first call", async () => {
    const row = await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
    });
    expect(row.status).toBe("paid");
    expect(row.amountPaid).toBe("9900.0000");
  });

  it("upsertInvoiceFromStripe updates on second call (same stripe_invoice_id)", async () => {
    await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
      status: "open",
      amountPaid: "0",
    });
    const row = await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
      status: "paid",
      amountPaid: "9900",
    });
    expect(row.status).toBe("paid");
    const all = await listInvoicesForProject(db, PID);
    expect(all).toHaveLength(1);
  });

  it("findInvoiceByStripeId returns the row", async () => {
    await upsertInvoiceFromStripe(db, { projectId: PID, ...STRIPE_FIXTURE });
    const found = await findInvoiceByStripeId(db, "in_test_001");
    expect(found?.number).toBe("INV-2026-0001");
  });

  it("incrementRefundedAmount adds to the existing refund", async () => {
    await upsertInvoiceFromStripe(db, { projectId: PID, ...STRIPE_FIXTURE });
    await incrementRefundedAmount(db, "in_test_001", "1000");
    await incrementRefundedAmount(db, "in_test_001", "500");
    const r = await findInvoiceByStripeId(db, "in_test_001");
    expect(r?.refundedAmount).toBe("1500.0000");
  });
});
