import { describe, expect, it } from "vitest";
import {
  ALPHA2_COUNTRY_CODES,
  appleStorefrontToCountry,
} from "./apple-country";

/**
 * ISO 3166-1 currently has 249 officially assigned entries. The table is
 * the single source of truth for BOTH directions — Apple's alpha-3
 * storefront conversion and, via `ALPHA2_COUNTRY_CODES`, the validity
 * check `../country.ts` applies to Google's and Stripe's already-alpha-2
 * values. Fail-closed is the settled ruling, so an entry missing from the
 * table is a real country whose revenue is silently dropped.
 */
const ISO_3166_1_ASSIGNED_COUNT = 249;

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

  // The table shipped with 222 of the 249 entries. Fail-closed turned each
  // gap into dropped revenue: a Stripe customer billed in Curaçao or
  // Sint Maarten, an Apple storefront in the Northern Mariana Islands,
  // American Samoa, Mayotte or Åland — all real, all judged unreal.
  it("covers dependencies and outlying territories that are genuine store countries", () => {
    expect(appleStorefrontToCountry("CUW")).toBe("CW");
    expect(appleStorefrontToCountry("SXM")).toBe("SX");
    expect(appleStorefrontToCountry("MNP")).toBe("MP");
    expect(appleStorefrontToCountry("ASM")).toBe("AS");
    expect(appleStorefrontToCountry("MYT")).toBe("YT");
    expect(appleStorefrontToCountry("ALA")).toBe("AX");
  });
});

describe("ALPHA2_COUNTRY_CODES", () => {
  it("is a complete ISO 3166-1 enumeration", () => {
    expect(ALPHA2_COUNTRY_CODES.size).toBe(ISO_3166_1_ASSIGNED_COUNT);
  });

  it("accepts the alpha-2 codes Google and Stripe can genuinely report", () => {
    for (const code of ["CW", "SX", "MP", "AS", "YT", "AX", "BQ", "MF"]) {
      expect(
        ALPHA2_COUNTRY_CODES.has(code),
        `${code} is a real ISO 3166-1 code; dropping it loses real revenue`,
      ).toBe(true);
    }
  });
});
