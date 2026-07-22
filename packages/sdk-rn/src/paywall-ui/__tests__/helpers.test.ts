import { describe, expect, it } from "vitest";
import type { Offering, Period, StoreProduct } from "../../types";
import { packageView } from "../helpers";

// Mirrors PaywallViewModelHelpersTests.swift / PaywallHelpersTest.kt's
// packageView test tables — self-consistent formatting expectations
// (computed with the SAME `Intl.NumberFormat` API the implementation
// uses, not a hardcoded string) and the cross-platform-pinned "33%"/"0%"
// relativeDiscount parity values.

function period(unit: Period["unit"]): Period {
  return { value: 1, unit, iso8601: "P1?" };
}

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: "com.x.pro",
    type: "subscription",
    productCategory: "subscription",
    displayName: "Pro",
    description: null,
    priceString: "$9.99",
    price: 9.99,
    currencyCode: null,
    subscriptionPeriod: period("month"),
    subscriptionGroupIdentifier: null,
    isFamilyShareable: false,
    introPrice: null,
    discounts: [],
    isEligibleForIntroOffer: null,
    subscriptionOptions: null,
    defaultOption: null,
    pricePerWeek: null,
    pricePerMonth: null,
    pricePerYear: null,
    pricePerWeekString: null,
    pricePerMonthString: null,
    pricePerYearString: null,
    ...overrides,
  } as StoreProduct;
}

function offeringOf(...packages: Array<{ identifier: string; product: StoreProduct }>): Offering {
  return {
    identifier: "default",
    isDefault: true,
    packages: packages.map((p) => ({ identifier: p.identifier, packageType: "monthly", product: p.product })),
  };
}

describe("packageView — required fields (normative, unchanged by D3)", () => {
  it("maps subscription periods to their unit label", () => {
    expect(packageView(product(), "Pro Monthly")).toMatchObject({
      packageName: "Pro Monthly",
      price: "$9.99",
      pricePerPeriod: "$9.99/month",
      period: "month",
    });
    expect(packageView(product({ subscriptionPeriod: period("year") }), "Pro Annual").period).toBe("year");
    expect(packageView(product({ subscriptionPeriod: period("week") }), "W").period).toBe("week");
    expect(packageView(product({ subscriptionPeriod: period("day") }), "D").period).toBe("day");
  });

  it("non-subscription product: empty period, price alone as pricePerPeriod", () => {
    const view = packageView(product({ subscriptionPeriod: null }), "Lifetime");
    expect(view.period).toBe("");
    expect(view.pricePerPeriod).toBe("$9.99");
  });

  it("null product: all required fields empty besides packageName", () => {
    const view = packageView(null, "Ghost");
    expect(view).toMatchObject({ packageName: "Ghost", price: "", pricePerPeriod: "", period: "" });
  });
});

describe("packageView — Phase D3 optional fields", () => {
  it("pricePerWeek/Month/Year pass through verbatim from the product's own strings", () => {
    const p = product({
      subscriptionPeriod: period("year"),
      priceString: "$39.99",
      pricePerWeekString: "$0.77",
      pricePerMonthString: "$3.33",
      pricePerYearString: "$39.99",
    });
    const view = packageView(p, "Annual");
    expect(view.pricePerWeek).toBe("$0.77");
    expect(view.pricePerMonth).toBe("$3.33");
    expect(view.pricePerYear).toBe("$39.99");
  });

  it("pricePerDay derives from numeric pricePerWeek/7, formatted en-US currency", () => {
    const p = product({ priceString: "$0.77", subscriptionPeriod: period("week"), currencyCode: "USD", pricePerWeek: 0.77 });
    const view = packageView(p, "Weekly");
    const expected = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(0.77 / 7);
    expect(view.pricePerDay).toBe(expected);
  });

  it("pricePerDay is undefined without a numeric pricePerWeek", () => {
    const p = product({ priceString: "$0.77", subscriptionPeriod: period("week"), currencyCode: "USD" });
    expect(packageView(p, "Weekly").pricePerDay).toBeUndefined();
  });

  it("pricePerDay is undefined without a currencyCode", () => {
    const p = product({ priceString: "$0.77", subscriptionPeriod: period("week"), pricePerWeek: 0.77 });
    expect(packageView(p, "Weekly").pricePerDay).toBeUndefined();
  });

  it("introPrice/introPeriod come from the product's introPrice", () => {
    const p = product({
      priceString: "$39.99",
      subscriptionPeriod: period("year"),
      introPrice: {
        price: 0.99,
        priceString: "$0.99",
        currencyCode: "USD",
        period: period("week"),
        cycles: 1,
        paymentMode: "freeTrial",
      },
    });
    const view = packageView(p, "Annual");
    expect(view.introPrice).toBe("$0.99");
    expect(view.introPeriod).toBe("week");
  });

  it("introPrice/introPeriod are undefined without an intro offer", () => {
    const p = product({ priceString: "$39.99", subscriptionPeriod: period("year") });
    const view = packageView(p, "Annual");
    expect(view.introPrice).toBeUndefined();
    expect(view.introPeriod).toBeUndefined();
  });

  it("relativeDiscount is undefined without an offering", () => {
    const p = product({ priceString: "$39.99", subscriptionPeriod: period("year"), pricePerYear: 39.99 });
    expect(packageView(p, "Annual", null).relativeDiscount).toBeUndefined();
    expect(packageView(p, "Annual").relativeDiscount).toBeUndefined();
  });

  it("relativeDiscount is undefined with fewer than two comparable packages", () => {
    const annual = product({ priceString: "$39.99", subscriptionPeriod: period("year"), pricePerYear: 39.99 });
    const monthlyNoNumericPrice = product({ priceString: "$4.99", subscriptionPeriod: period("month") });
    const offering = offeringOf({ identifier: "annual", product: annual }, { identifier: "monthly", product: monthlyNoNumericPrice });
    expect(packageView(annual, "Annual", offering).relativeDiscount).toBeUndefined();
  });

  it("relativeDiscount computed across comparable offering packages, matches Swift/Kotlin parity values", () => {
    // Annual is the cheapest per-year; monthly ($4.99*12=$59.88/yr equivalent)
    // is the most expensive -> annual's discount vs. the max.
    const annual = product({ priceString: "$39.99", subscriptionPeriod: period("year"), pricePerYear: 39.99 });
    const monthly = product({ priceString: "$4.99", subscriptionPeriod: period("month"), pricePerYear: 59.88 });
    const offering = offeringOf({ identifier: "annual", product: annual }, { identifier: "monthly", product: monthly });

    // round((1 - 39.99/59.88) * 100) = round(33.22...) = 33
    expect(packageView(annual, "Annual", offering).relativeDiscount).toBe("33%");
    // The max-priced package has 0% discount relative to itself.
    expect(packageView(monthly, "Monthly", offering).relativeDiscount).toBe("0%");
  });

  it("relativeDiscount is undefined for a product with no numeric pricePerYear", () => {
    const annual = product({ priceString: "$39.99", subscriptionPeriod: period("year"), pricePerYear: 39.99 });
    const monthly = product({ priceString: "$4.99", subscriptionPeriod: period("month"), pricePerYear: 59.88 });
    const lifetime = product({
      priceString: "$99.99",
      subscriptionPeriod: null,
      productCategory: "nonSubscription",
      type: "non_consumable",
    });
    const offering = offeringOf(
      { identifier: "annual", product: annual },
      { identifier: "monthly", product: monthly },
      { identifier: "lifetime", product: lifetime },
    );
    expect(packageView(lifetime, "Lifetime", offering).relativeDiscount).toBeUndefined();
  });
});
