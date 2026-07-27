import { describe, expect, it, vi, beforeEach } from "vitest";
import { StoreApiError } from "./apple/app-store-connect";

// Mock redis before the subject is imported so the module receives the stub.
// Backed by a shared in-memory Map so tests can pre-populate cache entries
// (case f) and inspect what got written (cases e, f).
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("../lib/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
  },
}));

import { redis } from "../lib/redis";
import {
  RESOLVED_PRICE_CACHE_TTL_SECONDS,
  resolveOfferingPrices,
} from "./offering-price-resolver";

const APPLE_CACHE_KEY = "paywall:resolved:apple:proj1:off1";

function baseOffering(packages: unknown) {
  return {
    id: "off1",
    identifier: "default",
    isDefault: true,
    packages,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

function subscriptionProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod1",
    identifier: "pro_monthly",
    type: "SUBSCRIPTION",
    isActive: true,
    displayName: "Pro Monthly",
    storeIds: { apple: "apple_sku", google: "google_sku", stripe: "price_123" },
    androidBasePlanId: "base1",
    androidOfferId: null,
    metadata: { period: "P1M" },
    ...overrides,
  } as any;
}

const applePrice = {
  productId: "apple_sku",
  period: "P1M",
  amountMinor: 999,
  currency: "USD",
  trialDays: 7,
};

const googlePrice = {
  productId: "google_sku",
  basePlanId: "base1",
  period: "P1M",
  amountMinor: 999,
  currency: "USD",
  trialDays: 7,
};

const stripeResolved = {
  packageIdentifier: "pkg_monthly",
  priceId: "price_123",
  unitAmount: 999,
  currency: "usd",
  interval: "month" as const,
  intervalCount: 1,
  trialDays: 7,
};

const baseOverrides = {
  loadApple: async () => ({ bundleId: "com.acme.app", keyId: "k", issuerId: "i", privateKey: "p" }),
  loadGoogle: async () => ({
    packageName: "com.acme.app",
    serviceAccount: { client_email: "e", private_key: "p" },
  }),
  listAppStorePrices: vi.fn(async () => new Map([["apple_sku", applePrice]])),
  listGooglePlayPrices: vi.fn(async () => new Map([["google_sku:base1", googlePrice]])),
  resolveStripePrices: vi.fn(async () => ({ pkg_monthly: stripeResolved })),
};

