import { describe, expect, it } from "vitest";
import type { DashboardOfferingRow } from "@rovenue/shared";
import {
  buildEligibilityMap,
  computeSelectionRect,
  placeholderPriceView,
  toRendererOffering,
} from "../canvas-helpers";

function offeringFixture(): DashboardOfferingRow {
  return {
    id: "off_1",
    identifier: "default",
    isDefault: true,
    packages: [
      { identifier: "$rov_monthly", productId: "prod_month", order: 0, isPromoted: false },
      { identifier: "$rov_annual", productId: "prod_year", order: 1, isPromoted: true },
      { identifier: "$rov_weekly", productId: "prod_missing", order: 2, isPromoted: false },
    ],
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("toRendererOffering", () => {
  it("returns null when there's no offering", () => {
    expect(toRendererOffering(null, new Map())).toBeNull();
    expect(toRendererOffering(undefined, new Map())).toBeNull();
  });

  it("maps package identifier + resolves displayName from the product map", () => {
    const displayNameById = new Map([
      ["prod_month", "Monthly"],
      ["prod_year", "Annual"],
    ]);
    const result = toRendererOffering(offeringFixture(), displayNameById);
    expect(result).toEqual({
      identifier: "default",
      packages: [
        { packageIdentifier: "$rov_monthly", displayName: "Monthly", metadata: undefined },
        { packageIdentifier: "$rov_annual", displayName: "Annual", metadata: undefined },
        { packageIdentifier: "$rov_weekly", displayName: "$rov_weekly", metadata: undefined },
      ],
    });
  });
});

describe("placeholderPriceView", () => {
  it("returns an empty object when there's no offering", () => {
    expect(placeholderPriceView(null)).toEqual({});
  });

  it("keys the view by packageIdentifier and cycles through presets", () => {
    const offering = toRendererOffering(offeringFixture(), new Map())!;
    const view = placeholderPriceView(offering);
    expect(Object.keys(view)).toEqual(["$rov_monthly", "$rov_annual", "$rov_weekly"]);
    for (const pkg of Object.values(view)) {
      expect(pkg.price).toMatch(/^\$\d/);
      expect(pkg.pricePerPeriod).toBeTruthy();
      expect(pkg.period).toBeTruthy();
    }
    // Distinct presets across packages (not all identical).
    const prices = Object.values(view).map((v) => v.price);
    expect(new Set(prices).size).toBeGreaterThan(1);
  });
});

describe("buildEligibilityMap", () => {
  it("returns an empty object when there's no offering", () => {
    expect(buildEligibilityMap(null, true)).toEqual({});
  });

  it("maps every package identifier to the same previewEligible flag", () => {
    const offering = toRendererOffering(offeringFixture(), new Map())!;
    expect(buildEligibilityMap(offering, true)).toEqual({
      $rov_monthly: true,
      $rov_annual: true,
      $rov_weekly: true,
    });
    expect(buildEligibilityMap(offering, false)).toEqual({
      $rov_monthly: false,
      $rov_annual: false,
      $rov_weekly: false,
    });
  });
});

describe("computeSelectionRect", () => {
  it("translates a viewport rect into the container's local + scrolled coordinate space", () => {
    const container = { left: 100, top: 50 };
    const scroll = { left: 20, top: 5 };
    const target = { left: 150, top: 90, width: 200, height: 40 };
    expect(computeSelectionRect(container, scroll, target)).toEqual({
      left: 70, // 150 - 100 + 20
      top: 45, // 90 - 50 + 5
      width: 200,
      height: 40,
    });
  });

  it("is a no-op when the container is unscrolled and rects share an origin", () => {
    const container = { left: 0, top: 0 };
    const scroll = { left: 0, top: 0 };
    const target = { left: 10, top: 20, width: 30, height: 40 };
    expect(computeSelectionRect(container, scroll, target)).toEqual(target);
  });
});

// =====================================================================
// resolvedPriceView (P6): real store prices in the canvas preview.
// =====================================================================

import type { OfferingResolvedPrices, ResolvedStoreEntry } from "@rovenue/shared";
import { resolvedPriceView } from "../canvas-helpers";

function ok(amountMinor: number, period: string | null, trialDays: number | null = null): ResolvedStoreEntry {
  return { status: "ok", amountMinor, currency: "USD", period, trialDays };
}

function resolvedFixture(
  stores: Record<string, { apple?: ResolvedStoreEntry; google?: ResolvedStoreEntry; stripe?: ResolvedStoreEntry }>,
): OfferingResolvedPrices {
  return {
    offeringId: "off_1",
    packages: Object.entries(stores).map(([packageIdentifier, s]) => ({
      packageIdentifier,
      productId: `prod_${packageIdentifier}`,
      displayName: packageIdentifier,
      metadataPeriod: null,
      stores: s,
    })),
    fetchedAt: "2026-07-27T00:00:00.000Z",
  };
}

function twoPackageOffering() {
  const displayNameById = new Map([
    ["prod_month", "Monthly"],
    ["prod_year", "Annual"],
  ]);
  const row = offeringFixture();
  row.packages = row.packages.slice(0, 2); // $rov_monthly, $rov_annual
  return toRendererOffering(row, displayNameById)!;
}

describe("resolvedPriceView", () => {
  it("(a) derives per-period figures and the SDK relativeDiscount formula on full coverage", () => {
    const offering = twoPackageOffering();
    const resolved = resolvedFixture({
      $rov_monthly: { apple: ok(999, "P1M") },
      $rov_annual: { apple: ok(5999, "P1Y") },
    });
    const { view, coverage } = resolvedPriceView(offering, resolved, "ios");

    expect(coverage).toBe("full");
    expect(view["$rov_monthly"]).toMatchObject({
      packageName: "Monthly",
      price: "$9.99",
      pricePerPeriod: "$9.99/month",
      period: "month",
      relativeDiscount: "0%",
    });
    expect(view["$rov_annual"]).toMatchObject({
      price: "$59.99",
      pricePerPeriod: "$59.99/year",
      period: "year",
      pricePerMonth: "$5.00",
      pricePerYear: "$59.99",
      relativeDiscount: "50%",
    });
  });

  it("(b) prefers the platform's own store: apple on ios, google on android", () => {
    const offering = twoPackageOffering();
    const resolved = resolvedFixture({
      $rov_monthly: { apple: ok(999, "P1M"), google: ok(899, "P1M"), stripe: ok(799, "P1M") },
      $rov_annual: { apple: ok(5999, "P1Y") },
    });
    expect(resolvedPriceView(offering, resolved, "ios").view["$rov_monthly"]!.price).toBe("$9.99");
    expect(resolvedPriceView(offering, resolved, "android").view["$rov_monthly"]!.price).toBe("$8.99");
  });

  it("(c) keeps the placeholder preset (at the original cycle index) for unresolved packages", () => {
    const offering = twoPackageOffering();
    const resolved = resolvedFixture({
      $rov_monthly: { apple: ok(999, "P1M") },
      $rov_annual: {}, // mapped nowhere → unresolved
    });
    const { view, coverage } = resolvedPriceView(offering, resolved, "ios");
    expect(coverage).toBe("partial");
    // Placeholder cycle index 1 belongs to $rov_annual (second package).
    expect(view["$rov_annual"]).toEqual(placeholderPriceView(offering)["$rov_annual"]);
    expect(view["$rov_monthly"]!.price).toBe("$9.99");
  });

  it("(d) maps positive trialDays to introPeriod", () => {
    const offering = twoPackageOffering();
    const resolved = resolvedFixture({
      $rov_monthly: { apple: ok(999, "P1M", 7) },
      $rov_annual: { apple: ok(5999, "P1Y", 0) },
    });
    const { view } = resolvedPriceView(offering, resolved, "ios");
    expect(view["$rov_monthly"]!.introPeriod).toBe("7 days");
    expect(view["$rov_annual"]!.introPeriod).toBeUndefined();
  });

  it("(e) unknown period ISO produces only the four required fields", () => {
    const offering = twoPackageOffering();
    const resolved = resolvedFixture({
      $rov_monthly: { apple: ok(999, "P2X") },
      $rov_annual: { apple: ok(5999, "P1Y") },
    });
    const monthly = resolvedPriceView(offering, resolved, "ios").view["$rov_monthly"]!;
    expect(monthly.price).toBe("$9.99");
    expect(monthly.period).toBe("");
    expect(monthly.pricePerPeriod).toBe("$9.99");
    expect(monthly.pricePerMonth).toBeUndefined();
    expect(monthly.pricePerYear).toBeUndefined();
    expect(monthly.pricePerWeek).toBeUndefined();
    expect(monthly.pricePerDay).toBeUndefined();
    expect(monthly.relativeDiscount).toBeUndefined();
  });

  it("(f) with nothing resolved the output is byte-equal to placeholderPriceView with coverage none", () => {
    const offering = twoPackageOffering();
    const none = resolvedPriceView(offering, undefined, "ios");
    expect(none.coverage).toBe("none");
    expect(none.view).toEqual(placeholderPriceView(offering));
  });
});
