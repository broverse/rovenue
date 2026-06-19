import { describe, expect, it } from "vitest";
import {
  createVirtualCurrencyRequestSchema,
  spendVirtualCurrencyRequestSchema,
  grantCreditsRequestSchema,
} from "./dashboard";

describe("virtual currency schemas", () => {
  it("uppercases-validates currency code on create", () => {
    expect(
      createVirtualCurrencyRequestSchema.safeParse({ code: "EMR", name: "Zümrüt" })
        .success,
    ).toBe(true);
    expect(
      createVirtualCurrencyRequestSchema.safeParse({ code: "emr", name: "x" })
        .success,
    ).toBe(false); // must be uppercase
  });

  it("requires currencyId on grant", () => {
    const r = grantCreditsRequestSchema.safeParse({
      subscriberId: "s1",
      amount: 10,
    });
    expect(r.success).toBe(false);
  });

  it("requires positive integer amount on spend", () => {
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5 }).success,
    ).toBe(true);
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: -1 }).success,
    ).toBe(false);
  });
});
