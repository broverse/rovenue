import { beforeEach, describe, expect, test, vi } from "vitest";

const { drizzleMock, addCreditsMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {} as unknown,
    productCurrencyGrantRepo: {
      listProductGrantsForTrigger: vi.fn(async () => [] as unknown[]),
    },
  },
  addCreditsMock: vi.fn(async () => ({ id: "cl_1" })),
}));

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));
vi.mock("./credit-engine", () => ({ addCredits: addCreditsMock }));

import { grantProductCurrencies } from "./purchase-credits";

const SUBSCRIBER_ID = "sub_1";
const PRODUCT_ID = "prd_1";
const REFERENCE_ID = "rev_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("grantProductCurrencies", () => {
  test("grants each returned row with the renewal reference type", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [
        { id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 500, grantOn: "RENEWAL" },
        { id: "g2", productId: PRODUCT_ID, currencyId: "cur_b", amount: 10, grantOn: "BOTH" },
      ],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).toHaveBeenCalledTimes(2);
    expect(addCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: SUBSCRIBER_ID,
        currencyId: "cur_a",
        amount: 500,
        referenceType: "renewal",
        referenceId: REFERENCE_ID,
        dedupeOnReference: true,
      }),
    );
  });

  test("uses the purchase reference type on the purchase trigger", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [{ id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 5, grantOn: "PURCHASE" }],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "coins_100",
      trigger: "PURCHASE",
    });

    // A distinct referenceType is what stops a consumable purchase and a
    // renewal that share a reference id from collapsing into one another.
    expect(addCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceType: "purchase" }),
    );
  });

  test("writes nothing when the product has no matching grant rows", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue([]);

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).not.toHaveBeenCalled();
  });

  test("skips non-positive amounts", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [{ id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 0, grantOn: "RENEWAL" }],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).not.toHaveBeenCalled();
  });
});
