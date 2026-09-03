import { describe, expect, it } from "vitest";
import { isRovenueEventKey } from "./integrations";
import {
  resolveStorePublicKey,
  STORE_EVENT_TO_PUBLIC_KEY,
} from "./store-event-normalization";

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

// This is a table/unit-level check on the resolver's logic in isolation.
// It is NOT the evidence that closes out the double-map risk — that risk
// is about a real event physically reaching the outbox under the wrong
// (or a second) key, which only an end-to-end drive through
// webhook-processor.ts + apple-webhook.ts can demonstrate. See
// apps/api's webhook-processor.apple-renewal-status.test.ts for that.
describe("resolveStorePublicKey", () => {
  it("behaves exactly like a STORE_EVENT_TO_PUBLIC_KEY lookup when no context is passed", () => {
    for (const [storeEvent, publicKey] of Object.entries(STORE_EVENT_TO_PUBLIC_KEY)) {
      expect(resolveStorePublicKey(storeEvent)).toBe(publicKey);
    }
    expect(resolveStorePublicKey("DID_CHANGE_RENEWAL_STATUS")).toBeUndefined();
    expect(resolveStorePublicKey("some-unmapped-type")).toBeUndefined();
  });

  it("maps DID_CHANGE_RENEWAL_STATUS to subscription.uncancelled only when auto-renew turned back ON", () => {
    expect(
      resolveStorePublicKey("DID_CHANGE_RENEWAL_STATUS", { autoRenewEnabled: true }),
    ).toBe("subscription.uncancelled");
  });

  it("maps DID_CHANGE_RENEWAL_STATUS to nothing when auto-renew turned OFF or direction is absent", () => {
    expect(
      resolveStorePublicKey("DID_CHANGE_RENEWAL_STATUS", { autoRenewEnabled: false }),
    ).toBeUndefined();
    expect(resolveStorePublicKey("DID_CHANGE_RENEWAL_STATUS", {})).toBeUndefined();
  });

  it("ignores context for every other event type (no accidental cross-wiring)", () => {
    expect(
      resolveStorePublicKey("DID_FAIL_TO_RENEW", { autoRenewEnabled: true }),
    ).toBe("subscription.billing_issue");
  });
});
