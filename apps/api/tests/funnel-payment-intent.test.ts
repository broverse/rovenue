import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /public/funnel-sessions/:sessionId/payment-intent
// =============================================================
//
// The one rule under test: the browser never says what to charge. It
// names a package; the server resolves that package through the
// funnel's published paywall to a Stripe Price on the connected
// account and derives the amount from there. The "ignores an amount
// supplied by the client" case is the contract test for the whole
// task — everything else here exists to make that test meaningful
// (a route that always 400s or always uses a hardcoded price would
// pass it vacuously).
//
// Same app-build harness as stripe-connect-routes.test.ts:
// vi.resetModules() + process.env + a dynamic import("../src/app").

const findSessionById = vi.hoisted(() => vi.fn());
const findVersionById = vi.hoisted(() => vi.fn());
const findPaywallById = vi.hoisted(() => vi.fn());
const findOfferingById = vi.hoisted(() => vi.fn());
const findProductsByIds = vi.hoisted(() => vi.fn());
const upsertPurchase = vi.hoisted(() => vi.fn());
const findPurchaseBySession = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      funnelSessionRepo: { findById: findSessionById },
      funnelVersionRepo: { findById: findVersionById },
      paywallRepo: { findPaywallById },
      offeringRepo: { findOfferingById, findProductsByIds },
      funnelPurchaseRepo: {
        upsertPending: upsertPurchase,
        findBySession: findPurchaseBySession,
      },
    },
  };
});

// The route resolves prices through Task 2's resolver — mocked here as a
// bare vi.fn() so these tests pin only what the route passes to it and
// what it does with the result, not price-resolver's own Stripe/Redis
// logic (covered elsewhere).
const resolvePricesForPackages = vi.hoisted(() => vi.fn());
vi.mock("../src/services/stripe/price-resolver", () => ({
  resolvePricesForPackages,
}));

// subscriptionsCreate/paymentIntentsCreate are direct vi.fn()s (not part
// of a vi.mock(..., importOriginal) factory) precisely because they must
// behave differently per test (trial vs no-trial) and vi.resetModules()
// does not re-run a cached mock factory.
const chargesEnabled = vi.hoisted(() => vi.fn());
const customersCreate = vi.hoisted(() => vi.fn());
const subscriptionsCreate = vi.hoisted(() =>
  vi.fn(async (params: { trial_period_days?: number }) => {
    if (params.trial_period_days) {
      return {
        id: "sub_trial_1",
        pending_setup_intent: { client_secret: "seti_secret" },
        latest_invoice: null,
      };
    }
    return {
      id: "sub_1",
      pending_setup_intent: null,
      latest_invoice: {
        payment_intent: { id: "pi_1", client_secret: "pi_secret" },
      },
    };
  }),
);
const paymentIntentsCreate = vi.hoisted(() =>
  vi.fn(async () => ({ id: "pi_2", client_secret: "pi_secret_2" })),
);
const subscriptionsCancel = vi.hoisted(() => vi.fn(async () => ({ id: "sub_old" })));
const paymentIntentsCancel = vi.hoisted(() => vi.fn(async () => ({ id: "pi_old" })));
const requireConnectedStripe = vi.hoisted(() =>
  vi.fn(async () => ({
    account: {
      customers: { create: customersCreate },
      subscriptions: { create: subscriptionsCreate, cancel: subscriptionsCancel },
      paymentIntents: { create: paymentIntentsCreate, cancel: paymentIntentsCancel },
    },
    accountId: "acct_1",
    livemode: false,
  })),
);

vi.mock("../src/lib/stripe-platform", () => ({
  chargesEnabled,
  requireConnectedStripe,
}));

// Redis is not running in this test environment. Nothing on this route's
// success path depends on real redis behaviour (price-resolver's own
// cache is mocked away above), so the only thing that would touch it is
// the endpoint rate limiter — and that fails open (falls back to the
// in-process insurance limiter) when a redis call throws, so an empty
// stub is enough; see middleware/rate-limit.ts.
vi.mock("../src/lib/redis", () => ({ redis: {} }));

