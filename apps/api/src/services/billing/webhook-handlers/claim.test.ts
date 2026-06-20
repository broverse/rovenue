import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// dispatchStripeBillingEvent — atomic claim short-circuit (unit)
// =============================================================
//
// The billing dispatcher previously used the racy no-op
// `upsertWebhookEvent(status: "RECEIVED")` + `status === PROCESSED`
// guard. Under worker concurrency two deliveries of the same event id
// both saw a non-PROCESSED row and both ran the handler inside a tx →
// double effects. We swapped it to the atomic `claimWebhookEvent`.
//
// Contract pinned here (in-process, no Postgres): when
// `claimWebhookEvent` returns null the dispatcher returns
// `{ status: "duplicate" }`, opens NO transaction, and runs NO
// handler. When it returns a row, the matched handler runs inside the
// tx and the row is marked PROCESSED.
// =============================================================

const { drizzleMock, dbMock, handleSubscriptionCreatedMock } = vi.hoisted(
  () => {
    const dbMock = {
      transaction: vi.fn(),
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
    const handleSubscriptionCreatedMock = vi.fn(async () => undefined);
    return { drizzleMock, dbMock, handleSubscriptionCreatedMock };
  },
);

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    db: dbMock,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});

vi.mock("./handle-subscription-created", () => ({
  handleSubscriptionCreated: handleSubscriptionCreatedMock,
}));

import { dispatchStripeBillingEvent } from "./index";
import type Stripe from "stripe";

function makeEvent(): Stripe.Event {
  return {
    id: "evt_billing_claim_1",
    type: "customer.subscription.created",
    data: { object: { id: "sub_1", customer: "cus_1" } },
  } as unknown as Stripe.Event;
}

describe("dispatchStripeBillingEvent — atomic claim short-circuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.billingSubscriptionRepo.findByStripeCustomerId.mockResolvedValue(
      { projectId: "prj_test" },
    );
    // Default transaction impl runs the callback with a fake tx.
    dbMock.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({} as unknown),
    );
  });

  test("returns duplicate, opens no tx and runs no handler when claim returns null", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValueOnce({ outcome: "duplicate" });

    const result = await dispatchStripeBillingEvent(makeEvent());

    expect(result).toEqual({ status: "duplicate" });
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(handleSubscriptionCreatedMock).not.toHaveBeenCalled();
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).not.toHaveBeenCalled();
  });

  test("runs the handler inside a tx and marks PROCESSED when claim returns a row", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValueOnce({
      outcome: "claimed",
      row: { id: "wh_1", status: "PROCESSING" },
    });

    const result = await dispatchStripeBillingEvent(makeEvent());

    expect(result).toEqual({ status: "ok" });
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(handleSubscriptionCreatedMock).toHaveBeenCalledTimes(1);
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledTimes(1);
  });
});
