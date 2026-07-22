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
const customersUpdate = vi.hoisted(() => vi.fn(async () => ({ id: "cus_existing" })));
const subscriptionsCancel = vi.hoisted(() => vi.fn(async () => ({ id: "sub_old" })));
const paymentIntentsCancel = vi.hoisted(() => vi.fn(async () => ({ id: "pi_old" })));
// Nothing is cancelled unmeasured any more: the route retrieves first and
// cancels only what is still unpaid. Default both to the status a
// never-confirmed object has, so the existing cleanup cases still cancel.
const subscriptionsRetrieve = vi.hoisted(() =>
  vi.fn(async () => ({ id: "sub_old", status: "incomplete" })),
);
const paymentIntentsRetrieve = vi.hoisted(() =>
  vi.fn(async () => ({ id: "pi_old", status: "requires_payment_method" })),
);
const requireConnectedStripe = vi.hoisted(() =>
  vi.fn(async () => ({
    account: {
      customers: { create: customersCreate, update: customersUpdate },
      subscriptions: {
        create: subscriptionsCreate,
        cancel: subscriptionsCancel,
        retrieve: subscriptionsRetrieve,
      },
      paymentIntents: {
        create: paymentIntentsCreate,
        cancel: paymentIntentsCancel,
        retrieve: paymentIntentsRetrieve,
      },
    },
    accountId: "acct_1",
    livemode: false,
  })),
);

vi.mock("../src/lib/stripe-platform", () => ({
  chargesEnabled,
  requireConnectedStripe,
}));

// Redis is not running in this test environment, but the route's
// per-session lock is real logic worth exercising, so `set`/`eval` are
// backed by an in-memory map with the semantics withLock relies on:
// SET NX refuses an existing key, and the release script deletes only on
// a token match. Everything else on the client stays undefined — notably
// `multi()`, which is what the endpoint rate limiter uses, and it fails
// open (falls back to the in-process insurance limiter) when a redis
// call throws; see middleware/rate-limit.ts.
const lockStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    set: async (key: string, value: string, _px: string, _ttl: number, mode?: string) => {
      if (mode === "NX" && lockStore.has(key)) return null;
      lockStore.set(key, value);
      return "OK";
    },
    eval: async (_script: string, _numKeys: number, key: string, token: string) => {
      if (lockStore.get(key) !== token) return 0;
      lockStore.delete(key);
      return 1;
    },
  },
}));

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
    subscriptionsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "sub_old", status: "incomplete" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_old", status: "requires_payment_method" });
    customersUpdate.mockReset().mockResolvedValue({ id: "cus_existing" });
    requireConnectedStripe.mockClear();
    lockStore.clear();

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

  // These are the fixtures that actually pin z.string().email(). The
  // obvious-looking "a@b" does not: the loose regex it replaced was
  // /[^\s@]+@[^\s@]+\.[^\s@]+/, which already required a dot in the
  // domain and so rejected "a@b" too — that case passes identically with
  // or without the tightening. Both below are *accepted* by that regex
  // and rejected by .email() (single-character TLD; a domain label that
  // is just a hyphen), so reverting to it turns them red.
  it.each(["a@b.c", "a@-.-"])("400s on the loose-regex-passing %s", async (email) => {
    const res = await post({ package_identifier: "$rov_monthly", email });
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
    subscriptionsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "sub_old", status: "incomplete" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_old", status: "requires_payment_method" });
    customersUpdate.mockReset().mockResolvedValue({ id: "cus_existing" });
    requireConnectedStripe.mockClear();
    lockStore.clear();

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
      projectId: "proj_1",
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
      projectId: "proj_1",
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
      projectId: "proj_1",
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
      projectId: "proj_1",
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
      projectId: "proj_1",
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
    // Best-effort for the request, but the loss has to be recoverable:
    // upsertPending is about to overwrite the ids, so a still-confirmable
    // object would otherwise be referenced by no row anywhere.
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawPayload: expect.objectContaining({
          orphaned_stripe_objects: ["sub_old"],
        }),
      }),
    );
  });

  it("keeps orphan ids a previous attempt already recorded", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: null,
      rawPayload: { orphaned_stripe_objects: ["pi_ancient"], other_key: 1 },
    });
    subscriptionsCancel.mockRejectedValueOnce(new Error("No such subscription"));

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawPayload: {
          other_key: 1,
          orphaned_stripe_objects: ["pi_ancient", "sub_old"],
        },
      }),
    );
  });

  it("does not write rawPayload when the cleanup succeeded", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: null,
    });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(upsertPurchase.mock.calls[0][1]).not.toHaveProperty("rawPayload");
  });
});

