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
