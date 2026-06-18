import { describe, expect, it, vi } from "vitest";
import { listGooglePlayCatalog } from "./google-play-catalog";

const serviceAccount = {
  client_email: "svc@proj.iam.gserviceaccount.com",
  private_key: "irrelevant — token is mocked",
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

describe("listGooglePlayCatalog", () => {
  it("maps subscriptions and managed products", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/subscriptions")) {
        return jsonResponse({
          subscriptions: [
            { productId: "pro_monthly", listings: [{ title: "Pro Monthly" }] },
          ],
        });
      }
      if (u.includes("/inappproducts")) {
        return jsonResponse({
          inappproduct: [
            { sku: "coins_100", defaultLanguage: "en-US", listings: { "en-US": { title: "100 Coins" } } },
          ],
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const items = await listGooglePlayCatalog(
      { packageName: "com.acme.app", serviceAccount },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" },
    );

    expect(items).toEqual(
      expect.arrayContaining([
        { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly" },
        { storeId: "coins_100", type: "NON_CONSUMABLE", name: "100 Coins" },
      ]),
    );
    expect(items).toHaveLength(2);
  });

  it("throws StoreApiError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "denied" } }, false, 401));
    await expect(
      listGooglePlayCatalog(
        { packageName: "com.acme.app", serviceAccount },
        { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" },
      ),
    ).rejects.toThrow(/401|denied/);
  });
});
