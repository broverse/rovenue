import { describe, expect, it } from "vitest";
import {
  formatAmount,
  stripeMinorUnitExponent,
  toPriceView,
} from "../funnel-runner";
import type { ResolvedFunnelPrice } from "../runner-api";

/** Intl separates the symbol from the number with U+00A0 in many locales. */
const norm = (s: string | null | undefined) =>
  s === null || s === undefined ? null : s.replace(/ /g, " ");

describe("stripeMinorUnitExponent", () => {
  it("scales an ordinary currency by 100", () => {
    expect(stripeMinorUnitExponent("usd")).toBe(2);
    expect(stripeMinorUnitExponent("EUR")).toBe(2);
  });

  it("does not scale a zero-decimal currency", () => {
    expect(stripeMinorUnitExponent("jpy")).toBe(0);
    expect(stripeMinorUnitExponent("KRW")).toBe(0);
  });

  it("scales a three-decimal currency by 1000", () => {
    expect(stripeMinorUnitExponent("kwd")).toBe(3);
    expect(stripeMinorUnitExponent("BHD")).toBe(3);
  });

  it("scales ISK by 100 even though it is written with no decimals", () => {
    // Stripe: "to charge 5 ISK, provide an amount value of 500". Taking
    // the divisor from Intl (which reports 0 fraction digits) would
    // advertise that 5 ISK charge as "ISK 500".
    expect(stripeMinorUnitExponent("isk")).toBe(2);
  });

  it("scales UGX by 100 — Stripe's zero-decimal list is overridden by its own special case", () => {
    expect(stripeMinorUnitExponent("ugx")).toBe(2);
  });
});

describe("formatAmount", () => {
  it("renders a two-decimal currency", () => {
    expect(norm(formatAmount(1999, "usd", "en-US"))).toBe("$19.99");
  });

  it("renders a zero-decimal currency without dividing", () => {
    expect(norm(formatAmount(1200, "jpy", "en-US"))).toBe("¥1,200");
  });

  it("renders a three-decimal currency", () => {
    expect(norm(formatAmount(1500, "kwd", "en-US"))).toBe("KWD 1.500");
  });

  it("renders 500 ISK minor units as the 5 ISK Stripe actually charges", () => {
    expect(norm(formatAmount(500, "isk", "en-US"))).toBe("ISK 5");
  });

  it("renders 500 UGX minor units as 5 UGX", () => {
    expect(norm(formatAmount(500, "ugx", "en-US"))).toBe("UGX 5");
  });

  it("answers null rather than throwing on a currency Intl rejects", () => {
    expect(formatAmount(1999, "zzzz", "en-US")).toBeNull();
  });

  it("answers null rather than throwing on a malformed locale", () => {
    // An unvalidated `locales` cast is what puts a value like this in
    // our hands, and this runs during render.
    expect(formatAmount(1999, "usd", "en_US")).toBeNull();
  });
});

describe("toPriceView", () => {
  const offering = {
    identifier: "default",
    isDefault: true,
    metadata: null,
    packages: [
      { packageIdentifier: "monthly", displayName: "Monthly" },
      { packageIdentifier: "yearly", displayName: "Yearly" },
    ],
  };

  const monthly: ResolvedFunnelPrice = {
    packageIdentifier: "monthly",
    priceId: "price_1",
    unitAmount: 999,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    trialDays: null,
  };

  it("builds price / pricePerPeriod from the server's own amounts", () => {
    const view = toPriceView(offering, { monthly }, "en-US");
    expect(norm(view?.monthly.price)).toBe("$9.99");
    expect(norm(view?.monthly.pricePerPeriod)).toBe("$9.99/month");
    expect(view?.monthly.packageName).toBe("Monthly");
  });

  it("drops only the unformattable package instead of taking the page down", () => {
    const view = toPriceView(
      offering,
      {
        monthly,
        yearly: { ...monthly, packageIdentifier: "yearly", currency: "zzzz" },
      },
      "en-US",
    );
    expect(view && Object.keys(view)).toEqual(["monthly"]);
  });

  it("survives a malformed locale with every price degraded, not an exception", () => {
    expect(() => toPriceView(offering, { monthly }, "en_US")).not.toThrow();
    expect(toPriceView(offering, { monthly }, "en_US")).toEqual({});
  });
});
