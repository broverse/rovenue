import { describe, expect, it } from "vitest";
import { mapToConsumptionRequest, type RefundShieldSignals } from "./refund-shield-buckets";

const baseSignals: RefundShieldSignals = {
  customerConsented: true,
  appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
  firstSeenAt: new Date("2026-01-01T00:00:00Z"),
  now: new Date("2026-05-28T00:00:00Z"),
  purchaseStartedAt: new Date("2026-05-01T00:00:00Z"),
  purchaseEndsAt: new Date("2026-06-01T00:00:00Z"),
  wasInTrial: false,
  hasActiveEntitlement: true,
  lifetimeSessionMs: 3_600_000,
  lifetimeDollarsPurchasedCents: 7500,
  lifetimeDollarsRefundedCents: 0,
};

describe("mapToConsumptionRequest", () => {
  it("maps a fully-formed signal set to all 12 Apple fields", () => {
    const out = mapToConsumptionRequest(baseSignals);
    expect(out).toEqual({
      customerConsented: true,
      consumptionStatus: 2, // 27/31 days = ~87% elapsed → PARTIAL
      platform: 1,
      sampleContentProvided: false,
      deliveryStatus: 0,
      appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
      accountTenure: 5, // 147 days → >90d bucket
      playTime: 3, // 60min → 1-6h bucket
      lifetimeDollarsPurchased: 2, // $75 → $50-100 tier
      lifetimeDollarsRefunded: 0,
      userStatus: 1,
      refundPreference: 2,
    });
  });

  describe("consumptionStatus", () => {
    it("returns 1 (NOT_CONSUMED) when <25% elapsed", () => {
      const out = mapToConsumptionRequest({
        ...baseSignals,
        purchaseStartedAt: new Date("2026-05-25T00:00:00Z"),
        purchaseEndsAt:   new Date("2026-06-25T00:00:00Z"),
      });
      expect(out.consumptionStatus).toBe(1);
    });

    it("returns 2 (PARTIAL) when 25-90% elapsed", () => {
      expect(mapToConsumptionRequest(baseSignals).consumptionStatus).toBe(2);
    });

    it("returns 3 (FULLY) when >90% elapsed", () => {
      const out = mapToConsumptionRequest({
        ...baseSignals,
        purchaseStartedAt: new Date("2026-04-01T00:00:00Z"),
        purchaseEndsAt:   new Date("2026-05-29T00:00:00Z"),
      });
      expect(out.consumptionStatus).toBe(3);
    });
  });

  describe("accountTenure", () => {
    const cases: [string, number][] = [
      ["2026-05-27T00:00:00Z", 1], // 1 day
      ["2026-05-22T00:00:00Z", 2], // 6 days
      ["2026-05-10T00:00:00Z", 3], // 18 days
      ["2026-04-10T00:00:00Z", 4], // 48 days
      ["2026-01-01T00:00:00Z", 5], // 147 days
    ];
    it.each(cases)("first_seen %s → bucket %d", (firstSeen, bucket) => {
      const out = mapToConsumptionRequest({ ...baseSignals, firstSeenAt: new Date(firstSeen) });
      expect(out.accountTenure).toBe(bucket);
    });
  });

  describe("playTime", () => {
    const cases: [number, number][] = [
      [0, 0],
      [60_000, 1],          // 1 min
      [10 * 60_000, 2],     // 10 min
      [2 * 60 * 60_000, 3], // 2 h
      [8 * 60 * 60_000, 4], // 8 h
      [20 * 60 * 60_000, 5],// 20 h
    ];
    it.each(cases)("ms=%d → bucket %d", (ms, bucket) => {
      const out = mapToConsumptionRequest({ ...baseSignals, lifetimeSessionMs: ms });
      expect(out.playTime).toBe(bucket);
    });
  });

  describe("lifetimeDollarsPurchased tiers", () => {
    const cases: [number, number][] = [
      [0, 0],
      [3000, 1],     // $30
      [7500, 2],     // $75
      [25000, 3],    // $250
      [70000, 4],    // $700
      [150000, 5],   // $1500
      [250000, 6],   // $2500
      [400000, 7],   // $4000
    ];
    it.each(cases)("cents=%d → tier %d", (cents, tier) => {
      const out = mapToConsumptionRequest({ ...baseSignals, lifetimeDollarsPurchasedCents: cents });
      expect(out.lifetimeDollarsPurchased).toBe(tier);
    });
  });

  it("omits appAccountToken when null", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, appAccountToken: null });
    expect(out.appAccountToken).toBeUndefined();
  });

  it("forces customerConsented=false when project not opted in", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, customerConsented: false });
    expect(out.customerConsented).toBe(false);
  });

  it("sampleContentProvided=true reflects free trial", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, wasInTrial: true });
    expect(out.sampleContentProvided).toBe(true);
  });

  it("userStatus=0 when no active entitlement", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, hasActiveEntitlement: false });
    expect(out.userStatus).toBe(0);
  });
});
