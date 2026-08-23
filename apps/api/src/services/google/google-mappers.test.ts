// =============================================================
// google-mappers — effective order id extraction
// =============================================================
//
// SubscriptionPurchaseV2 moved the order id onto the line item as
// `latestSuccessfulOrderId`; the top-level `latestOrderId` is deprecated
// but still populated on older responses. Revenue dedupe keys must
// prefer the line-item field and fall back to the deprecated one, and
// renewal orders (the `..N` suffix Google appends per period) must be
// classifiable so the receipt path can label INITIAL vs RENEWAL.

import { describe, expect, it } from "vitest";
import {
  effectiveGoogleOrderId,
  isGoogleRenewalOrderId,
} from "./google-mappers";

describe("effectiveGoogleOrderId", () => {
  it("prefers the line item's latestSuccessfulOrderId over the deprecated top-level latestOrderId", () => {
    expect(
      effectiveGoogleOrderId(
        { latestOrderId: "GPA.TOP-LEVEL" },
        { latestSuccessfulOrderId: "GPA.LINE-ITEM" },
      ),
    ).toBe("GPA.LINE-ITEM");
  });

  it("falls back to the deprecated top-level latestOrderId when the line item carries none", () => {
    expect(
      effectiveGoogleOrderId({ latestOrderId: "GPA.TOP-LEVEL" }, {}),
    ).toBe("GPA.TOP-LEVEL");
    expect(
      effectiveGoogleOrderId({ latestOrderId: "GPA.TOP-LEVEL" }, undefined),
    ).toBe("GPA.TOP-LEVEL");
  });

  it("returns undefined when Google sent neither (callers fall back to the purchaseToken)", () => {
    expect(effectiveGoogleOrderId({}, {})).toBeUndefined();
    expect(effectiveGoogleOrderId({}, undefined)).toBeUndefined();
  });
});

describe("isGoogleRenewalOrderId", () => {
  it("classifies the `..N` renewal suffix as a renewal order", () => {
    expect(isGoogleRenewalOrderId("GPA.3333-1111-2222-33334..0")).toBe(true);
    expect(isGoogleRenewalOrderId("GPA.3333-1111-2222-33334..12")).toBe(true);
  });

  it("classifies a bare order id as the initial order", () => {
    expect(isGoogleRenewalOrderId("GPA.3333-1111-2222-33334")).toBe(false);
  });
});
