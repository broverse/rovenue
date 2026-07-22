import { beforeEach, describe, expect, it, vi } from "vitest";

// The public route reads the runtime cache before falling back to
// Postgres, and writes it back once loaded. Redis is not running in this
// test environment, so it's stubbed with a plain in-memory Map — same
// approach as stripe-connect-routes.test.ts.
const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  },
}));

// `resolvePricesForPackages` (Task 2) is exercised elsewhere; here it's a
// bare vi.fn() so these tests pin only what the route passes to it and
// where the result lands in the response body.
const resolvePricesForPackages = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../src/services/stripe/price-resolver", () => ({
  resolvePricesForPackages,
}));

// The route's slug lookup goes through a raw drizzle.db.select() chain
// (not a repo function), so it's stubbed to resolve whatever row the
// current test staged in `funnelRow.value` regardless of the where()
// filter it was built with — the filter itself isn't evaluated.
const funnelRow = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
const findFunnelById = vi.hoisted(() => vi.fn());
const findVersionById = vi.hoisted(() => vi.fn());
const findPaywallsByIds = vi.hoisted(() => vi.fn(async () => []));
const findOfferingById = vi.hoisted(() => vi.fn(async () => null));
const findProductsByIds = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve(funnelRow.value ? [funnelRow.value] : []),
            }),
          }),
        }),
      },
      funnelRepo: { findById: findFunnelById },
      funnelVersionRepo: { findById: findVersionById },
      paywallRepo: { findPaywallsByIds },
      offeringRepo: { findOfferingById, findProductsByIds },
    },
  };
});

async function buildApp() {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  return createApp();
}

