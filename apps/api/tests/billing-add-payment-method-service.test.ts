import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Unit test: startAddPaymentMethod
// =============================================================
// Mints a SetupIntent against the project's existing Stripe customer
// so the dashboard can add a second card. metadata.rovenue_flow =
// "add_pm" tells the setup_intent.succeeded webhook (T11) NOT to
// bootstrap a subscription — this is purely a card-attach flow.

const setupIntentsCreate = vi.fn();

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    setupIntents: { create: setupIntentsCreate },
  }),
}));

const findSub = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...(actual.drizzle as Record<string, unknown>),
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject: findSub,
      },
    },
  };
});

vi.mock("../src/lib/env", () => ({
  env: { STRIPE_BILLING_PUBLISHABLE_KEY: "pk_test_xxx" },
}));

describe("startAddPaymentMethod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a SetupIntent for an active project's existing Stripe customer", async () => {
    const { startAddPaymentMethod } = await import(
      "../src/services/billing/add-payment-method"
    );

    findSub.mockResolvedValueOnce({
      id: "bsub_active",
      projectId: "p1",
      state: "active",
      tier: "indie",
      cycle: "monthly",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setupIntentsCreate.mockResolvedValueOnce({ client_secret: "seti_cs_add" });

    const result = await startAddPaymentMethod({
      db: {} as never,
      projectId: "p1",
    });

    expect(setupIntentsCreate).toHaveBeenCalledTimes(1);
    expect(setupIntentsCreate).toHaveBeenCalledWith({
      customer: "cus_x",
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: {
        rovenue_project_id: "p1",
        rovenue_flow: "add_pm",
      },
    });

    expect(result).toEqual({
      clientSecret: "seti_cs_add",
      publishableKey: "pk_test_xxx",
    });
  });

  it("throws no_customer when the project has no Stripe customer yet", async () => {
    const { startAddPaymentMethod } = await import(
      "../src/services/billing/add-payment-method"
    );

    findSub.mockResolvedValueOnce({
      id: "bsub_free",
      projectId: "p1",
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

    await expect(
      startAddPaymentMethod({
        db: {} as never,
        projectId: "p1",
      }),
    ).rejects.toMatchObject({ code: "no_customer" });

    expect(setupIntentsCreate).not.toHaveBeenCalled();
  });
});
