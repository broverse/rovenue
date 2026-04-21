import { describe, expect, it } from "vitest";
import {
  classifyNotification,
  isEntitlementGranting,
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
  it("tags subscription notifications with their numeric type", () => {
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
    ).toBe(
      `SUBSCRIPTION_${GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED}`,
    );
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

  it("maps ON_HOLD / PAUSED to PAUSED", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.ON_HOLD,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_ON_HOLD,
      ),
    ).toBe("PAUSED");
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PAUSED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PAUSED,
      ),
    ).toBe("PAUSED");
  });

  it("maps PENDING states to TRIAL (provisional access)", () => {
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PENDING,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      ),
    ).toBe("TRIAL");
    expect(
      mapStatus(
        GOOGLE_SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED,
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PENDING_PURCHASE_CANCELED,
      ),
    ).toBe("TRIAL");
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
  const cases: ReadonlyArray<
    readonly [
      type: number,
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

describe("isEntitlementGranting", () => {
  it("grants entitlement for ACTIVE / TRIAL / GRACE_PERIOD", () => {
    // @ts-expect-error — testing runtime values that match the pgEnum
    expect(isEntitlementGranting("ACTIVE")).toBe(true);
    // @ts-expect-error
    expect(isEntitlementGranting("TRIAL")).toBe(true);
    // @ts-expect-error
    expect(isEntitlementGranting("GRACE_PERIOD")).toBe(true);
  });

  it("denies entitlement for non-active statuses", () => {
    // @ts-expect-error
    expect(isEntitlementGranting("EXPIRED")).toBe(false);
    // @ts-expect-error
    expect(isEntitlementGranting("REFUNDED")).toBe(false);
    // @ts-expect-error
    expect(isEntitlementGranting("REVOKED")).toBe(false);
    // @ts-expect-error
    expect(isEntitlementGranting("PAUSED")).toBe(false);
  });
});
