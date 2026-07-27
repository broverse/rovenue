import { describe, expect, it, vi } from "vitest";
import { listAppStoreCatalog, listAppStoreSubscriptionPrices } from "./app-store-connect";

// A throwaway PKCS8 EC P-256 key for signing in tests (not a real secret).
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const config = {
  keyId: "ABC1234567",
  issuerId: "11111111-2222-3333-4444-555555555555",
  privateKey: TEST_P8,
  bundleId: "com.acme.app",
  appAppleId: 1234567890,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listAppStoreCatalog", () => {
  it("maps IAP types and subscriptions, no pagination", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/inAppPurchasesV2")) {
        return jsonResponse({
          data: [
            { attributes: { productId: "coins_100", name: "100 Coins", inAppPurchaseType: "CONSUMABLE" } },
            { attributes: { productId: "remove_ads", name: "Remove Ads", inAppPurchaseType: "NON_CONSUMABLE" } },
          ],
          links: {},
        });
      }
      // New shape: first list groups, then list subscriptions per group
      if (u.includes("/subscriptionGroups/grp1/subscriptions")) {
        return jsonResponse({
          data: [
            { attributes: { productId: "pro_monthly", name: "Pro Monthly" } },
          ],
          links: {},
        });
      }
      if (u.includes("/subscriptionGroups")) {
        return jsonResponse({
          data: [{ id: "grp1" }],
          links: {},
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const items = await listAppStoreCatalog(config, fetchImpl as unknown as typeof fetch);

    expect(items).toEqual(
      expect.arrayContaining([
        { storeId: "coins_100", type: "CONSUMABLE", name: "100 Coins" },
        { storeId: "remove_ads", type: "NON_CONSUMABLE", name: "Remove Ads" },
        { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly" },
      ]),
    );
    expect(items).toHaveLength(3);
  });

  it("throws StoreApiError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ detail: "Forbidden" }] }, false, 403));
    await expect(
      listAppStoreCatalog(config, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/403|Forbidden/);
  });

  it("paginates subscriptions and IAPs across multiple pages", async () => {
    const BASE = "https://api.appstoreconnect.apple.com";
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);

      // IAP page 1 — has next
      if (u === `${BASE}/v1/apps/1234567890/inAppPurchasesV2?limit=200`) {
        return jsonResponse({
          data: [
            { attributes: { productId: "coins_100", name: "100 Coins", inAppPurchaseType: "CONSUMABLE" } },
          ],
          links: { next: `${BASE}/v1/apps/1234567890/inAppPurchasesV2?limit=200&cursor=page2` },
        });
      }
      // IAP page 2 — no next
      if (u === `${BASE}/v1/apps/1234567890/inAppPurchasesV2?limit=200&cursor=page2`) {
        return jsonResponse({
          data: [
            { attributes: { productId: "remove_ads", name: "Remove Ads", inAppPurchaseType: "NON_CONSUMABLE" } },
          ],
          links: {},
        });
      }

      // Subscription groups (single page, one group)
      if (u === `${BASE}/v1/apps/1234567890/subscriptionGroups?limit=200`) {
        return jsonResponse({
          data: [{ id: "grp1" }],
          links: {},
        });
      }

      // Subscriptions for grp1, page 1 — has next
      if (u === `${BASE}/v1/subscriptionGroups/grp1/subscriptions?limit=200`) {
        return jsonResponse({
          data: [
            { attributes: { productId: "pro_monthly", name: "Pro Monthly" } },
          ],
          links: { next: `${BASE}/v1/subscriptionGroups/grp1/subscriptions?limit=200&cursor=page2` },
        });
      }
      // Subscriptions for grp1, page 2 — no next
      if (u === `${BASE}/v1/subscriptionGroups/grp1/subscriptions?limit=200&cursor=page2`) {
        return jsonResponse({
          data: [
            { attributes: { productId: "pro_annual", name: "Pro Annual" } },
          ],
          links: {},
        });
      }

      throw new Error(`unexpected url ${u}`);
    });

    const items = await listAppStoreCatalog(config, fetchImpl as unknown as typeof fetch);

    expect(items).toEqual(
      expect.arrayContaining([
        { storeId: "coins_100", type: "CONSUMABLE", name: "100 Coins" },
        { storeId: "remove_ads", type: "NON_CONSUMABLE", name: "Remove Ads" },
        { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly" },
        { storeId: "pro_annual", type: "SUBSCRIPTION", name: "Pro Annual" },
      ]),
    );
    expect(items).toHaveLength(4);
  });
});

