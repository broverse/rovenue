import { describe, expect, it } from "vitest";
import { ProductType } from "@rovenue/db";
import { productType as productTypeEnum } from "@rovenue/db";
import { oneTimeRevenueTypeFor } from "./one-time-type";

describe("oneTimeRevenueTypeFor", () => {
  it("returns null for a subscription so the caller keeps its own classification", () => {
    // Returning null rather than echoing INITIAL/RENEWAL is what makes it
    // impossible for this function to change subscription behaviour.
    expect(oneTimeRevenueTypeFor(ProductType.SUBSCRIPTION)).toBeNull();
  });

  it("types a consumable as a credit purchase", () => {
    expect(oneTimeRevenueTypeFor(ProductType.CONSUMABLE)).toBe("CREDIT_PURCHASE");
  });

  it("types a non-consumable as a non-renewing purchase", () => {
    expect(oneTimeRevenueTypeFor(ProductType.NON_CONSUMABLE)).toBe("NON_RENEWING_PURCHASE");
  });

  it("has an answer for every ProductType", () => {
    // Falsifies "the map is total" against the enum itself rather than
    // against a hand-copied list that could drift with it.
    for (const t of productTypeEnum.enumValues) {
      expect(() => oneTimeRevenueTypeFor(t)).not.toThrow();
    }
  });
});
