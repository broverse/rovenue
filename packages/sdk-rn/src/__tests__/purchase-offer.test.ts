import { describe, it, expect, vi } from "vitest";

const purchaseSpy = vi.fn(async () => ({
  entitlements: [], virtualCurrencies: {}, productId: "premium_monthly", storeTransactionId: "t", isDeferred: false,
}));
vi.mock("../core/native", () => ({ getNative: () => ({ purchase: purchaseSpy }) }));

import { purchase } from "../api/purchases";

describe("purchase with promotional offer", () => {
  it("forwards promotionalOfferId to native", async () => {
    const product = { id: "premium_monthly", type: "subscription" } as any;
    await purchase(product, { promotionalOfferId: "winback10" });
    expect(purchaseSpy).toHaveBeenCalledWith("premium_monthly", "subscription", "winback10");
  });
  it("passes undefined when no offer", async () => {
    const product = { id: "premium_monthly", type: "subscription" } as any;
    await purchase(product);
    expect(purchaseSpy).toHaveBeenCalledWith("premium_monthly", "subscription", undefined);
  });
});
