import { describe, expect, it } from "vitest";
import { appleStorefrontToCountry } from "./apple-country";

describe("appleStorefrontToCountry", () => {
  it("normalises Apple's alpha-3 storefront to the house alpha-2 format", () => {
    expect(appleStorefrontToCountry("USA")).toBe("US");
    expect(appleStorefrontToCountry("GBR")).toBe("GB");
    expect(appleStorefrontToCountry("DEU")).toBe("DE");
  });

  it("is case-insensitive on input and always upper-cases the output", () => {
    expect(appleStorefrontToCountry("usa")).toBe("US");
  });

  it("fails closed to null on an unrecognised code — never the raw value", () => {
    expect(appleStorefrontToCountry("ZZZ")).toBeNull();
  });

  it("fails closed to null on missing, empty, or blank input", () => {
    expect(appleStorefrontToCountry(undefined)).toBeNull();
    expect(appleStorefrontToCountry(null)).toBeNull();
    expect(appleStorefrontToCountry("")).toBeNull();
  });
});
