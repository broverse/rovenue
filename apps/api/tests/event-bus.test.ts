import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/services/event-bus";
import { drizzle } from "@rovenue/db";

vi.mock("@rovenue/db", async (actual) => {
  const real = await actual<typeof import("@rovenue/db")>();
  return {
    ...real,
    drizzle: {
      ...real.drizzle,
      outboxRepo: { insert: vi.fn() },
    },
  };
});

describe("eventBus.publishExposure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an EXPOSURE outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishExposure>[0];
    await eventBus.publishExposure(tx, {
      experimentId: "exp_123",
      variantId: "var_treatment",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      platform: "ios",
      country: "US",
      exposedAt: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(drizzle.outboxRepo.insert).mock.calls[0];
    expect(call[1]).toMatchObject({
      aggregateType: "EXPOSURE",
      aggregateId: "exp_123",
      eventType: "experiment.exposure.recorded",
      payload: expect.objectContaining({
        experimentId: "exp_123",
        variantId: "var_treatment",
      }),
    });
  });
});

describe("eventBus.publishRevenueEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a REVENUE_EVENT outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishRevenueEvent>[0];
    await eventBus.publishRevenueEvent(tx, {
      revenueEventId: "rev_123",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      purchaseId: "pur_1",
      productId: "prod_pro",
      type: "INITIAL_PURCHASE",
      store: "STRIPE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledTimes(1);
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledWith(tx, {
      aggregateType: "REVENUE_EVENT",
      aggregateId: "rev_123",
      eventType: "revenue.event.recorded",
      payload: expect.objectContaining({
        revenueEventId: "rev_123",
        amountUsd: "9.9900",
      }),
    });
  });
});

describe("eventBus.publishCreditLedgerEntry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a CREDIT_LEDGER outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishCreditLedgerEntry>[0];
    await eventBus.publishCreditLedgerEntry(tx, {
      creditLedgerId: "led_1",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      type: "GRANT",
      amount: 100,
      balance: 100,
      referenceType: "PURCHASE",
      referenceId: "pur_1",
      createdAt: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledWith(tx, {
      aggregateType: "CREDIT_LEDGER",
      aggregateId: "led_1",
      eventType: "credit.ledger.appended",
      payload: expect.objectContaining({
        creditLedgerId: "led_1",
        amount: 100,
        balance: 100,
      }),
    });
  });
});
