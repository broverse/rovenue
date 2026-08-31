import { describe, expect, it } from "vitest";
import { validateMapping } from "../mapping";

describe("validateMapping", () => {
  it("blocks a mapping that is missing a required field", () => {
    const res = validateMapping({ some_col: "subscriberExternalId" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missingRequired).toContain("productIdentifier");
    }
  });

  it("never maps two source columns onto the same canonical field", () => {
    const res = validateMapping({ a: "productIdentifier", b: "productIdentifier" });
    expect(res.ok).toBe(false);
  });

  it("accepts a mapping that covers every required field with no duplicates", () => {
    const res = validateMapping({
      subscriber_id: "subscriberExternalId",
      store_col: "store",
      product_col: "productIdentifier",
      date_col: "purchaseDate",
    });
    expect(res.ok).toBe(true);
  });
});
