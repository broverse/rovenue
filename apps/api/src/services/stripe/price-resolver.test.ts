import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectedStripe = vi.hoisted(() => vi.fn());
const pricesRetrieve = vi.hoisted(() => vi.fn());
const redisGet = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());

vi.mock("../../lib/stripe-platform", () => ({ getConnectedStripe }));
vi.mock("../../lib/redis", () => ({
  redis: { get: redisGet, set: redisSet },
}));

import { resolvePricesForPackages } from "./price-resolver";

const RECURRING = {
  id: "price_m",
  unit_amount: 4999,
  currency: "usd",
  recurring: { interval: "month", interval_count: 1, trial_period_days: 7 },
};
const ONE_TIME = {
  id: "price_o",
  unit_amount: 9900,
  currency: "try",
  recurring: null,
};

beforeEach(() => {
  getConnectedStripe.mockReset().mockResolvedValue({
    account: { prices: { retrieve: pricesRetrieve } },
    accountId: "acct_1",
    livemode: true,
  });
  pricesRetrieve.mockReset();
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockReset().mockResolvedValue("OK");
});

describe("resolvePricesForPackages", () => {
  it("returns real amount, currency and interval for a recurring price", async () => {
    pricesRetrieve.mockResolvedValue(RECURRING);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out["$rov_monthly"]).toEqual({
      packageIdentifier: "$rov_monthly",
      priceId: "price_m",
      unitAmount: 4999,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      trialDays: 7,
    });
  });

  it("reports a one-time price with a null interval", async () => {
    pricesRetrieve.mockResolvedValue(ONE_TIME);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_lifetime", stripePriceId: "price_o" },
    ]);
    expect(out["$rov_lifetime"]).toMatchObject({
      interval: null,
      intervalCount: null,
      trialDays: null,
      unitAmount: 9900,
    });
  });

  it("omits a package with no Stripe price id", async () => {
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: null },
    ]);
    expect(out).toEqual({});
    expect(pricesRetrieve).not.toHaveBeenCalled();
  });

  it("omits a package whose price cannot be read, without failing the rest", async () => {
    pricesRetrieve
      .mockRejectedValueOnce(new Error("No such price"))
      .mockResolvedValueOnce(RECURRING);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_gone", stripePriceId: "price_gone" },
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out["$rov_gone"]).toBeUndefined();
    expect(out["$rov_monthly"]).toBeDefined();
  });

  it("returns {} when the project has no Stripe connection", async () => {
    getConnectedStripe.mockResolvedValue(null);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out).toEqual({});
  });

  it("serves a cached price without calling Stripe", async () => {
    redisGet.mockResolvedValue(
      JSON.stringify({
        packageIdentifier: "ignored",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      }),
    );
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(pricesRetrieve).not.toHaveBeenCalled();
    // The cached blob is keyed by price, so the package identifier comes
    // from the request, not from whatever was cached.
    expect(out["$rov_monthly"].packageIdentifier).toBe("$rov_monthly");
  });

  it("caches a freshly read price under account and price id", async () => {
    pricesRetrieve.mockResolvedValue(RECURRING);
    await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(redisSet).toHaveBeenCalledWith(
      "stripe:price:acct_1:price_m",
      expect.any(String),
      "EX",
      300,
    );
  });
});
