// =============================================================
// scheduled-actions worker — unit tests (Stripe Connect rewire)
// =============================================================
//
// Focused unit coverage for executeAction()'s STRIPE branch. The existing
// scheduled-actions.integration.test.ts exercises runScheduledActionsSweep()
// end-to-end against a real Postgres instance but only covers the MANUAL
// store path — there is no fixture there for a STRIPE purchase, and adding
// one would mean either hitting the real Stripe API or mocking modules
// inside a test file that otherwise deliberately avoids vi.mock() to stay
// close to production wiring. A small, mocked unit test alongside the
// integration suite is the cheaper and more precise way to pin down the
// Stripe Connect call shape (stripeAccount request option + the
// missing-connection throw) without touching that file's contract.
//
// @rovenue/db is mocked so this test never touches Postgres (same pattern
// as ../workers/webhook-reaper.test.ts and ../workers/usage-cap-sweeper.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const getConnectedStripe = vi.hoisted(() => vi.fn());
vi.mock("../lib/stripe-platform", () => ({ getConnectedStripe }));
vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/env", () => ({
  env: { REDIS_URL: "redis://localhost:6379", NODE_ENV: "test" },
}));
vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    schema: {
      purchases: {},
      subscriberAccess: {},
      scheduledSubscriptionActions: {},
    },
    outboxRepo: { insert: vi.fn() },
    projectRepo: { findProjectWebhookUrl: vi.fn() },
    outgoingWebhookRepo: { enqueueOutgoingWebhook: vi.fn() },
  },
}));

import { executeAction } from "./scheduled-actions";

type FakeTx = Parameters<typeof executeAction>[0];

function makeTx(purchaseRow: Record<string, unknown>): FakeTx {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve([purchaseRow]),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => Promise.resolve(undefined),
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as FakeTx;
}

const baseRow = {
  id: "act_1",
  purchaseId: "pur_1",
  createdBy: "user-1",
  payload: {},
} as unknown as Parameters<typeof executeAction>[1];

function stripePurchase() {
  return {
    id: "pur_1",
    projectId: "proj_1",
    store: "STRIPE",
    originalTransactionId: "sub_123",
    priceCurrency: "USD",
  };
}

beforeEach(() => {
  getConnectedStripe.mockReset();
});

describe("executeAction — STRIPE", () => {
  it("cancels the subscription on the connected account", async () => {
    const subscriptionsUpdate = vi.fn(async () => ({}));
    getConnectedStripe.mockResolvedValue({
      stripe: { subscriptions: { update: subscriptionsUpdate } },
      accountId: "acct_1",
      livemode: true,
    });

    const tx = makeTx(stripePurchase());
    await executeAction(tx, baseRow);

    expect(getConnectedStripe).toHaveBeenCalledWith("proj_1");
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_123",
      { cancel_at_period_end: true },
      { stripeAccount: "acct_1" },
    );
  });

  it("throws when the project has no active Stripe connection", async () => {
    getConnectedStripe.mockResolvedValue(null);

    const tx = makeTx(stripePurchase());

    await expect(executeAction(tx, baseRow)).rejects.toThrow(
      /no active Stripe connection/,
    );
  });
});
