import { describe, expect, it } from "vitest";
import type { LiveEventMessage } from "@rovenue/shared";
import { messageToLiveEvent } from "./mappers";

const base = (over: Partial<LiveEventMessage>): LiveEventMessage => ({
  eventId: "evt_1",
  eventType: "revenue.event.recorded",
  aggregateType: "REVENUE_EVENT",
  aggregateId: "agg_1",
  payload: {},
  occurredAt: "2026-06-16T10:00:00.000Z",
  ...over,
});

describe("messageToLiveEvent", () => {
  it("maps a revenue initial purchase with positive USD amount and store platform", () => {
    const e = messageToLiveEvent(
      base({
        payload: {
          type: "INITIAL",
          store: "APP_STORE",
          currency: "USD",
          subscriberId: "sub_9",
          productId: "prod_9",
          amount: "9.99",
          amountUsd: "9.99",
        },
      }),
    );
    expect(e.type).toBe("new_subscription");
    expect(e.amount).toBe(9.99);
    expect(e.platform).toBe("ios");
    expect(e.store).toBe("APP_STORE");
    expect(e.user).toBe("sub_9");
    expect(e.product).toBe("prod_9");
    expect(e.typeMeta.category).toBe("subscription");
  });

  it("renders refunds as a negative amount", () => {
    const e = messageToLiveEvent(
      base({ payload: { type: "REFUND", store: "PLAY_STORE", amountUsd: "4.99" } }),
    );
    expect(e.type).toBe("refund");
    expect(e.amount).toBe(-4.99);
    expect(e.platform).toBe("android");
  });

  it("maps a credit ledger spend with no money amount", () => {
    const e = messageToLiveEvent(
      base({
        eventType: "credit.ledger.appended",
        aggregateType: "CREDIT_LEDGER",
        payload: { type: "SPEND", subscriberId: "sub_3", amount: -50, balance: 150 },
      }),
    );
    expect(e.type).toBe("credit_spent");
    expect(e.amount).toBeNull();
    expect(e.currency).toBeNull();
    expect(e.user).toBe("sub_3");
    expect(e.typeMeta.category).toBe("ledger");
  });

  it("maps an experiment exposure with platform and country", () => {
    const e = messageToLiveEvent(
      base({
        eventType: "experiment.exposure.recorded",
        aggregateType: "EXPOSURE",
        payload: { subscriberId: "sub_7", platform: "android", country: "TR" },
      }),
    );
    expect(e.type).toBe("experiment_exposure");
    expect(e.platform).toBe("android");
    expect(e.country).toBe("TR");
    expect(e.product).toBeNull();
  });

  it("maps a platform billing invoice payment", () => {
    const e = messageToLiveEvent(
      base({
        eventType: "billing.invoice.paid",
        aggregateType: "BILLING",
        payload: { projectId: "p_1", amountPaid: "29.00" },
      }),
    );
    expect(e.type).toBe("invoice_paid");
    expect(e.amount).toBe(29);
    expect(e.currency).toBe("USD");
    expect(e.user).toBeNull();
  });

  it("falls open to unknown for an aggregate with no mapping", () => {
    const e = messageToLiveEvent(
      base({ eventType: "weird.thing", aggregateType: "FUNNEL", payload: {} }),
    );
    expect(e.type).toBe("unknown");
    expect(e.typeMeta.key).toBe("unknown");
  });

  it("retains the raw payload for the detail panel", () => {
    const payload = { type: "RENEWAL", amount: "1.99", custom: "x" };
    const e = messageToLiveEvent(base({ payload }));
    expect(e.payload).toEqual(payload);
  });
});