// =============================================================
// Cancelling only what is still unpaid
// =============================================================
//
// The row's own status is not evidence: Task 7's webhook is what flips it
// to "paid", and between the browser confirming and that webhook landing
// the object is live on Stripe while the row still reads "pending". A
// second POST in that window used to cancel a subscription the visitor
// had already paid for — Stripe accepts that call and does not refund,
// and this endpoint is anonymous.

describe("POST payment-intent — cancelling a superseded object", () => {
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
      ],
      metadata: {},
    });
    findProductsByIds
      .mockReset()
      .mockResolvedValue([{ id: "prod_monthly", storeIds: { stripe: "price_m" } }]);
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_1" });
    findPurchaseBySession.mockReset().mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: null,
    });

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_new" });
    customersUpdate.mockReset().mockResolvedValue({ id: "cus_existing" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
    subscriptionsCancel.mockClear();
    paymentIntentsCancel.mockClear();
    subscriptionsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "sub_old", status: "incomplete" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_old", status: "requires_payment_method" });
    requireConnectedStripe.mockClear();
    lockStore.clear();

    resolvePricesForPackages.mockReset().mockResolvedValue({
      $rov_monthly: {
        packageIdentifier: "$rov_monthly",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      },
    });
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

  it("cancels a superseded subscription that is still incomplete", async () => {
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_old", status: "incomplete" });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_old");
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_old");
  });

  // THE regression test for this round.
  it("never cancels a superseded subscription Stripe reports as active", async () => {
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_old", status: "active" });

    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(res.status).toBe(200);
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    // Not cancelled and about to be overwritten on the row, so it still
    // has to be findable.
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawPayload: expect.objectContaining({
          orphaned_stripe_objects: ["sub_old"],
        }),
      }),
    );
  });

  it("does not record an already-dead subscription as orphaned", async () => {
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_old", status: "canceled" });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(upsertPurchase.mock.calls[0][1]).not.toHaveProperty("rawPayload");
  });

  it("does not cancel a superseded payment intent that already succeeded", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_old",
    });
    paymentIntentsRetrieve.mockResolvedValue({ id: "pi_old", status: "succeeded" });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(paymentIntentsCancel).not.toHaveBeenCalled();
    expect(upsertPurchase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawPayload: expect.objectContaining({
          orphaned_stripe_objects: ["pi_old"],
        }),
      }),
    );
  });

  // Cancelling an incomplete subscription voids its invoice and cancels
  // that invoice's PaymentIntent, so a follow-up cancel on the same row's
  // PI would throw on an already-dead object — a logged "failure" for the
  // single most ordinary case, masking item 2's real errors.
  it("skips the payment intent cancel when the subscription cancel succeeded", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_old",
      stripePaymentIntentId: "pi_old",
    });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_old");
    expect(paymentIntentsRetrieve).not.toHaveBeenCalled();
    expect(paymentIntentsCancel).not.toHaveBeenCalled();
  });
});

// =============================================================
// Reusing the previous attempt's customer
// =============================================================

