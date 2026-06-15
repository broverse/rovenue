import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// processStripeEvent — atomic claim short-circuit (unit)
// =============================================================
//
// Guards the swap from the racy `upsertWebhookEvent` + `status ===
// PROCESSED` check to the atomic `claimWebhookEvent`. The contract we
// pin: when `claimWebhookEvent` returns null (another worker already
// holds PROCESSING or finished PROCESSED), the handler MUST return
// `{ status: "duplicate" }` and MUST NOT run any dispatch / revenue /
// access writes. This is the per-event mirror of the Apple
// single-flight integration test, kept as an in-process unit so it
// runs without Postgres.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    // FINDING 1: syncSubscription runs the guard + upsert inside
    // db.transaction(...). Run the callback inline with the same stub.
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    subscriberRepo: {
      upsertSubscriber: vi.fn(),
      findSubscriberById: vi.fn(async () => null),
    },
    purchaseExtRepo: {
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchaseByStoreTransaction: vi.fn(async () => undefined),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));
// The status-transition guard is exercised by its own suites; here we
// just need it to allow the write so the "happy path" assertion can
// confirm dispatch ran after a successful claim.
vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: vi.fn(async () => ({ apply: true, from: null })),
}));

import { processStripeEvent } from "./stripe-webhook";
import type Stripe from "stripe";

function makeSubscriptionCreatedEvent(): Stripe.Event {
  return {
    id: "evt_stripe_claim_1",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_123",
        status: "active",
        customer: "cus_123",
        items: { data: [{ price: { id: "price_123" } }] },
        metadata: {},
      },
    },
  } as unknown as Stripe.Event;
}

describe("processStripeEvent — atomic claim short-circuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns duplicate and runs no dispatch writes when claim returns null", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValueOnce(null);

    const event = makeSubscriptionCreatedEvent();
    const result = await processStripeEvent({
      projectId: "prj_test",
      event,
      stripe: {} as Stripe,
    });

    expect(result).toEqual({ status: "duplicate", eventType: event.type });

    // No dispatch happened: subscriber/product/purchase/revenue/access
    // writes are all untouched, and we never transition the row.
    expect(drizzleMock.subscriberRepo.upsertSubscriber).not.toHaveBeenCalled();
    expect(drizzleMock.offeringRepo.findProductByStoreId).not.toHaveBeenCalled();
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
    expect(drizzleMock.revenueEventRepo.createRevenueEvent).not.toHaveBeenCalled();
    expect(drizzleMock.webhookEventRepo.updateWebhookEvent).not.toHaveBeenCalled();
  });

  test("proceeds to dispatch when claim returns a row", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValueOnce({
      id: "wh_1",
      status: "PROCESSING",
    });
    drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValueOnce({
      id: "sub_row_1",
    });
    drizzleMock.offeringRepo.findProductByStoreId.mockResolvedValueOnce({
      id: "prod_1",
      accessIds: [],
    });
    drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValueOnce({
      id: "pur_1",
      expiresDate: null,
    });

    const event = makeSubscriptionCreatedEvent();
    const result = await processStripeEvent({
      projectId: "prj_test",
      event,
      stripe: {} as Stripe,
    });

    expect(result.status).toBe("processed");
    // Dispatch ran: the claimed row was transitioned to PROCESSED.
    expect(drizzleMock.subscriberRepo.upsertSubscriber).toHaveBeenCalledTimes(1);
    expect(drizzleMock.webhookEventRepo.updateWebhookEvent).toHaveBeenCalledTimes(1);
  });
});
