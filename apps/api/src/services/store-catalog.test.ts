import { describe, expect, it, vi } from "vitest";
import { getStoreCatalog, StoreCatalogError } from "./store-catalog";

const raw = [
  { storeId: "pro_monthly", type: "SUBSCRIPTION" as const, name: "Pro Monthly" },
  { storeId: "coins_100", type: "CONSUMABLE" as const, name: "100 Coins" },
];

const baseOverrides = {
  loadApple: async () => ({ bundleId: "com.acme.app", keyId: "k", issuerId: "i", privateKey: "p" }),
  loadGoogle: async () => ({ packageName: "com.acme.app", serviceAccount: { client_email: "e", private_key: "p" } }),
  listAppStore: async () => raw,
  listGooglePlay: async () => raw,
  // one product already imported on ios
  listProducts: async () => [{ storeIds: { ios: "pro_monthly" } }] as any,
};

describe("getStoreCatalog", () => {
  it("marks alreadyImported against existing products", async () => {
    const items = await getStoreCatalog("proj1", "ios", baseOverrides);
    const pro = items.find((i) => i.storeId === "pro_monthly");
    const coins = items.find((i) => i.storeId === "coins_100");
    expect(pro?.alreadyImported).toBe(true);
    expect(coins?.alreadyImported).toBe(false);
  });

  it("throws STORE_NOT_CONFIGURED when apple creds incomplete", async () => {
    await expect(
      getStoreCatalog("proj1", "ios", { ...baseOverrides, loadApple: async () => ({ bundleId: "x" }) as any }),
    ).rejects.toMatchObject({ code: "STORE_NOT_CONFIGURED" });
  });

  it("throws STORE_NOT_CONFIGURED when google creds absent", async () => {
    await expect(
      getStoreCatalog("proj1", "android", { ...baseOverrides, loadGoogle: async () => null }),
    ).rejects.toBeInstanceOf(StoreCatalogError);
  });
});
