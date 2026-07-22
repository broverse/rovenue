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
