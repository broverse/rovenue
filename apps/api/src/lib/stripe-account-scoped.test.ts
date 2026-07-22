import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { withAccount } from "./stripe-account-scoped";

// =============================================================
// withAccount — the direct-charge invariant
// =============================================================
//
// This is where `{ stripeAccount }` is enforced for the whole codebase.
// Call sites no longer pass it, so if these assertions stop holding,
// every connected-account call in the product silently starts acting on
// Rovenue's own Stripe account instead of the customer's — with no error
// anywhere, because that is a perfectly valid call.

function stubClient() {
  const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
  const subscriptionsUpdate = vi.fn(async () => ({ id: "sub_1" }));
  const invoicesRetrieve = vi.fn(async () => ({ id: "in_1" }));
  const stripe = {
    refunds: { create: refundsCreate },
    subscriptions: { update: subscriptionsUpdate },
    invoices: { retrieve: invoicesRetrieve },
  } as unknown as Stripe;
  return { stripe, refundsCreate, subscriptionsUpdate, invoicesRetrieve };
}

describe("withAccount", () => {
  it("binds stripeAccount to refunds.create", async () => {
    const { stripe, refundsCreate } = stubClient();
    await withAccount(stripe, "acct_x").refunds.create({ charge: "ch_1" });
    expect(refundsCreate).toHaveBeenCalledWith(
      { charge: "ch_1" },
      { stripeAccount: "acct_x" },
    );
  });

  it("binds stripeAccount to subscriptions.update", async () => {
    const { stripe, subscriptionsUpdate } = stubClient();
    await withAccount(stripe, "acct_x").subscriptions.update("sub_1", {
      cancel_at_period_end: true,
    });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      { cancel_at_period_end: true },
      { stripeAccount: "acct_x" },
    );
  });

  it("binds stripeAccount to invoices.retrieve", async () => {
    const { stripe, invoicesRetrieve } = stubClient();
    await withAccount(stripe, "acct_x").invoices.retrieve("in_1");
    expect(invoicesRetrieve).toHaveBeenCalledWith("in_1", {
      stripeAccount: "acct_x",
    });
  });

  it("keeps caller options alongside the bound account", async () => {
    const { stripe, refundsCreate } = stubClient();
    await withAccount(stripe, "acct_x").refunds.create(
      { charge: "ch_1" },
      { idempotencyKey: "refund_pur_1" },
    );
    // A retried refund without its idempotency key double-refunds the
    // customer, so the binding must not swallow what the caller passed.
    expect(refundsCreate).toHaveBeenCalledWith(
      { charge: "ch_1" },
      { idempotencyKey: "refund_pur_1", stripeAccount: "acct_x" },
    );
  });

  it("cannot be redirected by a caller-supplied stripeAccount", async () => {
    const { stripe, refundsCreate } = stubClient();
    // The type forbids this; the spread order is what stops a cast from
    // getting around it at runtime.
    await withAccount(stripe, "acct_real").refunds.create({ charge: "ch_1" }, {
      stripeAccount: "acct_attacker",
    } as never);
    expect(refundsCreate).toHaveBeenCalledWith(
      { charge: "ch_1" },
      { stripeAccount: "acct_real" },
    );
  });

  it("scopes each account independently", async () => {
    const { stripe, invoicesRetrieve } = stubClient();
    await withAccount(stripe, "acct_a").invoices.retrieve("in_a");
    await withAccount(stripe, "acct_b").invoices.retrieve("in_b");
    expect(invoicesRetrieve).toHaveBeenNthCalledWith(1, "in_a", {
      stripeAccount: "acct_a",
    });
    expect(invoicesRetrieve).toHaveBeenNthCalledWith(2, "in_b", {
      stripeAccount: "acct_b",
    });
  });
});

