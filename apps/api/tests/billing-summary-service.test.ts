import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Unit test: buildBillingSummary
// =============================================================
// Pure assembly: read one row from billing_subscriptions and at most
// one row from billing_payment_methods, then shape them into a
// BillingSummary wire object. We mock @rovenue/db so no real Postgres
// is required.

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...(actual.drizzle as Record<string, unknown>),
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject: vi.fn(),
      },
      billingPaymentMethodRepo: {
        findDefaultPaymentMethod: vi.fn(),
      },
      projectRepo: {
        findProjectById: vi.fn().mockResolvedValue({
          id: "proj_1",
          usageLockedAt: null,
        }),
      },
    },
  };
});

describe("buildBillingSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the free-tier shape for a project with no Stripe customer", async () => {
    const { drizzle } = await import("@rovenue/db");
    const { buildBillingSummary } = await import(
      "../src/services/billing/billing-summary"
    );

    const findSub = drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject as ReturnType<typeof vi.fn>;
    const findPm = drizzle.billingPaymentMethodRepo
      .findDefaultPaymentMethod as ReturnType<typeof vi.fn>;

    findSub.mockResolvedValueOnce({
      id: "bsub_free",
      projectId: "proj_1",
      state: "free",
      tier: "free",
      cycle: "monthly",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findPm.mockResolvedValueOnce(null);

    const summary = await buildBillingSummary({} as never, "proj_1");

    expect(summary).toEqual({
      state: "free",
      tier: "free",
      cycle: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      hasStripeCustomer: false,
      usageLockedAt: null,
    });
  });

  it("maps an active subscription with a default payment method", async () => {
    const { drizzle } = await import("@rovenue/db");
    const { buildBillingSummary } = await import(
      "../src/services/billing/billing-summary"
    );

    const findSub = drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject as ReturnType<typeof vi.fn>;
    const findPm = drizzle.billingPaymentMethodRepo
      .findDefaultPaymentMethod as ReturnType<typeof vi.fn>;

    findSub.mockResolvedValueOnce({
      id: "bsub_active",
      projectId: "proj_2",
      state: "active",
      tier: "indie",
      cycle: "monthly",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findPm.mockResolvedValueOnce({
      id: "pm_row",
      projectId: "proj_2",
      stripePaymentMethodId: "pm_stripe_xxx",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });

    const summary = await buildBillingSummary({} as never, "proj_2");

    expect(summary.state).toBe("active");
    expect(summary.tier).toBe("indie");
    expect(summary.cycle).toBe("monthly");
    expect(summary.hasStripeCustomer).toBe(true);
    expect(summary.currentPeriodStart).toBe("2026-06-01T00:00:00.000Z");
    expect(summary.currentPeriodEnd).toBe("2026-07-01T00:00:00.000Z");
    expect(summary.defaultPaymentMethod).toEqual({
      id: "pm_row",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("throws when no billing_subscriptions row exists for the project", async () => {
    const { drizzle } = await import("@rovenue/db");
    const { buildBillingSummary } = await import(
      "../src/services/billing/billing-summary"
    );

    const findSub = drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject as ReturnType<typeof vi.fn>;
    const findPm = drizzle.billingPaymentMethodRepo
      .findDefaultPaymentMethod as ReturnType<typeof vi.fn>;

    findSub.mockResolvedValueOnce(null);
    findPm.mockResolvedValueOnce(null);

    await expect(
      buildBillingSummary({} as never, "proj_missing"),
    ).rejects.toThrow();
  });
});
