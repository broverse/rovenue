import { describe, expect, it } from "vitest";
import {
  classifyNotification,
  isAccessGranting,
  mapRevenueEventType,
  mapStatus,
  parsePushBody,
} from "../src/services/google/google-mappers";
import {
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE,
  GOOGLE_VOIDED_PURCHASE_REFUND_TYPE,
  type GoogleRtdnPayload,
  type GoogleSubscriptionNotificationType,
  type GoogleSubscriptionState,
} from "../src/services/google/google-types";

// Note: PurchaseStatus / RevenueEventType are compared as string
// literals because google-mappers.ts uses `import type` for the
// enum types. The literals match the pgEnum runtime labels.

describe("parsePushBody", () => {
  it("base64-decodes message.data into the RTDN payload", () => {
    const rtdnPayload: GoogleRtdnPayload = {
      version: "1.0",
      packageName: "com.example.app",
      eventTimeMillis: "1700000000000",
      subscriptionNotification: {
        version: "1.0",
        notificationType:
          GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
        purchaseToken: "token_123",
        subscriptionId: "premium_monthly",
      },
    };
    const data = Buffer.from(JSON.stringify(rtdnPayload)).toString("base64");

    const parsed = parsePushBody({
      message: {
        data,
        messageId: "msg_1",
        publishTime: "2023-11-14T22:13:20Z",
      },
      subscription: "projects/x/subscriptions/y",
    });

    expect(parsed.packageName).toBe("com.example.app");
    expect(parsed.subscriptionNotification?.purchaseToken).toBe("token_123");
    expect(parsed.subscriptionNotification?.notificationType).toBe(
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
    );
  });
});

describe("classifyNotification", () => {
  it("tags subscription notifications with their named type", () => {
    // Regression guard for the Wave-1 fix: classifyNotification used to
    // interpolate the raw numeric RTDN notificationType straight into
    // "SUBSCRIPTION_${n}", which matched nothing in EVENT_TYPE_TO_CATEGORY
    // or STORE_EVENT_TO_PUBLIC_KEY (both keyed on Google's NAMED form,
    // same as Apple's notificationType strings). It now maps the known
    // numeric codes through a named table first.
    expect(
      classifyNotification({
        version: "1.0",
        packageName: "com.x",
        eventTimeMillis: "0",
        subscriptionNotification: {
          version: "1.0",
          notificationType:
            GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
          purchaseToken: "t",
          subscriptionId: "s",
        },
      }),
    ).toBe("SUBSCRIPTION_PURCHASED");
  });

  it("falls back to the numeric SUBSCRIPTION_<n> shape for an unrecognized notificationType", () => {
    expect(
      classifyNotification({
        version: "1.0",
        packageName: "com.x",
        eventTimeMillis: "0",
        subscriptionNotification: {
          version: "1.0",
          // 999 is not a real Google RTDN code — stands in for any future
          // undocumented value. Must never throw or drop the event.
          notificationType: 999 as unknown as GoogleSubscriptionNotificationType,
          purchaseToken: "t",
          subscriptionId: "s",
        },
      }),
    ).toBe("SUBSCRIPTION_999");
  });

  it("tags voided purchase notifications", () => {
    expect(
      classifyNotification({
        version: "1.0",
        packageName: "com.x",
        eventTimeMillis: "0",
        voidedPurchaseNotification: {
          purchaseToken: "t",
          orderId: "o",
          productType:
            GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE.PRODUCT_TYPE_SUBSCRIPTION,
          refundType:
            GOOGLE_VOIDED_PURCHASE_REFUND_TYPE.REFUND_TYPE_FULL_REFUND,
        },
      }),
    ).toBe("VOIDED_PURCHASE");
  });

  it("returns UNKNOWN for empty payloads", () => {
    expect(
      classifyNotification({
        version: "1.0",
        packageName: "com.x",
        eventTimeMillis: "0",
      }),
    ).toBe("UNKNOWN");
  });
});

