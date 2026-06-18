import { describe, expect, it, vi } from "vitest";
import { listAppStoreCatalog } from "./app-store-connect";

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
      if (u.includes("/subscriptionGroups")) {
        return jsonResponse({
          data: [{ id: "grp1" }],
          included: [
            { type: "subscriptions", attributes: { productId: "pro_monthly", name: "Pro Monthly" } },
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
});
