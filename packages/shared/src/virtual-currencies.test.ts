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
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5, referenceId: "txn_1" }).success,
    ).toBe(true);
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: -1, referenceId: "txn_1" }).success,
    ).toBe(false);
  });

  it("rejects a spend with no referenceId", () => {
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5 }).success,
    ).toBe(false);
  });

  it("accepts a spend with referenceId", () => {
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5, referenceId: "txn_1" }).success,
    ).toBe(true);
  });

  it("rejects a spend with empty referenceId", () => {
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5, referenceId: "" }).success,
    ).toBe(false);
  });

  it("rejects a spend with referenceId exceeding 120 chars", () => {
    expect(
      spendVirtualCurrencyRequestSchema.safeParse({ amount: 5, referenceId: "x".repeat(121) }).success,
    ).toBe(false);
  });
});
