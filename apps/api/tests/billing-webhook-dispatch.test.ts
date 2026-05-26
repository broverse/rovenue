import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// =============================================================
// Unit test: Stripe billing webhook dispatcher
// =============================================================
// The dispatcher decides whether to ignore / dedupe / run a
// handler based on event type + customer + webhook_events state.
// Real handler bodies (Task 11-16) are unit-tested separately and
// integration-tested in Task 18; here we mock both the data layer
// and the handler modules so only the dispatcher's branching is
// exercised.

const { findByCustomer, upsertWh, updateWh } = vi.hoisted(() => ({
  findByCustomer: vi.fn(),
  upsertWh: vi.fn(),
  updateWh: vi.fn(),
}));

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...(actual.drizzle as Record<string, unknown>),
      billingSubscriptionRepo: {
        findByStripeCustomerId: findByCustomer,
      },
      webhookEventRepo: {
        upsertWebhookEvent: upsertWh,
        updateWebhookEvent: updateWh,
      },
    },
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        await fn({}),
    },
  };
});

const {
  setupIntentHandler,
  subscriptionCreatedHandler,
  subscriptionUpdatedHandler,
  invoiceUpsertHandler,
  invoicePaidHandler,
  chargeRefundedHandler,
  paymentMethodDetachedHandler,
} = vi.hoisted(() => ({
  setupIntentHandler: vi.fn(async () => ({})),
  subscriptionCreatedHandler: vi.fn(async () => undefined),
  subscriptionUpdatedHandler: vi.fn(async () => undefined),
  invoiceUpsertHandler: vi.fn(async () => undefined),
  invoicePaidHandler: vi.fn(async () => undefined),
  chargeRefundedHandler: vi.fn(async () => undefined),
  paymentMethodDetachedHandler: vi.fn(async () => undefined),
}));

vi.mock(
  "../src/services/billing/webhook-handlers/handle-setup-intent-succeeded",
  () => ({ handleSetupIntentSucceeded: setupIntentHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-subscription-created",
  () => ({ handleSubscriptionCreated: subscriptionCreatedHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-subscription-updated",
  () => ({ handleSubscriptionUpdated: subscriptionUpdatedHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-invoice-upsert",
  () => ({ handleInvoiceUpsert: invoiceUpsertHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-invoice-payment-succeeded",
  () => ({ handleInvoicePaymentSucceeded: invoicePaidHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-charge-refunded",
  () => ({ handleChargeRefunded: chargeRefundedHandler }),
);
vi.mock(
  "../src/services/billing/webhook-handlers/handle-payment-method-detached",
  () => ({ handlePaymentMethodDetached: paymentMethodDetachedHandler }),
);

import { dispatchStripeBillingEvent } from "../src/services/billing/webhook-handlers";

function makeEvent(
  type: string,
  obj: Record<string, unknown>,
  id = "evt_test_1",
): Stripe.Event {
  return {
    id,
    type,
    api_version: "2024-04-10",
    created: 1700000000,
    livemode: false,
    object: "event",
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: obj },
  } as unknown as Stripe.Event;
}

describe("dispatchStripeBillingEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'ignored' for unknown event types and never touches webhook_events", async () => {
    const event = makeEvent("customer.created", { customer: "cus_123" });

    const result = await dispatchStripeBillingEvent(event);

    expect(result).toEqual({ status: "ignored" });
    expect(findByCustomer).not.toHaveBeenCalled();
    expect(upsertWh).not.toHaveBeenCalled();
    expect(updateWh).not.toHaveBeenCalled();
  });

  it("returns 'project_not_found' when no billing_subscriptions row matches the customer", async () => {
    findByCustomer.mockResolvedValueOnce(null);
    const event = makeEvent("customer.subscription.updated", {
      customer: "cus_orphan",
    });

    const result = await dispatchStripeBillingEvent(event);

    expect(result).toEqual({ status: "project_not_found" });
    expect(findByCustomer).toHaveBeenCalledWith(expect.anything(), "cus_orphan");
    expect(upsertWh).not.toHaveBeenCalled();
    expect(updateWh).not.toHaveBeenCalled();
    expect(subscriptionUpdatedHandler).not.toHaveBeenCalled();
  });

  it("returns 'duplicate' when webhook_events row is already PROCESSED and skips the handler", async () => {
    findByCustomer.mockResolvedValueOnce({ projectId: "proj_1" });
    upsertWh.mockResolvedValueOnce({ id: "wh_1", status: "PROCESSED" });

    const event = makeEvent(
      "customer.subscription.updated",
      { customer: "cus_dup" },
      "evt_dup",
    );

    const result = await dispatchStripeBillingEvent(event);

    expect(result).toEqual({ status: "duplicate" });
    expect(subscriptionUpdatedHandler).not.toHaveBeenCalled();
    expect(updateWh).not.toHaveBeenCalled();
  });

  it("happy path: runs handler in tx and marks webhook_events PROCESSED", async () => {
    findByCustomer.mockResolvedValueOnce({ projectId: "proj_42" });
    upsertWh.mockResolvedValueOnce({ id: "wh_42", status: "RECEIVED" });
    updateWh.mockResolvedValueOnce(undefined);

    const event = makeEvent(
      "customer.subscription.updated",
      { customer: "cus_happy" },
      "evt_happy",
    );

    const result = await dispatchStripeBillingEvent(event);

    expect(result).toEqual({ status: "ok" });
    expect(upsertWh).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "proj_42",
        source: "STRIPE",
        eventType: "customer.subscription.updated",
        storeEventId: "evt_happy",
        status: "RECEIVED",
      }),
    );
    expect(subscriptionUpdatedHandler).toHaveBeenCalledTimes(1);
    expect(subscriptionUpdatedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        event,
        projectId: "proj_42",
      }),
    );
    expect(updateWh).toHaveBeenCalledWith(
      expect.anything(),
      "wh_42",
      expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
      }),
    );
  });
});
