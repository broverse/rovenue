import { describe, expect, it } from "vitest";
import { isRovenueEventKey } from "./integrations";
import { STORE_EVENT_TO_PUBLIC_KEY } from "./store-event-normalization";

describe("STORE_EVENT_TO_PUBLIC_KEY", () => {
  it("maps every store-native event to a runtime-valid RovenueEventKey", () => {
    for (const [storeEvent, publicKey] of Object.entries(STORE_EVENT_TO_PUBLIC_KEY)) {
      expect(isRovenueEventKey(publicKey), `${storeEvent} -> ${publicKey}`).toBe(true);
    }
  });

  it("matches the exact spec table", () => {
    expect(STORE_EVENT_TO_PUBLIC_KEY).toEqual({
      DID_FAIL_TO_RENEW: "subscription.billing_issue",
      GRACE_PERIOD_EXPIRED: "subscription.billing_issue",
      DID_CHANGE_RENEWAL_PREF: "subscription.product_changed",
      SUBSCRIPTION_ON_HOLD: "subscription.billing_issue",
      SUBSCRIPTION_IN_GRACE_PERIOD: "subscription.grace_period",
      SUBSCRIPTION_RESTARTED: "subscription.uncancelled",
      SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: "subscription.product_changed",
      SUBSCRIPTION_DEFERRED: "subscription.product_changed",
      "invoice.payment_failed": "subscription.billing_issue",
    });
  });

  it("deliberately excludes the ambiguous Apple/Stripe renewal-status rows (direction not observable at the bridge site)", () => {
    expect(STORE_EVENT_TO_PUBLIC_KEY.DID_CHANGE_RENEWAL_STATUS).toBeUndefined();
    expect(STORE_EVENT_TO_PUBLIC_KEY["customer.subscription.updated"]).toBeUndefined();
  });

  it("does not duplicate the already-produced subscription.cancel_requested / subscription.expired keys", () => {
    expect(Object.values(STORE_EVENT_TO_PUBLIC_KEY)).not.toContain(
      "subscription.cancel_requested",
    );
    expect(Object.values(STORE_EVENT_TO_PUBLIC_KEY)).not.toContain("subscription.expired");
  });
});