describe("GET /public/funnels/:slug — prices", () => {
  beforeEach(() => {
    redisStore.clear();
    resolvePricesForPackages.mockReset().mockResolvedValue({});
    findFunnelById.mockReset();
    findVersionById.mockReset();
    findPaywallsByIds.mockReset().mockResolvedValue([]);
    findOfferingById.mockReset().mockResolvedValue(null);
    findProductsByIds.mockReset().mockResolvedValue([]);
    funnelRow.value = null;
  });

  function stageOnboardingFunnel() {
    funnelRow.value = {
      id: "fnl_1",
      projectId: "proj_1",
      slug: "onboarding",
      status: "published",
      currentVersionId: "ver_1",
    };
    findVersionById.mockResolvedValue({
      id: "ver_1",
      pagesJson: [{ id: "p1", type: "paywall", paywallId: "pw_1" }],
      themeJson: {},
      settingsJson: {},
    });
    findFunnelById.mockResolvedValue({ id: "fnl_1", projectId: "proj_1" });
    findPaywallsByIds.mockResolvedValue([
      {
        id: "pw_1",
        builderConfig: { formatVersion: 2 },
        configFormatVersion: 2,
        offeringId: "off_1",
      },
    ]);
    findOfferingById.mockResolvedValue({
      identifier: "default",
      isDefault: true,
      packages: [
        {
          identifier: "$rov_monthly",
          productId: "prod_1",
          order: 0,
          isPromoted: false,
        },
      ],
      metadata: {},
    });
    findProductsByIds.mockResolvedValue([
      {
        id: "prod_1",
        identifier: "monthly_product",
        type: "subscription",
        displayName: "Monthly",
        accessIds: [],
        isActive: true,
        storeIds: { stripe: "price_m" },
        androidBasePlanId: null,
        androidOfferId: null,
      },
    ]);
  }

  it("serves a prices map keyed by paywall id then package identifier", async () => {
    stageOnboardingFunnel();
    resolvePricesForPackages.mockResolvedValue({
      $rov_monthly: {
        packageIdentifier: "$rov_monthly",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      },
    });
    const app = await buildApp();
    const res = await app.request("/public/funnels/onboarding");
    const body = (await res.json()) as {
      data: { prices: Record<string, Record<string, { unitAmount: number }>> };
    };
    expect(body.data.prices.pw_1["$rov_monthly"].unitAmount).toBe(4999);
  });

  it("passes the package's stripe price id, not the product identifier", async () => {
    stageOnboardingFunnel();
    const app = await buildApp();
    await app.request("/public/funnels/onboarding");
    expect(resolvePricesForPackages).toHaveBeenCalledWith(
      "proj_1",
      expect.arrayContaining([
        { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
      ]),
    );
  });

  it("serves an empty prices map when the funnel has no paywall pages", async () => {
    funnelRow.value = {
      id: "fnl_2",
      projectId: "proj_2",
      slug: "plain",
      status: "published",
      currentVersionId: "ver_2",
    };
    findVersionById.mockResolvedValue({
      id: "ver_2",
      pagesJson: [{ id: "p1", type: "info" }],
      themeJson: {},
      settingsJson: {},
    });
    const app = await buildApp();
    const res = await app.request("/public/funnels/plain");
    const body = (await res.json()) as { data: { prices: Record<string, unknown> } };
    expect(body.data.prices).toEqual({});
    expect(resolvePricesForPackages).not.toHaveBeenCalled();
  });

  it("does not leak projectId into the public response", async () => {
    stageOnboardingFunnel();
    resolvePricesForPackages.mockResolvedValue({
      $rov_monthly: {
        packageIdentifier: "$rov_monthly",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      },
    });
    const app = await buildApp();
    const res = await app.request("/public/funnels/onboarding");
    const raw = await res.text();
    expect(raw).not.toContain("projectId");
    expect(raw).not.toContain("proj_1");
  });

  it("skips a paywall whose offering has no packages", async () => {
    funnelRow.value = {
      id: "fnl_3",
      projectId: "proj_3",
      slug: "empty-offering",
      status: "published",
      currentVersionId: "ver_3",
    };
    findVersionById.mockResolvedValue({
      id: "ver_3",
      pagesJson: [{ id: "p1", type: "paywall", paywallId: "pw_3" }],
      themeJson: {},
      settingsJson: {},
    });
    findFunnelById.mockResolvedValue({ id: "fnl_3", projectId: "proj_3" });
    findPaywallsByIds.mockResolvedValue([
      {
        id: "pw_3",
        builderConfig: { formatVersion: 2 },
        configFormatVersion: 2,
        offeringId: "off_3",
      },
    ]);
    findOfferingById.mockResolvedValue({
      identifier: "default",
      isDefault: true,
      packages: [],
      metadata: {},
    });
    findProductsByIds.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.request("/public/funnels/empty-offering");
    const body = (await res.json()) as { data: { prices: Record<string, unknown> } };

    expect(resolvePricesForPackages).not.toHaveBeenCalled();
    expect(body.data.prices).not.toHaveProperty("pw_3");
    expect(body.data.prices).toEqual({});
  });

  it("passes a package with no storeIds.stripe through as stripePriceId: null", async () => {
    funnelRow.value = {
      id: "fnl_4",
      projectId: "proj_4",
      slug: "no-stripe-id",
      status: "published",
      currentVersionId: "ver_4",
    };
    findVersionById.mockResolvedValue({
      id: "ver_4",
      pagesJson: [{ id: "p1", type: "paywall", paywallId: "pw_4" }],
      themeJson: {},
      settingsJson: {},
    });
    findFunnelById.mockResolvedValue({ id: "fnl_4", projectId: "proj_4" });
    findPaywallsByIds.mockResolvedValue([
      {
        id: "pw_4",
        builderConfig: { formatVersion: 2 },
        configFormatVersion: 2,
        offeringId: "off_4",
      },
    ]);
    findOfferingById.mockResolvedValue({
      identifier: "default",
      isDefault: true,
      packages: [
        {
          identifier: "$rov_no_stripe",
          productId: "prod_no_stripe",
          order: 0,
          isPromoted: false,
        },
      ],
      metadata: {},
    });
    findProductsByIds.mockResolvedValue([
      {
        id: "prod_no_stripe",
        identifier: "no_stripe_product",
        type: "subscription",
        displayName: "No Stripe",
        accessIds: [],
        isActive: true,
        storeIds: { apple: "apple_id" },
        androidBasePlanId: null,
        androidOfferId: null,
      },
    ]);

    const app = await buildApp();
    await app.request("/public/funnels/no-stripe-id");

    expect(resolvePricesForPackages).toHaveBeenCalledWith(
      "proj_4",
      expect.arrayContaining([
        { packageIdentifier: "$rov_no_stripe", stripePriceId: null },
      ]),
    );
  });
});
