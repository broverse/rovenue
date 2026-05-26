import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Unit test: upgradeProject
// =============================================================
// Lazy-creates a Stripe customer (first-time only), then mints a
// SetupIntent whose metadata.rovenue_flow = "upgrade" — the signal
// the setup_intent.succeeded webhook (T11) uses to bootstrap the
// Stripe subscription.

const customersCreate = vi.fn();
const setupIntentsCreate = vi.fn();

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    customers: { create: customersCreate },
    setupIntents: { create: setupIntentsCreate },
  }),
}));

const findSub = vi.fn();
const setStripeCustomerId = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...(actual.drizzle as Record<string, unknown>),
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject: findSub,
        setStripeCustomerId,
      },
    },
  };
});

vi.mock("../src/lib/env", () => ({
  env: { STRIPE_BILLING_PUBLISHABLE_KEY: "pk_test_xxx" },
}));

describe("upgradeProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a Stripe customer + SetupIntent on first-time upgrade", async () => {
    const { upgradeProject } = await import(
      "../src/services/billing/upgrade-project"
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
    customersCreate.mockResolvedValueOnce({ id: "cus_new" });
    setupIntentsCreate.mockResolvedValueOnce({ client_secret: "seti_cs_xyz" });

    const db = {} as never;
    const result = await upgradeProject({
      db,
      projectId: "p1",
      cycle: "monthly",
    });

    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(customersCreate).toHaveBeenCalledWith({
      metadata: { rovenue_project_id: "p1" },
    });

    expect(setStripeCustomerId).toHaveBeenCalledTimes(1);
    expect(setStripeCustomerId).toHaveBeenCalledWith(db, "p1", "cus_new");

    expect(setupIntentsCreate).toHaveBeenCalledTimes(1);
    expect(setupIntentsCreate).toHaveBeenCalledWith({
      customer: "cus_new",
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: {
        rovenue_project_id: "p1",
        rovenue_flow: "upgrade",
        rovenue_target_tier: "indie",
        rovenue_target_cycle: "monthly",
      },
    });

    expect(result).toEqual({
      clientSecret: "seti_cs_xyz",
      publishableKey: "pk_test_xxx",
    });
  });

  it("reuses an existing Stripe customer on retry", async () => {
    const { upgradeProject } = await import(
      "../src/services/billing/upgrade-project"
    );

    findSub.mockResolvedValueOnce({
      id: "bsub_free",
      projectId: "p1",
      state: "free",
      tier: "free",
      cycle: "monthly",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setupIntentsCreate.mockResolvedValueOnce({ client_secret: "seti_cs_xyz" });

    const result = await upgradeProject({
      db: {} as never,
      projectId: "p1",
      cycle: "monthly",
    });

    expect(customersCreate).not.toHaveBeenCalled();
    expect(setStripeCustomerId).not.toHaveBeenCalled();
    expect(setupIntentsCreate).toHaveBeenCalledTimes(1);
    expect(setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
    expect(result).toEqual({
      clientSecret: "seti_cs_xyz",
      publishableKey: "pk_test_xxx",
    });
  });

  it("throws already_active when the project is already on a paid plan", async () => {
    const { upgradeProject } = await import(
      "../src/services/billing/upgrade-project"
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

    await expect(
      upgradeProject({
        db: {} as never,
        projectId: "p1",
        cycle: "monthly",
      }),
    ).rejects.toMatchObject({ code: "already_active" });

    expect(customersCreate).not.toHaveBeenCalled();
    expect(setupIntentsCreate).not.toHaveBeenCalled();
  });
});
