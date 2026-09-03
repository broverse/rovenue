import { describe, expect, it } from "vitest";
import { classifyNotification } from "./google-mappers";
import { GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE } from "./google-types";
import type {
  GoogleRtdnPayload,
  GoogleSubscriptionNotificationType,
} from "./google-types";
import { resolveStorePublicKey } from "@rovenue/shared";

// =============================================================
// Google RTDN -> public lifecycle key
// =============================================================
//
// Scope note, stated rather than implied: this proves the
// numeric-RTDN -> named-type -> public-key chain, NOT a full webhook
// round trip. That is deliberate and it is where the risk actually is.
//
// Apple's REVOKE needed a full end-to-end test because its path was
// BROKEN — `applyRevoke` never set `outcome.subscriberId`, so the bridge
// could not run at all and a mapping row alone would have been inert
// (see apple-webhook.renewal-status.test.ts).
//
// Google's path has no such defect: `google-webhook.ts` reads
// `outcome.subscriberId` at three call sites and the four Google rows
// already in STORE_EVENT_TO_PUBLIC_KEY (ON_HOLD, IN_GRACE_PERIOD,
// RESTARTED, PRICE_CHANGE_CONFIRMED) ride exactly this chain today. The
// three rows added here are the same mechanism, so the link worth pinning
// is the one that is new: that the classifier's NAMED output is spelled
// the way the map keys on it.
//
// The failure this catches: `classifyNotification` used to interpolate
// the raw numeric type into "SUBSCRIPTION_${n}", which made every named
// map row unreachable. A spelling drift on either side would do it again.

const CASES = [
  [GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PAUSED, "subscription.paused"],
  [GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED, "subscription.recovered"],
  [GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED, "subscription.revoked"],
] as const;

/** The minimal RTDN envelope `classifyNotification` reads — it takes the
 *  payload, not the bare numeric type. */
function makePayload(
  notificationType: GoogleSubscriptionNotificationType,
): GoogleRtdnPayload {
  return {
    version: "1.0",
    packageName: "com.example.app",
    eventTimeMillis: "1",
    subscriptionNotification: {
      version: "1.0",
      notificationType,
      purchaseToken: "tok",
      subscriptionId: "sub",
    },
  } as GoogleRtdnPayload;
}

describe("Google RTDN types resolve to the new lifecycle keys", () => {
  for (const [numericType, expectedKey] of CASES) {
    it(`notificationType ${numericType} -> ${expectedKey}`, () => {
      const named = classifyNotification(makePayload(numericType));
      expect(named, "classifier must produce a NAMED type, not SUBSCRIPTION_<n>").not.toMatch(
        /^SUBSCRIPTION_\d+$/,
      );
      expect(resolveStorePublicKey(named)).toBe(expectedKey);
    });
  }

  it("an unrecognised numeric type resolves to no key rather than a wrong one", () => {
    const named = classifyNotification(makePayload(999 as never));
    expect(resolveStorePublicKey(named)).toBeUndefined();
  });
});