describe("mapStatus", () => {
  it("maps ACTIVE state to ACTIVE", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
      ),
    ).toBe("ACTIVE");
  });

  it("treats CANCELED (auto-renew off) as still ACTIVE until expiry", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.CANCELED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED,
      ),
    ).toBe("ACTIVE");
  });

  it("maps IN_GRACE_PERIOD to GRACE_PERIOD", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.IN_GRACE_PERIOD,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD,
      ),
    ).toBe("GRACE_PERIOD");
  });

  it("maps EXPIRED to EXPIRED", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.EXPIRED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED,
      ),
    ).toBe("EXPIRED");
  });

  // Task 4 (2026-09-04): ON_HOLD used to collapse into PAUSED alongside a
  // voluntary pause. It now maps to BILLING_ISSUE — an account hold is
  // Google having stopped covering a failed payment, not the user's own
  // choice — so this splits into two separate expectations.
  it("maps ON_HOLD to BILLING_ISSUE, not PAUSED", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.ON_HOLD,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_ON_HOLD,
      ),
    ).toBe("BILLING_ISSUE");
  });

  it("maps PAUSED to PAUSED", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PAUSED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PAUSED,
      ),
    ).toBe("PAUSED");
  });

  it("maps PENDING states to EXPIRED — an unpaid purchase never grants access", () => {
    // The user has not completed payment: neither state may map to an
    // access-granting status. When payment completes Google sends a fresh
    // paid-state RTDN, which re-activates the row.
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PENDING,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      ),
    ).toBe("EXPIRED");
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PENDING_PURCHASE_CANCELED,
      ),
    ).toBe("EXPIRED");
  });

  it("defaults unrecognized states to EXPIRED (fail closed), never ACTIVE", () => {
    expect(
      mapStatus(
        "SUBSCRIPTION_STATE_SOMETHING_NEW" as GoogleSubscriptionState,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
      ),
    ).toBe("EXPIRED");
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.UNSPECIFIED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
      ),
    ).toBe("EXPIRED");
  });

  it("falls back to REVOKED when the type is SUBSCRIPTION_REVOKED", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.UNSPECIFIED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED,
      ),
    ).toBe("REVOKED");
  });
});

describe("mapRevenueEventType", () => {
  // mapRevenueEventType takes a GoogleSubscriptionNotificationType (the
  // GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE literal-numeric union), not a
  // bare `number` — widening it here just to build this table discarded
  // the literal type before it reached the call below.
  const cases: ReadonlyArray<
    readonly [
      type: GoogleSubscriptionNotificationType,
      expected: string | null,
      label: string,
    ]
  > = [
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      "INITIAL",
      "SUBSCRIPTION_PURCHASED → INITIAL",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
      "RENEWAL",
      "SUBSCRIPTION_RENEWED → RENEWAL",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED,
      "REACTIVATION",
      "SUBSCRIPTION_RECOVERED → REACTIVATION",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED,
      "REACTIVATION",
      "SUBSCRIPTION_RESTARTED → REACTIVATION",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED,
      "CANCELLATION",
      "SUBSCRIPTION_CANCELED → CANCELLATION",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED,
      "CANCELLATION",
      "SUBSCRIPTION_EXPIRED → CANCELLATION",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED,
      "REFUND",
      "SUBSCRIPTION_REVOKED → REFUND",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_ON_HOLD,
      null,
      "SUBSCRIPTION_ON_HOLD → null",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD,
      null,
      "SUBSCRIPTION_IN_GRACE_PERIOD → null",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_DEFERRED,
      null,
      "SUBSCRIPTION_DEFERRED → null",
    ],
    [
      GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PRICE_CHANGE_CONFIRMED,
      null,
      "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED → null",
    ],
  ];

  for (const [type, expected, label] of cases) {
    it(label, () => {
      expect(mapRevenueEventType(type)).toBe(expected);
    });
  }
});

describe("isAccessGranting", () => {
  it("grants entitlement for ACTIVE / TRIAL / GRACE_PERIOD", () => {
    // These literals are valid PurchaseStatus (= SubscriptionStatus)
    // members (packages/shared/src/subscription-status.ts) — the
    // `@ts-expect-error` directives these lines used to need are stale
    // and now flagged as unused (TS2578), not needed to make the calls
    // compile.
    expect(isAccessGranting("ACTIVE")).toBe(true);
    expect(isAccessGranting("TRIAL")).toBe(true);
    expect(isAccessGranting("GRACE_PERIOD")).toBe(true);
  });

  it("denies entitlement for non-active statuses", () => {
    expect(isAccessGranting("EXPIRED")).toBe(false);
    expect(isAccessGranting("REFUNDED")).toBe(false);
    expect(isAccessGranting("REVOKED")).toBe(false);
    expect(isAccessGranting("PAUSED")).toBe(false);
  });
});
