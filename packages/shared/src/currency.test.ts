import { describe, expect, it } from "vitest";
import { decimalToMinorUnits, stripeMinorUnitExponent } from "./currency";

describe("stripeMinorUnitExponent", () => {
  it("returns 0 for zero-decimal currencies", () => {
    expect(stripeMinorUnitExponent("JPY")).toBe(0);
    expect(stripeMinorUnitExponent("krw")).toBe(0);
  });
  it("returns 3 for three-decimal currencies", () => {
    expect(stripeMinorUnitExponent("BHD")).toBe(3);
  });
  it("returns 2 by default — including Stripe's special-cased UGX and ISK", () => {
    expect(stripeMinorUnitExponent("USD")).toBe(2);
    expect(stripeMinorUnitExponent("UGX")).toBe(2);
    expect(stripeMinorUnitExponent("ISK")).toBe(2);
  });
});

describe("decimalToMinorUnits", () => {
  it("scales by the currency exponent and rounds to an integer", () => {
    expect(decimalToMinorUnits(9.99, "USD")).toBe(999);
    expect(decimalToMinorUnits(500, "JPY")).toBe(500);
    expect(decimalToMinorUnits(1.234, "BHD")).toBe(1234);
  });
  it("rounds float artifacts instead of truncating", () => {
    expect(decimalToMinorUnits(0.29, "USD")).toBe(29); // 0.29*100 === 28.999…
  });
});
