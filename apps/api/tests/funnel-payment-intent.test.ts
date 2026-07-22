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
      funnelPurchaseRepo: { upsertPending: upsertPurchase },
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
const requireConnectedStripe = vi.hoisted(() =>
  vi.fn(async () => ({
    account: {
      customers: { create: customersCreate },
      subscriptions: { create: subscriptionsCreate },
      paymentIntents: { create: paymentIntentsCreate },
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

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_1" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
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
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("STRIPE_NOT_CONNECTED");
  });

  it("400s for a package that is not in the paywall's offering", async () => {
    const res = await post({ package_identifier: "$rov_smuggled", email: "a@b.c" });
    expect(res.status).toBe(400);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("creates a subscription for a recurring price and returns its client secret", async () => {
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
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
    const body = (await post({ package_identifier: "$rov_trial", email: "a@b.c" }).then((r) =>
      r.json(),
    )) as { data: { mode: string } };
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ trial_period_days: 7 }),
    );
    expect(body.data.mode).toBe("setup");
  });

  it("creates a payment intent for a one-time price", async () => {
    await post({ package_identifier: "$rov_lifetime", email: "a@b.c" });
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9900, currency: "try", customer: "cus_1" }),
    );
  });

  // THE contract test for this task.
  it("ignores an amount supplied by the client", async () => {
    await post({
      package_identifier: "$rov_lifetime",
      email: "a@b.c",
      amount: 1,
      unitAmount: 1,
      currency: "xxx",
    } as Record<string, unknown>);
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9900, currency: "try" }),
    );
  });

  it("writes the presented context and session id into Stripe metadata", async () => {
    await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
    const params = subscriptionsCreate.mock.calls[0][0];
    expect(params.metadata.rovenue_funnel_session_id).toBe("sess_1");
    expect(JSON.parse(params.metadata.rovenue_presented_context).paywallId).toBe("pw_1");
  });

  it("records a pending purchase row", async () => {
    await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "pending", amountCents: 4999, currency: "usd" }),
    );
  });

  it("409s when the session is already paid", async () => {
    findSessionById.mockResolvedValue({ id: "sess_1", state: "paid" });
    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
    expect(res.status).toBe(409);
  });

  it("400s on a missing or malformed email", async () => {
    const res = await post({ package_identifier: "$rov_monthly", email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
