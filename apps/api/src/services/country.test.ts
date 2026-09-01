import { describe, expect, it } from "vitest";
import { normalizeAlpha2Country } from "./country";

describe("normalizeAlpha2Country", () => {
  it("passes through a recognised alpha-2 code, upper-cased", () => {
    expect(normalizeAlpha2Country("US")).toBe("US");
    expect(normalizeAlpha2Country("GB")).toBe("GB");
    expect(normalizeAlpha2Country("de")).toBe("DE");
  });

  it("is case-insensitive on input and always upper-cases the output", () => {
    expect(normalizeAlpha2Country("us")).toBe("US");
  });

  it("fails closed to null on an unrecognised code — never the raw value", () => {
    expect(normalizeAlpha2Country("ZZ")).toBeNull();
    // Never accepts an alpha-3 code either: Google/Stripe are documented
    // as already alpha-2, so a 3-letter value here is a store surprising
    // us, not something to coerce.
    expect(normalizeAlpha2Country("USA")).toBeNull();
  });

  it("fails closed to null on missing, empty, or blank input", () => {
    expect(normalizeAlpha2Country(undefined)).toBeNull();
    expect(normalizeAlpha2Country(null)).toBeNull();
    expect(normalizeAlpha2Country("")).toBeNull();
  });
});
