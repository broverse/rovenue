import { describe, expect, it } from "vitest";
import type { Offering, StoreProduct } from "../../types";
import type { BuilderNode } from "../model";
import { activeOverrideConditions, applyOverrides } from "../overrides";

// D-Task 1's shared case table (packages/shared/src/paywall/validate.test.ts's
// `applyOverrides` describe block), ported verbatim to this package's
// lenient BuilderNode model — same semantics: array order, later wins,
// shallow overlay, identity when nothing matches, unknown when.kind never
// active. See ../overrides.ts's header comment for why this is a LOCAL
// port rather than a re-export of shared's applyOverrides.

describe("applyOverrides", () => {
  const baseText: Extract<BuilderNode, { type: "text" }> = {
    type: "text",
    id: "t1",
    key: "title_key",
    role: "title",
    color: { light: "#000" },
    align: "start",
  };

  it("returns the SAME object reference when the node has no overrides", () => {
    const result = applyOverrides(baseText, { introEligible: false, selected: false });
    expect(result).toBe(baseText);
  });

  it("returns the SAME object reference when overrides exist but none are active", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [{ when: { kind: "introEligible" }, props: { align: "center" } }],
    };
    const result = applyOverrides(node, { introEligible: false, selected: false });
    expect(result).toBe(node);
  });

  it("merges a matching introEligible override's props over the base (shallow, later wins n/a with one override)", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [{ when: { kind: "introEligible" }, props: { key: "intro_key", align: "center" } }],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    expect(result).not.toBe(node);
    expect(result).toEqual({ ...baseText, key: "intro_key", align: "center", overrides: node.overrides });
  });

  it("merges a matching selected override's props", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [{ when: { kind: "selected" }, props: { align: "end" } }],
    };
    const result = applyOverrides(node, { introEligible: false, selected: true });
    if (result.type !== "text") throw new Error("expected text");
    expect(result.align).toBe("end");
  });

  it("applies overrides in array order with later entries winning on shared keys", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [
        { when: { kind: "introEligible" }, props: { align: "center" } },
        { when: { kind: "introEligible" }, props: { align: "end" } },
      ],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    if (result.type !== "text") throw new Error("expected text");
    expect(result.align).toBe("end");
  });

  it("does not deep-merge — a later override's prop value wholly replaces the earlier one", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [
        { when: { kind: "introEligible" }, props: { color: { light: "#111" } } },
        { when: { kind: "introEligible" }, props: { color: { light: "#222" } } },
      ],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    if (result.type !== "text") throw new Error("expected text");
    expect(result.color).toEqual({ light: "#222" });
  });

  it("leaves untouched base props intact when only some props are overridden", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [{ when: { kind: "introEligible" }, props: { align: "end" } }],
    };
    const result = applyOverrides(node, { introEligible: true, selected: false });
    if (result.type !== "text") throw new Error("expected text");
    expect(result.key).toBe(baseText.key);
    expect(result.color).toEqual(baseText.color);
  });

  it("skips an override with an unknown when.kind (lenient-decoded data) without throwing", () => {
    const node: typeof baseText = {
      ...baseText,
      overrides: [{ when: { kind: "unknown" } }],
    };
    const result = applyOverrides(node, { introEligible: true, selected: true });
    expect(result).toBe(node);
  });

  it("is generic over any BuilderNode subtype — works on a packageList node too", () => {
    const node: BuilderNode = { type: "packageList", id: "p1", packageIds: [], cellLayout: "row" };
    const result = applyOverrides(node, { introEligible: false, selected: false });
    expect(result).toBe(node);
  });

  it("passes an `unknown` node through unchanged — it carries no overrides field at all", () => {
    const node: BuilderNode = { type: "unknown", id: "u1" };
    const result = applyOverrides(node, { introEligible: true, selected: true });
    expect(result).toBe(node);
  });
});

describe("activeOverrideConditions", () => {
  function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
    return {
      id: "com.x.pro",
      type: "subscription",
      productCategory: "subscription",
      displayName: "Pro",
      description: null,
      priceString: "$9.99",
      price: 9.99,
      currencyCode: "USD",
      subscriptionPeriod: { value: 1, unit: "month", iso8601: "P1M" },
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

  const offering: Offering = {
    identifier: "default",
    isDefault: true,
    packages: [
      { identifier: "monthly", packageType: "monthly", product: product({ isEligibleForIntroOffer: true }) },
      { identifier: "annual", packageType: "annual", product: product({ isEligibleForIntroOffer: false }) },
    ],
  };

  it("introEligible reflects the CELL package's product when inside a cellTemplate", () => {
    const result = activeOverrideConditions("monthly", "annual", offering);
    expect(result.introEligible).toBe(true);
  });

  it("introEligible reflects the SELECTED package's product outside any cellTemplate", () => {
    const result = activeOverrideConditions(null, "monthly", offering);
    expect(result.introEligible).toBe(true);
    expect(activeOverrideConditions(null, "annual", offering).introEligible).toBe(false);
  });

  it("introEligible is false when there is no relevant package id or no offering", () => {
    expect(activeOverrideConditions(null, null, offering).introEligible).toBe(false);
    expect(activeOverrideConditions(null, "monthly", null).introEligible).toBe(false);
  });

  it("introEligible is false when the product's isEligibleForIntroOffer is null", () => {
    const withNull: Offering = {
      identifier: "d",
      isDefault: true,
      packages: [{ identifier: "x", packageType: "monthly", product: product({ isEligibleForIntroOffer: null }) }],
    };
    expect(activeOverrideConditions("x", "x", withNull).introEligible).toBe(false);
  });

  it("selected is true only inside a cellTemplate (non-null cellPackageId) matching the global selection", () => {
    expect(activeOverrideConditions("monthly", "monthly", offering).selected).toBe(true);
    expect(activeOverrideConditions("monthly", "annual", offering).selected).toBe(false);
    // Outside any cellTemplate (cellPackageId null), `selected` never activates.
    expect(activeOverrideConditions(null, "monthly", offering).selected).toBe(false);
  });
});
