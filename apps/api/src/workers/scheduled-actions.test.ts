// =============================================================
// scheduled-actions worker — unit tests (Stripe Connect rewire)
// =============================================================
//
// Focused unit coverage for the Stripe Connect wiring the scheduled-cancel
// path uses. The existing scheduled-actions.integration.test.ts exercises
// runScheduledActionsSweep() end-to-end against a real Postgres instance
// but only covers the MANUAL store path — there is no fixture there for a
// STRIPE purchase, and adding one would mean either hitting the real
// Stripe API or mocking modules inside a test file that otherwise
// deliberately avoids vi.mock() to stay close to production wiring.
//
// These tests target `cancelStripeSubscriptionAtPeriodEnd` directly rather
// than the whole action executor: it is the only part this task changed,
// and driving it through `executeAction` would have meant exporting the
// executor purely for test access, widening the module's boundary for no
// extra coverage of the Connect wiring.
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

import { cancelStripeSubscriptionAtPeriodEnd } from "./scheduled-actions";

beforeEach(() => {
  getConnectedStripe.mockReset();
});

describe("cancelStripeSubscriptionAtPeriodEnd", () => {
  it("cancels the subscription on the connected account", async () => {
    const subscriptionsUpdate = vi.fn(async () => ({}));
    getConnectedStripe.mockResolvedValue({
      account: { subscriptions: { update: subscriptionsUpdate } },
      accountId: "acct_1",
      livemode: true,
    });

    await cancelStripeSubscriptionAtPeriodEnd("proj_1", "sub_123");

    expect(getConnectedStripe).toHaveBeenCalledWith("proj_1");
    // The header itself is bound inside withAccount (see
    // lib/stripe-account-scoped.test.ts); what this pins is that the
    // worker goes through the account-scoped facade at all, rather than
    // reaching for a raw platform client.
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_123", {
      cancel_at_period_end: true,
    });
  });

  it("throws when the project has no active Stripe connection", async () => {
    // A throw is the retry signal inside a BullMQ job — deliberately
    // unlike the refund path, which returns a result object.
    getConnectedStripe.mockResolvedValue(null);

    await expect(
      cancelStripeSubscriptionAtPeriodEnd("proj_1", "sub_123"),
    ).rejects.toThrow(/no active Stripe connection/);
  });
});