const onePackage = [{ identifier: "pkg_monthly", productId: "prod1", order: 0, isPromoted: false }];

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("resolveOfferingPrices", () => {
  it("(a) returns null for an unknown offering", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () => null,
    });
    expect(result).toBeNull();
  });

  it("(b) fully-configured happy path resolves all three stores", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () => baseOffering(onePackage),
      findProducts: async () => [subscriptionProduct()],
      ...baseOverrides,
    });

    expect(result).not.toBeNull();
    const pkg = result!.packages[0]!;
    expect(pkg.packageIdentifier).toBe("pkg_monthly");
    expect(pkg.productId).toBe("prod1");
    expect(pkg.stores.apple).toEqual({
      status: "ok",
      amountMinor: 999,
      currency: "USD",
      period: "P1M",
      trialDays: 7,
    });
    expect(pkg.stores.google).toEqual({
      status: "ok",
      amountMinor: 999,
      currency: "USD",
      period: "P1M",
      trialDays: 7,
    });
    // stripe: interval "month"/1 -> "P1M"; currency uppercased from stripe's lowercase.
    expect(pkg.stores.stripe).toEqual({
      status: "ok",
      amountMinor: 999,
      currency: "USD",
      period: "P1M",
      trialDays: 7,
    });
  });

  it("(c) isolates a per-store failure — apple errors, google and stripe still resolve", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () => baseOffering(onePackage),
      findProducts: async () => [subscriptionProduct()],
      ...baseOverrides,
      listAppStorePrices: vi.fn(async () => {
        throw new StoreApiError("apple boom");
      }),
    });

    expect(result).not.toBeNull();
    const pkg = result!.packages[0]!;
    expect(pkg.stores.apple).toEqual({ status: "error" });
    expect(pkg.stores.google?.status).toBe("ok");
    expect(pkg.stores.stripe?.status).toBe("ok");
  });

  it("(d) missing apple creds -> not_configured; google missing basePlanId -> no_mapping", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () => baseOffering(onePackage),
      findProducts: async () => [subscriptionProduct({ androidBasePlanId: null })],
      ...baseOverrides,
      loadApple: async () => null,
    });

    expect(result).not.toBeNull();
    const pkg = result!.packages[0]!;
    expect(pkg.stores.apple).toEqual({ status: "not_configured" });
    expect(pkg.stores.google).toEqual({ status: "no_mapping" });
  });

  it("(e) apple error is not cached; a later successful call is cached", async () => {
    let calls = 0;
    const listAppStorePrices = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new StoreApiError("apple boom");
      return new Map([["apple_sku", applePrice]]);
    });

    const overrides = {
      findOffering: async () => baseOffering(onePackage),
      findProducts: async () => [subscriptionProduct()],
      ...baseOverrides,
      listAppStorePrices,
    };

    const first = await resolveOfferingPrices("proj1", "off1", overrides);
    expect(first!.packages[0]!.stores.apple).toEqual({ status: "error" });
    expect(store.has(APPLE_CACHE_KEY)).toBe(false);

    const second = await resolveOfferingPrices("proj1", "off1", overrides);
    expect(second!.packages[0]!.stores.apple).toEqual({
      status: "ok",
      amountMinor: 999,
      currency: "USD",
      period: "P1M",
      trialDays: 7,
    });
    expect(store.has(APPLE_CACHE_KEY)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      APPLE_CACHE_KEY,
      expect.any(String),
      "EX",
      RESOLVED_PRICE_CACHE_TTL_SECONDS,
    );
    expect(RESOLVED_PRICE_CACHE_TTL_SECONDS).toBe(900);
  });

  it("(f) a cache hit short-circuits the apple lister", async () => {
    store.set(APPLE_CACHE_KEY, JSON.stringify({ apple_sku: applePrice }));

    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () => baseOffering(onePackage),
      findProducts: async () => [subscriptionProduct()],
      ...baseOverrides,
    });

    expect(baseOverrides.listAppStorePrices).not.toHaveBeenCalled();
    expect(result!.packages[0]!.stores.apple).toEqual({
      status: "ok",
      amountMinor: 999,
      currency: "USD",
      period: "P1M",
      trialDays: 7,
    });
  });

  it("(g) metadataPeriod passes through, defaulting to null when absent", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () =>
        baseOffering([
          { identifier: "pkg_a", productId: "prod1", order: 0, isPromoted: false },
          { identifier: "pkg_b", productId: "prod2", order: 1, isPromoted: false },
        ]),
      findProducts: async () => [
        subscriptionProduct({ metadata: { period: "P1Y" } }),
        subscriptionProduct({ id: "prod2", identifier: "pro_annual", metadata: {} }),
      ],
      ...baseOverrides,
    });

    const byId = new Map(result!.packages.map((p) => [p.packageIdentifier, p]));
    expect(byId.get("pkg_a")!.metadataPeriod).toBe("P1Y");
    expect(byId.get("pkg_b")!.metadataPeriod).toBeNull();
  });

  it("(h) an inactive product is skipped entirely", async () => {
    const result = await resolveOfferingPrices("proj1", "off1", {
      findOffering: async () =>
        baseOffering([
          { identifier: "pkg_active", productId: "prod1", order: 0, isPromoted: false },
          { identifier: "pkg_inactive", productId: "prod2", order: 1, isPromoted: false },
        ]),
      findProducts: async () => [
        subscriptionProduct(),
        subscriptionProduct({ id: "prod2", identifier: "pro_gone", isActive: false }),
      ],
      ...baseOverrides,
    });

    expect(result!.packages).toHaveLength(1);
    expect(result!.packages[0]!.packageIdentifier).toBe("pkg_active");
  });
});