describe("POST payment-intent — the reused customer", () => {
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
      ],
      metadata: {},
    });
    findProductsByIds
      .mockReset()
      .mockResolvedValue([{ id: "prod_monthly", storeIds: { stripe: "price_m" } }]);
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_1" });
    findPurchaseBySession.mockReset().mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: null,
      stripePaymentIntentId: null,
    });

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_new" });
    customersUpdate.mockReset().mockResolvedValue({ id: "cus_existing" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
    subscriptionsCancel.mockClear();
    paymentIntentsCancel.mockClear();
    subscriptionsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "sub_old", status: "incomplete" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_old", status: "requires_payment_method" });
    requireConnectedStripe.mockClear();
    lockStore.clear();

    resolvePricesForPackages.mockReset().mockResolvedValue({
      $rov_monthly: {
        packageIdentifier: "$rov_monthly",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      },
    });
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

  // A visitor who mistyped their address and re-submits has to be able to
  // correct it — otherwise the receipt goes to the first attempt's typo
  // for good, and the strict email validation guards nothing.
  it("pushes the newly submitted email onto the reused customer", async () => {
    await post({ package_identifier: "$rov_monthly", email: "corrected@b.co" });

    expect(customersUpdate).toHaveBeenCalledWith("cus_existing", {
      email: "corrected@b.co",
    });
    expect(customersCreate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  // The same call proves the customer exists on the account connected
  // *now*. If the project reconnected a different Stripe account between
  // attempts, the id is meaningless there and reusing it would fail the
  // whole payment with "No such customer".
  it("falls through to customers.create when the update rejects", async () => {
    customersUpdate.mockRejectedValue(new Error("No such customer: cus_existing"));

    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(res.status).toBe(200);
    expect(customersCreate).toHaveBeenCalledWith({ email: "a@b.co" });
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
    );
  });

  // findBySession filters on sessionId alone.
  it("does not reuse a row belonging to another project", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_other",
      status: "pending",
      stripeCustomerId: "cus_other",
      stripeSubscriptionId: "sub_other",
      stripePaymentIntentId: null,
    });

    await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(customersUpdate).not.toHaveBeenCalled();
    expect(customersCreate).toHaveBeenCalledWith({ email: "a@b.co" });
    // Nor cancel anything on it.
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });
});

// =============================================================
// Serializing the read-then-write
// =============================================================
//
// findBySession and upsertPending are separate statements with Stripe
// round-trips between them. Unserialized, two POSTs for one session both
// read the same `existing`, both create, both cancel the same old object
// and both upsert — last write wins and the loser's live confirmable
// intent is stranded.

describe("POST payment-intent — the per-session lock", () => {
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
      ],
      metadata: {},
    });
    findProductsByIds
      .mockReset()
      .mockResolvedValue([{ id: "prod_monthly", storeIds: { stripe: "price_m" } }]);
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_1" });
    findPurchaseBySession.mockReset().mockResolvedValue(null);

    chargesEnabled.mockReset().mockResolvedValue(true);
    customersCreate.mockReset().mockResolvedValue({ id: "cus_new" });
    customersUpdate.mockReset().mockResolvedValue({ id: "cus_existing" });
    subscriptionsCreate.mockClear();
    paymentIntentsCreate.mockClear();
    subscriptionsCancel.mockClear();
    paymentIntentsCancel.mockClear();
    subscriptionsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "sub_old", status: "incomplete" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_old", status: "requires_payment_method" });
    requireConnectedStripe.mockClear();
    lockStore.clear();

    resolvePricesForPackages.mockReset().mockResolvedValue({
      $rov_monthly: {
        packageIdentifier: "$rov_monthly",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      },
    });
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

  it("409s and touches nothing on Stripe while another attempt holds the lock", async () => {
    lockStore.set("funnel:payment:sess_1", "another-holders-token");

    const res = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("already in flight");
    expect(customersCreate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(upsertPurchase).not.toHaveBeenCalled();
    // And it must not have released a lock it never held — doing so would
    // hand the key to a third request while the holder is mid-flight.
    expect(lockStore.get("funnel:payment:sess_1")).toBe("another-holders-token");
  });

  it("409s the second of two genuinely concurrent attempts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Called after the lock is acquired, so waiting for it guarantees the
    // first request is inside the critical section.
    customersCreate.mockImplementation(async () => {
      await gate;
      return { id: "cus_new" };
    });

    const first = post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    await vi.waitFor(() => expect(customersCreate).toHaveBeenCalled());

    const second = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(second.status).toBe(409);
    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(subscriptionsCreate).not.toHaveBeenCalled();

    release();
    expect((await first).status).toBe(200);
  });

  it("releases the lock when the request throws, rather than wedging the session", async () => {
    // A 502 from inside the critical section must not hold the key for
    // the rest of its 30s TTL.
    subscriptionsCreate.mockResolvedValueOnce({
      id: "sub_1",
      pending_setup_intent: null,
      latest_invoice: { payment_intent: { id: "pi_1", client_secret: null } },
    });

    const failed = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(failed.status).toBe(502);
    expect(lockStore.has("funnel:payment:sess_1")).toBe(false);

    const next = await post({ package_identifier: "$rov_monthly", email: "a@b.co" });
    expect(next.status).toBe(200);
  });
});
