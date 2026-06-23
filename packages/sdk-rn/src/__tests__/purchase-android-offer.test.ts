import { describe, it, expect, vi } from "vitest";

const purchaseSpy = vi.fn(async () => ({
  entitlements: [], virtualCurrencies: {}, productId: "premium", storeTransactionId: "t", isDeferred: false,
}));
vi.mock("../core/native", () => ({ getNative: () => ({ purchase: purchaseSpy }) }));

import { purchase } from "../api/purchases";

describe("purchase with Android subscriptionOption", () => {
  it("forwards basePlanId + offerId to native", async () => {
    const product = { id: "premium", type: "subscription" } as any;
    const option = { id: "monthly:trial", basePlanId: "monthly", offerId: "trial" } as any;
    await purchase(product, { subscriptionOption: option });
    expect(purchaseSpy).toHaveBeenCalledWith("premium", "subscription", undefined, "monthly", "trial");
  });
  it("passes undefined offer parts when no option", async () => {
    const product = { id: "premium", type: "subscription" } as any;
    await purchase(product);
    expect(purchaseSpy).toHaveBeenCalledWith("premium", "subscription", undefined, undefined, undefined);
  });
});
