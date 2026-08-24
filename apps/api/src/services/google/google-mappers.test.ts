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
  classifyNotification,
  effectiveGoogleOrderId,
  isGoogleRenewalOrderId,
} from "./google-mappers";
import type { GoogleRtdnPayload } from "./google-types";

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

// =============================================================
// classifyNotification — numeric RTDN notificationType -> named string
// =============================================================
//
// Before this fix, classifyNotification returned `SUBSCRIPTION_${n}`
// (the raw numeric code) unconditionally, which matched nothing in
// EVENT_TYPE_TO_CATEGORY or STORE_EVENT_TO_PUBLIC_KEY — both keyed on
// the NAMED form, same as Apple's notificationType strings.

describe("classifyNotification", () => {
  const subscriptionPayload = (
    notificationType: number,
  ): GoogleRtdnPayload =>
    ({
      version: "1.0",
      packageName: "com.example.app",
      eventTimeMillis: "1700000000000",
      subscriptionNotification: {
        version: "1.0",
        notificationType,
        purchaseToken: "tok_1",
        subscriptionId: "sub_1",
      },
    }) as GoogleRtdnPayload;

  it.each([
    [1, "SUBSCRIPTION_RECOVERED"],
    [2, "SUBSCRIPTION_RENEWED"],
    [3, "SUBSCRIPTION_CANCELED"],
    [4, "SUBSCRIPTION_PURCHASED"],
    [5, "SUBSCRIPTION_ON_HOLD"],
    [6, "SUBSCRIPTION_IN_GRACE_PERIOD"],
    [7, "SUBSCRIPTION_RESTARTED"],
    [8, "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED"],
    [9, "SUBSCRIPTION_DEFERRED"],
    [10, "SUBSCRIPTION_PAUSED"],
    [12, "SUBSCRIPTION_REVOKED"],
    [13, "SUBSCRIPTION_EXPIRED"],
  ])("maps numeric notificationType %d to the named %s", (numeric, named) => {
    expect(classifyNotification(subscriptionPayload(numeric))).toBe(named);
  });

  it("keeps the SUBSCRIPTION_${n} fallback for a numeric code with no named entry", () => {
    // 11 (SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED) and 20
    // (SUBSCRIPTION_PENDING_PURCHASE_CANCELED) are real Google codes not
    // in the spec's named table; an outright-unknown code (999) must also
    // never throw or drop the event.
    expect(classifyNotification(subscriptionPayload(11))).toBe("SUBSCRIPTION_11");
    expect(classifyNotification(subscriptionPayload(20))).toBe("SUBSCRIPTION_20");
    expect(classifyNotification(subscriptionPayload(999))).toBe("SUBSCRIPTION_999");
  });

  it("still classifies one-time product notifications by their own numeric scheme", () => {
    const payload = {
      version: "1.0",
      packageName: "com.example.app",
      eventTimeMillis: "1700000000000",
      oneTimeProductNotification: {
        version: "1.0",
        notificationType: 1,
        purchaseToken: "tok_1",
        sku: "sku_1",
      },
    } as GoogleRtdnPayload;
    expect(classifyNotification(payload)).toBe("ONE_TIME_1");
  });

  it("still classifies a voided-purchase notification", () => {
    const payload = {
      version: "1.0",
      packageName: "com.example.app",
      eventTimeMillis: "1700000000000",
      voidedPurchaseNotification: {
        purchaseToken: "tok_1",
        orderId: "order_1",
        productType: 1,
        refundType: 1,
      },
    } as GoogleRtdnPayload;
    expect(classifyNotification(payload)).toBe("VOIDED_PURCHASE");
  });

  it("returns UNKNOWN when the payload carries none of the recognized notification shapes", () => {
    const payload = {
      version: "1.0",
      packageName: "com.example.app",
      eventTimeMillis: "1700000000000",
    } as GoogleRtdnPayload;
    expect(classifyNotification(payload)).toBe("UNKNOWN");
  });
});