describe("listAppStoreSubscriptionPrices", () => {
  /** Builds the shared groups→subscriptions walk fetchImpl handlers, keyed by URL fragment. */
  function withGroupWalk(
    subs: Array<{ id: string; productId: string; subscriptionPeriod: string }>,
    extra: Record<string, (url: string) => Response>,
  ) {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/subscriptionGroups/grp1/subscriptions")) {
        return jsonResponse({
          data: subs.map((s) => ({
            id: s.id,
            attributes: { productId: s.productId, subscriptionPeriod: s.subscriptionPeriod },
          })),
          links: {},
        });
      }
      if (u.includes("/subscriptionGroups")) {
        return jsonResponse({ data: [{ id: "grp1" }], links: {} });
      }
      for (const [frag, handler] of Object.entries(extra)) {
        if (u.includes(frag)) return handler(u);
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
  }

  it("(a) happy path: maps price, period and trial", async () => {
    const fetchImpl = withGroupWalk(
      [{ id: "sub_pro_monthly", productId: "pro_monthly", subscriptionPeriod: "ONE_MONTH" }],
      {
        "/v1/subscriptions/sub_pro_monthly/prices": () =>
          jsonResponse({
            data: [
              {
                id: "price1",
                attributes: { startDate: null },
                relationships: { subscriptionPricePoint: { data: { id: "pp1" } } },
              },
            ],
            included: [{ id: "pp1", attributes: { customerPrice: "9.99" } }],
            links: {},
          }),
        "/v1/subscriptions/sub_pro_monthly/introductoryOffers": () =>
          jsonResponse({
            data: [{ attributes: { offerMode: "FREE_TRIAL", duration: "P1W", numberOfPeriods: 1 } }],
            links: {},
          }),
      },
    );

    const result = await listAppStoreSubscriptionPrices(config, ["pro_monthly"], fetchImpl);

    expect(result.get("pro_monthly")).toEqual({
      productId: "pro_monthly",
      period: "P1M",
      amountMinor: 999,
      currency: "USD",
      trialDays: 7,
    });
  });

  it("(b) a future-dated price is ignored in favour of the current one", async () => {
    const fetchImpl = withGroupWalk(
      [{ id: "sub_pro_monthly", productId: "pro_monthly", subscriptionPeriod: "ONE_MONTH" }],
      {
        "/v1/subscriptions/sub_pro_monthly/prices": () =>
          jsonResponse({
            data: [
              {
                id: "future",
                attributes: { startDate: "2099-01-01" },
                relationships: { subscriptionPricePoint: { data: { id: "pp_future" } } },
              },
              {
                id: "current",
                attributes: { startDate: null },
                relationships: { subscriptionPricePoint: { data: { id: "pp_current" } } },
              },
            ],
            included: [
              { id: "pp_future", attributes: { customerPrice: "99.99" } },
              { id: "pp_current", attributes: { customerPrice: "9.99" } },
            ],
            links: {},
          }),
        "/v1/subscriptions/sub_pro_monthly/introductoryOffers": () =>
          jsonResponse({ data: [], links: {} }),
      },
    );

    const result = await listAppStoreSubscriptionPrices(config, ["pro_monthly"], fetchImpl);

    expect(result.get("pro_monthly")).toMatchObject({ amountMinor: 999, currency: "USD" });
  });

  it("(c) offerMode PAY_AS_YOU_GO yields trialDays: null", async () => {
    const fetchImpl = withGroupWalk(
      [{ id: "sub_pro_monthly", productId: "pro_monthly", subscriptionPeriod: "ONE_MONTH" }],
      {
        "/v1/subscriptions/sub_pro_monthly/prices": () =>
          jsonResponse({
            data: [
              {
                id: "price1",
                attributes: { startDate: null },
                relationships: { subscriptionPricePoint: { data: { id: "pp1" } } },
              },
            ],
            included: [{ id: "pp1", attributes: { customerPrice: "9.99" } }],
            links: {},
          }),
        "/v1/subscriptions/sub_pro_monthly/introductoryOffers": () =>
          jsonResponse({
            data: [{ attributes: { offerMode: "PAY_AS_YOU_GO", duration: "P1M", numberOfPeriods: 1 } }],
            links: {},
          }),
      },
    );

    const result = await listAppStoreSubscriptionPrices(config, ["pro_monthly"], fetchImpl);

    expect(result.get("pro_monthly")).toMatchObject({ trialDays: null });
  });

  it("(d) an unknown subscriptionPeriod maps to period: null", async () => {
    const fetchImpl = withGroupWalk(
      [{ id: "sub_weird", productId: "weird_product", subscriptionPeriod: "UNKNOWN_PERIOD" }],
      {
        "/v1/subscriptions/sub_weird/prices": () =>
          jsonResponse({
            data: [
              {
                id: "price1",
                attributes: { startDate: null },
                relationships: { subscriptionPricePoint: { data: { id: "pp1" } } },
              },
            ],
            included: [{ id: "pp1", attributes: { customerPrice: "4.99" } }],
            links: {},
          }),
        "/v1/subscriptions/sub_weird/introductoryOffers": () => jsonResponse({ data: [], links: {} }),
      },
    );

    const result = await listAppStoreSubscriptionPrices(config, ["weird_product"], fetchImpl);

    expect(result.get("weird_product")).toEqual({
      productId: "weird_product",
      period: null,
      amountMinor: 499,
      currency: "USD",
      trialDays: null,
    });
  });

  it("(e) a prices 500 for one subscription omits only that product", async () => {
    const fetchImpl = withGroupWalk(
      [
        { id: "sub_ok", productId: "ok_product", subscriptionPeriod: "ONE_MONTH" },
        { id: "sub_bad", productId: "bad_product", subscriptionPeriod: "ONE_MONTH" },
      ],
      {
        "/v1/subscriptions/sub_ok/prices": () =>
          jsonResponse({
            data: [
              {
                id: "price1",
                attributes: { startDate: null },
                relationships: { subscriptionPricePoint: { data: { id: "pp1" } } },
              },
            ],
            included: [{ id: "pp1", attributes: { customerPrice: "9.99" } }],
            links: {},
          }),
        "/v1/subscriptions/sub_ok/introductoryOffers": () => jsonResponse({ data: [], links: {} }),
        "/v1/subscriptions/sub_bad/prices": () =>
          jsonResponse({ errors: [{ detail: "Internal Server Error" }] }, false, 500),
        "/v1/subscriptions/sub_bad/introductoryOffers": () =>
          jsonResponse({ errors: [{ detail: "Internal Server Error" }] }, false, 500),
      },
    );

    const result = await listAppStoreSubscriptionPrices(
      config,
      ["ok_product", "bad_product"],
      fetchImpl,
    );

    expect(result.has("ok_product")).toBe(true);
    expect(result.get("ok_product")).toMatchObject({ amountMinor: 999 });
    expect(result.has("bad_product")).toBe(false);
  });
});
