import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// =============================================================
// Route test: /dashboard/projects/:projectId/billing/payment-methods
// =============================================================
// Mirrors the T20 upgrade-route test pattern: mount the billing
// sub-router on a fresh Hono with a fake-user middleware, mock the
// repo + service + Stripe + flag + project-access guard, and assert
// the HTTP surface (status codes + payload shape + Stripe-call
// side-effects). The DB and Stripe SDK are fully stubbed.

const {
  listPaymentMethodsForProject,
  findPaymentMethodById,
  setDefaultPaymentMethod,
  findBillingSubscriptionByProject,
  startAddPaymentMethod,
  isBillingEnabled,
  assertProjectAccess,
  getPlatformStripe,
  stripeDetach,
  stripeCustomersUpdate,
} = vi.hoisted(() => {
  const stripeDetach = vi.fn(async () => ({}));
  const stripeCustomersUpdate = vi.fn(async () => ({}));
  return {
    listPaymentMethodsForProject: vi.fn(),
    findPaymentMethodById: vi.fn(),
    setDefaultPaymentMethod: vi.fn(),
    findBillingSubscriptionByProject: vi.fn(),
    startAddPaymentMethod: vi.fn(),
    isBillingEnabled: vi.fn(() => true),
    assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
    getPlatformStripe: vi.fn(() => ({
      paymentMethods: { detach: stripeDetach },
      customers: { update: stripeCustomersUpdate },
    })),
    stripeDetach,
    stripeCustomersUpdate,
  };
});

vi.mock("../src/services/billing/add-payment-method", () => ({
  startAddPaymentMethod,
}));
vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled }));
vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));
vi.mock("../src/lib/stripe-billing", () => ({ getPlatformStripe }));
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    db: {},
    drizzle: {
      billingPaymentMethodRepo: {
        listPaymentMethodsForProject,
        findPaymentMethodById,
        setDefaultPaymentMethod,
      },
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject,
      },
    },
  };
});

import { billingSubRouter } from "../src/routes/dashboard/billing";

function mountAppWithUser() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "u1" } as never);
      c.set("session", { id: "s1" } as never);
      await next();
    })
    .route("/projects/:projectId/billing", billingSubRouter);
}

beforeEach(() => {
  vi.clearAllMocks();
  isBillingEnabled.mockReturnValue(true);
  assertProjectAccess.mockResolvedValue({ id: "m1", role: "OWNER" });
  getPlatformStripe.mockReturnValue({
    paymentMethods: { detach: stripeDetach },
    customers: { update: stripeCustomersUpdate },
  });
});

describe("/dashboard/projects/:projectId/billing/payment-methods", () => {
  it("GET / returns the list of payment methods", async () => {
    listPaymentMethodsForProject.mockResolvedValue([
      {
        id: "pm1",
        projectId: "p1",
        stripePaymentMethodId: "pm_stripe_1",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/payment-methods",
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "pm1",
      brand: "visa",
      last4: "4242",
      isDefault: true,
    });
  });

  it("POST / returns clientSecret for the add-card flow", async () => {
    startAddPaymentMethod.mockResolvedValue({
      clientSecret: "seti_cs_add",
      publishableKey: "pk_test_xxx",
    });
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/payment-methods",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.clientSecret).toBe("seti_cs_add");
    expect(startAddPaymentMethod).toHaveBeenCalledWith({
      db: {},
      projectId: "p1",
    });
  });

  it("POST /:pmId/default swaps the default and updates Stripe customer", async () => {
    findPaymentMethodById.mockResolvedValue({
      id: "pm1",
      projectId: "p1",
      stripePaymentMethodId: "pm_stripe_1",
    });
    findBillingSubscriptionByProject.mockResolvedValue({
      stripeCustomerId: "cus_xyz",
      state: "active",
    });
    setDefaultPaymentMethod.mockResolvedValue(undefined);
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/payment-methods/pm1/default",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(setDefaultPaymentMethod).toHaveBeenCalledWith({}, "p1", "pm1");
    expect(stripeCustomersUpdate).toHaveBeenCalledWith("cus_xyz", {
      invoice_settings: { default_payment_method: "pm_stripe_1" },
    });
  });

  it("DELETE /:pmId refuses last card on active project (409, no Stripe call)", async () => {
    findPaymentMethodById.mockResolvedValue({
      id: "pm1",
      projectId: "p1",
      stripePaymentMethodId: "pm_stripe_1",
    });
    listPaymentMethodsForProject.mockResolvedValue([
      { id: "pm1", projectId: "p1", stripePaymentMethodId: "pm_stripe_1" },
    ]);
    findBillingSubscriptionByProject.mockResolvedValue({
      stripeCustomerId: "cus_xyz",
      state: "active",
    });
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/payment-methods/pm1",
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
    expect(stripeDetach).not.toHaveBeenCalled();
  });

  it("DELETE /:pmId detaches via Stripe when not the last card (route does NOT delete DB row)", async () => {
    findPaymentMethodById.mockResolvedValue({
      id: "pm1",
      projectId: "p1",
      stripePaymentMethodId: "pm_stripe_1",
    });
    listPaymentMethodsForProject.mockResolvedValue([
      { id: "pm1", projectId: "p1", stripePaymentMethodId: "pm_stripe_1" },
      { id: "pm2", projectId: "p1", stripePaymentMethodId: "pm_stripe_2" },
    ]);
    findBillingSubscriptionByProject.mockResolvedValue({
      stripeCustomerId: "cus_xyz",
      state: "active",
    });
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/payment-methods/pm1",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.detaching).toBe(true);
    expect(stripeDetach).toHaveBeenCalledWith("pm_stripe_1");
  });
});
