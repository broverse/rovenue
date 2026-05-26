import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Unit test: billing outbox publishers
// =============================================================
// Three thin wrappers around drizzle.outboxRepo.insert that emit
// BILLING aggregate events. We mock @rovenue/db so no real Postgres
// is required — only the call shape matters here.

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...(actual.drizzle as Record<string, unknown>),
      outboxRepo: {
        insert: vi.fn(),
      },
    },
  };
});

describe("billing outbox publishers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishBillingActivated inserts a billing.subscription.activated outbox row", async () => {
    const { drizzle } = await import("@rovenue/db");
    const { publishBillingActivated } = await import(
      "../src/services/billing/billing-events"
    );

    const insert = drizzle.outboxRepo.insert as ReturnType<typeof vi.fn>;
    insert.mockResolvedValueOnce(undefined);

    const tx = {} as never;
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-07-01T00:00:00Z");

    await publishBillingActivated(tx, {
      projectId: "p1",
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: start,
      currentPeriodEnd: end,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(tx, {
      aggregateType: "BILLING",
      aggregateId: "p1",
      eventType: "billing.subscription.activated",
      payload: {
        projectId: "p1",
        tier: "indie",
        cycle: "monthly",
        currentPeriodStart: "2026-06-01T00:00:00.000Z",
        currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      },
    });
  });

  it("publishBillingInvoicePaid inserts a billing.invoice.paid outbox row", async () => {
    const { drizzle } = await import("@rovenue/db");
    const { publishBillingInvoicePaid } = await import(
      "../src/services/billing/billing-events"
    );

    const insert = drizzle.outboxRepo.insert as ReturnType<typeof vi.fn>;
    insert.mockResolvedValueOnce(undefined);

    const tx = {} as never;
    await publishBillingInvoicePaid(tx, {
      projectId: "p2",
      invoiceId: "bi_local_1",
      stripeInvoiceId: "in_stripe_1",
      amountPaid: "29.0000",
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(tx, {
      aggregateType: "BILLING",
      aggregateId: "p2",
      eventType: "billing.invoice.paid",
      payload: {
        projectId: "p2",
        invoiceId: "bi_local_1",
        stripeInvoiceId: "in_stripe_1",
        amountPaid: "29.0000",
      },
    });
  });
});