describe("POST /public/funnel-sessions/:sessionId/payment-intent", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
    process.env.STRIPE_PLATFORM_PUBLISHABLE_KEY = "pk_test_123";

    findSessionById.mockReset().mockResolvedValue({
      id: "sess_1",
      projectId: "proj_1",
      funnelId: "funnel_1",
      funnelVersionId: "version_1",
      state: "in_progress",
    });
    findVersionById.mockReset().mockResolvedValue({
      id: "version_1",
      pagesJson: [
        { id: "page_1", type: "info" },
        { id: "page_paywall", type: "paywall", paywallId: "pw_1" },
      ],
    });
    findPaywallById.mockReset().mockResolvedValue({
      id: "pw_1",
      projectId: "proj_1",
      offeringId: "off_1",
    });
    findOfferingById.mockReset().mockResolvedValue({
      identifier: "default",
      isDefault: true,
      packages: [
        { identifier: "$rov_monthly", productId: "prod_monthly", order: 0, isPromoted: false },
        { identifier: "$rov_trial", productId: "prod_trial", order: 1, isPromoted: false },
        { identifier: "$rov_lifetime", productId: "prod_lifetime", order: 2, isPromoted: false },
      ],
      metadata: {},
    });
    findProductsByIds.mockReset().mockImplementation(async (_db: unknown, _projectId: string, ids: string[]) => {
      const byId: Record<string, { id: string; storeIds: Record<string, string> }> = {
        prod_monthly: { id: "prod_monthly", storeIds: { stripe: "price_m" } },
        prod_trial: { id: "prod_trial", storeIds: { stripe: "price_t" } },
        prod_lifetime: { id: "prod_lifetime", storeIds: { stripe: "price_l" } },
      };
      return ids.map((id) => byId[id]).filter((p): p is NonNullable<typeof p> => Boolean(p));
    });
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_1" });
    // No prior attempt on this session unless a test says otherwise.
    findPurchaseBySession.mockReset().mockResolvedValue(null);

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_1" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
    subscriptionsCancel.mockClear();
    paymentIntentsCancel.mockClear();
    requireConnectedStripe.mockClear();

    resolvePricesForPackages.mockReset().mockImplementation(
      async (
        _projectId: string,
        packages: Array<{ packageIdentifier: string }>,
      ) => {
        const prices: Record<string, unknown> = {
          $rov_monthly: {
            packageIdentifier: "$rov_monthly",
            priceId: "price_m",
            unitAmount: 4999,
            currency: "usd",
            interval: "month",
            intervalCount: 1,
            trialDays: null,
          },
          $rov_trial: {
            packageIdentifier: "$rov_trial",
            priceId: "price_t",
            unitAmount: 4999,
            currency: "usd",
            interval: "month",
            intervalCount: 1,
            trialDays: 7,
          },
          $rov_lifetime: {
            packageIdentifier: "$rov_lifetime",
            priceId: "price_l",
            unitAmount: 9900,
            currency: "try",
            interval: null,
            intervalCount: null,
            trialDays: null,
          },
        };
        const out: Record<string, unknown> = {};
        for (const p of packages) {
          if (prices[p.packageIdentifier]) out[p.packageIdentifier] = prices[p.packageIdentifier];
        }
        return out;
      },
    );
  });

  async function post(body: Record<string, unknown>) {
    const { createApp } = await import("../src/app");
    const app = createApp();
    return app.request("/public/funnel-sessions/sess_1/payment-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("409s when the project cannot take charges", async () => {
    chargesEnabled.mockResolvedValue(false);
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("STRIPE_NOT_CONNECTED");
  });

  it("400s for a package that is not in the paywall's offering", async () => {
    const res = await post({ package_identifier: "$rov_smuggled", email: "a@b.co" });
    expect(res.status).toBe(400);
    // Distinct from the "no usable price" 400 — a smuggled identifier and
    // a mis-configured product must be tellable apart in the logs.
    expect(JSON.stringify(await res.json())).toContain(
      "Package is not in this funnel's offering",
    );
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("creates a subscription for a recurring price and returns its client secret", async () => {
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        items: [{ price: "price_m" }],
        payment_behavior: "default_incomplete",
      }),
    );
    const body = (await res.json()) as { data: { mode: string; client_secret: string } };
    expect(body.data.mode).toBe("payment");
    expect(body.data.client_secret).toBe("pi_secret");
  });

  it("uses setup mode when the price carries a trial", async () => {
    // trialDays: 7 -> no payment is captured now
    const body = (await post({ package_identifier: "$rov_trial", email: "a@b.co" }).then((r) =>
      r.json(),
    )) as { data: { mode: string } };
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ trial_period_days: 7 }),
    );
    expect(body.data.mode).toBe("setup");
  });

  it("creates a payment intent for a one-time price", async () => {
    await post({ package_identifier: "$rov_lifetime", email: "a@b.co" });
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9900, currency: "try", customer: "cus_1" }),
    );
  });

  // THE contract test for this task.
  it("ignores an amount supplied by the client", async () => {
    await post({
      package_identifier: "$rov_lifetime",
      email: "a@b.co",
      amount: 1,
      unitAmount: 1,
      currency: "xxx",
    } as Record<string, unknown>);
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9900, currency: "try" }),
    );
    // The other half of the same rule: the price the amount came from is
    // the one the route derived from the paywall's offering (prod_lifetime
    // -> storeIds.stripe = "price_l"), not anything the client could name.
    expect(resolvePricesForPackages).toHaveBeenCalledWith("proj_1", [
      { packageIdentifier: "$rov_lifetime", stripePriceId: "price_l" },
    ]);
  });

  it("writes the presented context and session id into Stripe metadata", async () => {
    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    const params = subscriptionsCreate.mock.calls[0][0];
    expect(params.metadata.rovenue_funnel_session_id).toBe("sess_1");
    expect(JSON.parse(params.metadata.rovenue_presented_context).paywallId).toBe("pw_1");
  });

  it("records a pending purchase row", async () => {
    // `status` is not asserted: upsertPending's parameter type excludes it
    // and the repository forces "pending", so there is nothing here to pin.
    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountCents: 4999,
        currency: "usd",
        productId: "prod_monthly",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        stripePaymentIntentId: "pi_1",
      }),
    );
  });

  it("409s when the session is already paid", async () => {
    findSessionById.mockResolvedValue({ id: "sess_1", state: "paid" });
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(res.status).toBe(409);
  });

  it("400s on a malformed email", async () => {
    const res = await post({ package_identifier: "$rov_monthly", email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("400s on a missing email", async () => {
    const res = await post({ package_identifier: "$rov_monthly" });
    expect(res.status).toBe(400);
    expect(customersCreate).not.toHaveBeenCalled();
  });

  // "a@b" passes any local@domain shape check but is not a deliverable
  // address. This is the case that actually pins z.string().email() —
  // "not-an-email" above has no "@" and so fails a loose regex too.
  it("400s on an address with no domain suffix", async () => {
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b" });
    expect(res.status).toBe(400);
    expect(customersCreate).not.toHaveBeenCalled();
  });
});

// =============================================================
// Changing package mid-funnel
// =============================================================
//
// upsertPending overwrites the single row for the session, so a second
// POST must not leave the first attempt's Stripe objects behind: a
// still-confirmable client secret would produce a real charge against a
// row that by then records a different product and a different amount.

describe("POST payment-intent — a second attempt on the same session", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
    process.env.STRIPE_PLATFORM_PUBLISHABLE_KEY = "pk_test_123";

    findSessionById.mockReset().mockResolvedValue({
      id: "sess_1",
      projectId: "proj_1",
      funnelId: "funnel_1",
      funnelVersionId: "version_1",
      state: "in_progress",
    });
    findVersionById.mockReset().mockResolvedValue({
      id: "version_1",
      pagesJson: [{ id: "page_paywall", type: "paywall", paywallId: "pw_1" }],
    });
    findPaywallById.mockReset().mockResolvedValue({
      id: "pw_1",
      projectId: "proj_1",
      offeringId: "off_1",
    });
    findOfferingById.mockReset().mockResolvedValue({
      identifier: "default",
      isDefault: true,
      packages: [
        { identifier: "$rov_monthly", productId: "prod_monthly", order: 0, isPromoted: false },
        { identifier: "$rov_lifetime", productId: "prod_lifetime", order: 1, isPromoted: false },
      ],
      metadata: {},
    });
    findProductsByIds.mockReset().mockImplementation(
      async (_db: unknown, _projectId: string, ids: string[]) => {
        const byId: Record<string, { id: string; storeIds: Record<string, string> }> = {
          prod_monthly: { id: "prod_monthly", storeIds: { stripe: "price_m" } },
          prod_lifetime: { id: "prod_lifetime", storeIds: { stripe: "price_l" } },
        };
        return ids.map((id) => byId[id]).filter((p): p is NonNullable<typeof p> => Boolean(p));
      },
    );
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_1" });
    findPurchaseBySession.mockReset().mockResolvedValue(null);

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_new" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
    subscriptionsCancel.mockClear();
    paymentIntentsCancel.mockClear();
    requireConnectedStripe.mockClear();

    resolvePricesForPackages.mockReset().mockImplementation(
      async (_projectId: string, packages: Array<{ packageIdentifier: string }>) => {
        const prices: Record<string, unknown> = {
          $rov_monthly: {
            packageIdentifier: "$rov_monthly",
            priceId: "price_m",
            unitAmount: 4999,
            currency: "usd",
            interval: "month",
            intervalCount: 1,
            trialDays: null,
          },
          $rov_lifetime: {
            packageIdentifier: "$rov_lifetime",
            priceId: "price_l",
            unitAmount: 9900,
            currency: "try",
            interval: null,
            intervalCount: null,
            trialDays: null,
          },
        };
        const out: Record<string, unknown> = {};
        for (const p of packages) {
          if (prices[p.packageIdentifier]) out[p.packageIdentifier] = prices[p.packageIdentifier];
        }
        return out;
      },
    );
  });

  async function post(body: Record<string, unknown>) {
    const { createApp } = await import("../src/app");
    const app = createApp();
    return app.request("/public/funnel-sessions/sess_1/payment-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("reuses the pending row's customer and cancels the superseded subscription", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: null,
    });

    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(res.status).toBe(200);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_old");
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stripeCustomerId: "cus_existing" }),
    );
  });

  it("cancels a superseded payment intent when the visitor switches to a subscription", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_old",
    });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(paymentIntentsCancel).toHaveBeenCalledWith("pi_old");
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("does not cancel the payment intent the new attempt just created", async () => {
    // The one-time path returns pi_2; the previous row already held it,
    // so there is nothing superseded to clean up.
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_2",
    });

    await post({ package_identifier: "$rov_lifetime", email: "a@b.co" });

    expect(paymentIntentsCancel).not.toHaveBeenCalled();
  });

  it("leaves a non-pending row alone and creates a fresh customer", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      status: "paid",
      stripeCustomerId: "cus_paid",
      stripeSubscriptionId: "sub_paid",
      stripePaymentIntentId: null,
    });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
    );
  });

  it("still returns the new client secret when the cleanup cancel fails", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: null,
    });
    subscriptionsCancel.mockRejectedValueOnce(new Error("No such subscription"));

    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { client_secret: string } };
    expect(body.data.client_secret).toBe("pi_secret");
    expect(upsertPurchase).toHaveBeenCalled();
  });
});