function stubClientWide() {
  const fns = {
    pricesRetrieve: vi.fn(async () => ({ id: "price_1" })),
    customersCreate: vi.fn(async () => ({ id: "cus_1" })),
    paymentIntentsCreate: vi.fn(async () => ({ id: "pi_1" })),
    paymentIntentsRetrieve: vi.fn(async () => ({ id: "pi_1" })),
    paymentIntentsCancel: vi.fn(async () => ({ id: "pi_1", status: "canceled" })),
    subscriptionsCreate: vi.fn(async () => ({ id: "sub_1" })),
    subscriptionsRetrieve: vi.fn(async () => ({ id: "sub_1" })),
    subscriptionsCancel: vi.fn(async () => ({ id: "sub_1", status: "canceled" })),
    domainsCreate: vi.fn(async () => ({ id: "pmd_1" })),
    domainsList: vi.fn(async () => ({ data: [] })),
  };
  const stripe = {
    prices: { retrieve: fns.pricesRetrieve },
    customers: { create: fns.customersCreate },
    paymentIntents: {
      create: fns.paymentIntentsCreate,
      retrieve: fns.paymentIntentsRetrieve,
      cancel: fns.paymentIntentsCancel,
    },
    subscriptions: {
      create: fns.subscriptionsCreate,
      retrieve: fns.subscriptionsRetrieve,
      cancel: fns.subscriptionsCancel,
    },
    paymentMethodDomains: { create: fns.domainsCreate, list: fns.domainsList },
  } as unknown as Stripe;
  return { stripe, ...fns };
}

describe("withAccount — payment resources", () => {
  it("binds stripeAccount to prices.retrieve", async () => {
    const { stripe, pricesRetrieve } = stubClientWide();
    await withAccount(stripe, "acct_x").prices.retrieve("price_1");
    expect(pricesRetrieve).toHaveBeenCalledWith("price_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to customers.create", async () => {
    const { stripe, customersCreate } = stubClientWide();
    await withAccount(stripe, "acct_x").customers.create({ email: "a@b.c" });
    expect(customersCreate).toHaveBeenCalledWith(
      { email: "a@b.c" },
      { stripeAccount: "acct_x" },
    );
  });

  it("binds stripeAccount to paymentIntents.create and .retrieve", async () => {
    const { stripe, paymentIntentsCreate, paymentIntentsRetrieve } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.paymentIntents.create({ amount: 100, currency: "usd" });
    await acct.paymentIntents.retrieve("pi_1");
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      { amount: 100, currency: "usd" },
      { stripeAccount: "acct_x" },
    );
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith("pi_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to subscriptions.create and .retrieve", async () => {
    const { stripe, subscriptionsCreate, subscriptionsRetrieve } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.subscriptions.create({ customer: "cus_1", items: [] });
    await acct.subscriptions.retrieve("sub_1");
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      { customer: "cus_1", items: [] },
      { stripeAccount: "acct_x" },
    );
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_1", {
      stripeAccount: "acct_x",
    });
  });

  // Cancels clean up the Stripe objects a superseded funnel payment
  // attempt left behind. Unbound they would cancel nothing on the
  // connected account and 404 (or worse, hit a same-id object on the
  // platform account), so the binding matters here too.
  it("binds stripeAccount to paymentIntents.cancel", async () => {
    const { stripe, paymentIntentsCancel } = stubClientWide();
    await withAccount(stripe, "acct_x").paymentIntents.cancel("pi_1");
    expect(paymentIntentsCancel).toHaveBeenCalledWith("pi_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to subscriptions.cancel", async () => {
    const { stripe, subscriptionsCancel } = stubClientWide();
    await withAccount(stripe, "acct_x").subscriptions.cancel("sub_1");
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to paymentMethodDomains", async () => {
    const { stripe, domainsCreate, domainsList } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.paymentMethodDomains.create({ domain_name: "app.rovenue.io" });
    await acct.paymentMethodDomains.list({ domain_name: "app.rovenue.io" });
    expect(domainsCreate).toHaveBeenCalledWith(
      { domain_name: "app.rovenue.io" },
      { stripeAccount: "acct_x" },
    );
    expect(domainsList).toHaveBeenCalledWith(
      { domain_name: "app.rovenue.io" },
      { stripeAccount: "acct_x" },
    );
  });
});
