import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// dispatchStripeBillingEvent — payment_method.detached routing (unit)
// =============================================================
//
// Stripe nulls `PaymentMethod.customer` as part of the detach operation,
// so `data.object.customer` is null on every `payment_method.detached`
// delivery. Resolving the project only from `data.object.customer` made
// the handler unreachable (`project_not_found` every time) and detached
// cards lingered in billing_payment_methods. Contract pinned here: the
// dispatcher falls back to `data.previous_attributes.customer`.
// =============================================================

const { drizzleMock, dbMock, handleDetachedMock } = vi.hoisted(() => {
  const dbMock = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({})),
  };
  const drizzleMock = {
    billingSubscriptionRepo: {
      findByStripeCustomerId: vi.fn(),
    },
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
  };
  const handleDetachedMock = vi.fn(async () => undefined);
  return { drizzleMock, dbMock, handleDetachedMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    db: dbMock,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});

vi.mock("./handle-payment-method-detached", () => ({
  handlePaymentMethodDetached: handleDetachedMock,
}));

import { dispatchStripeBillingEvent } from "./index";
import type Stripe from "stripe";

function makeDetachedEvent(): Stripe.Event {
  return {
    id: "evt_pm_detached_1",
    type: "payment_method.detached",
    data: {
      object: { id: "pm_1", object: "payment_method", customer: null },
      previous_attributes: { customer: "cus_detached_1" },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<void>) => fn({}),
  );
});

describe("payment_method.detached customer resolution", () => {
  test("resolves the project from previous_attributes.customer and runs the handler", async () => {
    drizzleMock.billingSubscriptionRepo.findByStripeCustomerId.mockResolvedValue(
      { projectId: "proj_1" },
    );
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "claimed",
      row: { id: "wh_1" },
    });

    const result = await dispatchStripeBillingEvent(makeDetachedEvent());

    expect(result).toEqual({ status: "ok" });
    expect(
      drizzleMock.billingSubscriptionRepo.findByStripeCustomerId,
    ).toHaveBeenCalledWith(expect.anything(), "cus_detached_1");
    expect(handleDetachedMock).toHaveBeenCalledTimes(1);
  });

  test("still returns project_not_found when neither field carries a customer", async () => {
    const event = makeDetachedEvent();
    (event.data as { previous_attributes?: unknown }).previous_attributes = {};

    const result = await dispatchStripeBillingEvent(event);

    expect(result).toEqual({ status: "project_not_found" });
    expect(handleDetachedMock).not.toHaveBeenCalled();
  });
});
