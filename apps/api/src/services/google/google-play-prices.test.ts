import { describe, expect, it, vi } from "vitest";
import { listGooglePlaySubscriptionPrices } from "./google-play-prices";

const SERVICE_ACCOUNT = { client_email: "x@y.iam.gserviceaccount.com", private_key: "k" };
const deps = (pages: Record<string, unknown>) => ({
  getToken: vi.fn().mockResolvedValue("tok"),
  fetchImpl: vi.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = Object.entries(pages).find(([frag]) => u.includes(frag));
    if (!hit) return new Response("{}", { status: 404, statusText: "nf" });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as unknown as typeof fetch,
});

const SUBS_PAGE = {
  subscriptions: [
    {
      productId: "pro_monthly",
      basePlans: [
        {
          basePlanId: "monthly",
          autoRenewingBasePlanType: { billingPeriodDuration: "P1M" },
          regionalConfigs: [
            { regionCode: "DE", price: { currencyCode: "EUR", units: "8", nanos: 990000000 } },
            { regionCode: "US", price: { currencyCode: "USD", units: "9", nanos: 990000000 } },
          ],
        },
      ],
    },
  ],
};

it("prices the wanted pair from the US regional config", async () => {
  const d = deps({ "/subscriptions?": SUBS_PAGE, "/offers": { subscriptionOffers: [] } });
  const out = await listGooglePlaySubscriptionPrices(
    {
      packageName: "app.example",
      serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_monthly", basePlanId: "monthly" }],
    },
    d,
  );
  expect(out.get("pro_monthly:monthly")).toMatchObject({
    period: "P1M",
    amountMinor: 999,
    currency: "USD",
    trialDays: null,
  });
});

it("falls back to otherRegionsConfig when no US regional config exists", async () => {
  const page = {
    subscriptions: [
      {
        productId: "pro_annual",
        basePlans: [
          {
            basePlanId: "annual",
            autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" },
            otherRegionsConfig: { currencyCode: "USD", units: "59", nanos: 990000000 },
          },
        ],
      },
    ],
  };
  const d = deps({ "/subscriptions?": page, "/offers": { subscriptionOffers: [] } });
  const out = await listGooglePlaySubscriptionPrices(
    {
      packageName: "app.example",
      serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_annual", basePlanId: "annual" }],
    },
    d,
  );
  expect(out.get("pro_annual:annual")).toMatchObject({
    period: "P1Y",
    amountMinor: 5999,
    currency: "USD",
    trialDays: null,
  });
});

it("maps a free offer phase to trialDays", async () => {
  const offersPage = {
    subscriptionOffers: [
      {
        phases: [
          {
            duration: "P1W",
            regionalConfigs: [{ regionCode: "US", free: {} }],
          },
        ],
      },
    ],
  };
  const d = deps({ "/subscriptions?": SUBS_PAGE, "/offers": offersPage });
  const out = await listGooglePlaySubscriptionPrices(
    {
      packageName: "app.example",
      serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_monthly", basePlanId: "monthly" }],
    },
    d,
  );
  expect(out.get("pro_monthly:monthly")).toMatchObject({
    period: "P1M",
    amountMinor: 999,
    currency: "USD",
    trialDays: 7,
  });
});

it("a failing offers call degrades to trialDays null, not an error", async () => {
  // No "/offers" fragment registered → gpGet-style fetch returns 404 for the offers URL.
  const d = deps({ "/subscriptions?": SUBS_PAGE });
  const out = await listGooglePlaySubscriptionPrices(
    {
      packageName: "app.example",
      serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_monthly", basePlanId: "monthly" }],
    },
    d,
  );
  expect(out.get("pro_monthly:monthly")).toMatchObject({
    period: "P1M",
    amountMinor: 999,
    currency: "USD",
    trialDays: null,
  });
});

it("omits a wanted pair whose basePlan is missing", async () => {
  const d = deps({ "/subscriptions?": SUBS_PAGE, "/offers": { subscriptionOffers: [] } });
  const out = await listGooglePlaySubscriptionPrices(
    {
      packageName: "app.example",
      serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_monthly", basePlanId: "annual" }],
    },
    d,
  );
  expect(out.has("pro_monthly:annual")).toBe(false);
});
