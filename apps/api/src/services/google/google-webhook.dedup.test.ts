// =============================================================
// handleGoogleNotification — dedup key semantics
// =============================================================
//
// Google Play reuses the SAME purchaseToken for every lifecycle RTDN of
// a subscription (PURCHASED, RENEWED, CANCELED, IN_GRACE_PERIOD, …), so
// the webhook dedup key — enforced by the UNIQUE(source, storeEventId)
// index — must be the Pub/Sub messageId (stable across redeliveries of
// one message, unique across distinct notifications; the exact analog
// of Apple's per-notification notificationUUID), NEVER the
// purchaseToken. Keying on the token silently drops every lifecycle
// event after the first PROCESSED one.
//
// Unit seam: the repos are mocked with an in-memory store that mirrors
// the (source, storeEventId) unique-index claim semantics, so these
// tests pin the KEY the handler claims with, not Postgres behavior
// (covered by the concurrency integration test).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GooglePubSubPushBody } from "./google-types";
import type { GoogleVerifyConfig } from "./google-verify";

// ---------------------------------------------------------------
// In-memory webhook_events store mirroring claimWebhookEvent's
// UNIQUE(source, storeEventId) contract.
// ---------------------------------------------------------------
const state = vi.hoisted(() => {
  interface StoredEvent {
    id: string;
    source: string;
    storeEventId: string;
    status: string;
  }
  const events = new Map<string, StoredEvent>();
  const claimedStoreEventIds: string[] = [];
  const revenueEvents: Array<{ dedupeKey: string; amount: string }> = [];
  const DEFAULT_PRICING = { amount: 9.99, currency: "USD" };
  let seq = 0;
  return {
    events,
    claimedStoreEventIds,
    revenueEvents,
    DEFAULT_PRICING,
    // Configurable base-plan pricing served by the mocked google-verify —
    // the 0-USD regression test sets it to null (unresolvable).
    pricing: DEFAULT_PRICING as { amount: number; currency: string } | null,
    nextId: () => `wh_${++seq}`,
    reset() {
      events.clear();
      claimedStoreEventIds.length = 0;
      revenueEvents.length = 0;
      this.pricing = DEFAULT_PRICING;
      seq = 0;
    },
  };
});

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  const dbStub = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(dbStub),
  };
  return {
    ...actual,
    drizzle: {
      db: dbStub,
      webhookEventRepo: {
        claimWebhookEvent: vi.fn(
          async (
            _db: unknown,
            input: { source: string; storeEventId: string },
          ) => {
            state.claimedStoreEventIds.push(input.storeEventId);
            const key = `${input.source}:${input.storeEventId}`;
            const existing = state.events.get(key);
            if (existing) {
              if (existing.status === "PROCESSED") {
                return { outcome: "duplicate" as const };
              }
              return { outcome: "in_progress" as const };
            }
            const row = {
              id: state.nextId(),
              source: input.source,
              storeEventId: input.storeEventId,
              status: "PROCESSING",
            };
            state.events.set(key, row);
            return { outcome: "claimed" as const, row };
          },
        ),
        updateWebhookEvent: vi.fn(
          async (_db: unknown, id: string, patch: { status?: string }) => {
            for (const row of state.events.values()) {
              if (row.id === id && patch.status) row.status = patch.status;
            }
          },
        ),
      },
      purchaseExtRepo: {
        findPurchaseByStoreTransaction: vi.fn(async () => null),
      },
      subscriberRepo: {
        findSubscriberById: vi.fn(async () => null),
        upsertSubscriber: vi.fn(async () => ({ id: "sub_1" })),
      },
      offeringRepo: {
        findProductByStoreId: vi.fn(async () => ({
          id: "prod_1",
          accessIds: [],
        })),
      },
      purchaseRepo: {
        upsertPurchase: vi.fn(async () => ({ id: "pur_1" })),
        updatePurchase: vi.fn(async () => undefined),
      },
      accessRepo: {
        findAccessByPurchaseAndAccessId: vi.fn(async () => null),
        setAccessActiveAndExpiry: vi.fn(async () => undefined),
        createAccess: vi.fn(async () => undefined),
        revokeAccessByPurchaseId: vi.fn(async () => undefined),
      },
      revenueEventRepo: {
        createRevenueEvent: vi.fn(
          async (
            _db: unknown,
            input: { dedupeKey: string; amount: string },
          ) => {
            state.revenueEvents.push({
              dedupeKey: input.dedupeKey,
              amount: input.amount,
            });
          },
        ),
      },
    },
  };
});

vi.mock("./google-verify", () => ({
  verifyGoogleSubscription: vi.fn(async () => ({
    regionCode: "US",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    startTime: new Date(1_700_000_000_000).toISOString(),
    // Deprecated top-level order id + v2 line-item order id: the revenue
    // dedupe key must prefer the line item's latestSuccessfulOrderId.
    latestOrderId: "GPA.TOP-LEVEL",
    lineItems: [
      {
        productId: "pro_sub",
        expiryTime: new Date(1_705_000_000_000).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: "monthly" },
        latestSuccessfulOrderId: "GPA.LINE-ITEM",
      },
    ],
  })),
  acknowledgeGoogleSubscription: vi.fn(async () => undefined),
  getSubscriptionBasePlanPricing: vi.fn(async () => state.pricing),
}));

vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: vi.fn(async () => ({ apply: true })),
}));

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

const { handleGoogleNotification } = await import("./google-webhook");
const { GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE } = await import(
  "./google-types"
);

const PROJECT_ID = "prj_dedup_test";
const PURCHASE_TOKEN = "tok_lifecycle_stable";
const SUBSCRIPTION_ID = "pro_sub";

const fakeVerifyConfig = {
  credentials: { project_id: "test" },
  packageName: "com.rovenue.test",
} as unknown as GoogleVerifyConfig;

function makePushBody(args: {
  messageId: string;
  notificationType: number;
}): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    subscriptionNotification: {
      version: "1.0",
      notificationType: args.notificationType,
      purchaseToken: PURCHASE_TOKEN,
      subscriptionId: SUBSCRIPTION_ID,
    },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(rtdn)).toString("base64"),
      messageId: args.messageId,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/x/subscriptions/y",
  };
}

describe("handleGoogleNotification — storeEventId is the Pub/Sub messageId", () => {
  beforeEach(() => state.reset());

  it("processes two lifecycle notifications sharing one purchaseToken but distinct messageIds (PURCHASED then RENEWED)", async () => {
    const first = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody({
        messageId: "msg_purchase_1",
        notificationType:
          GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      }),
      verifyConfig: fakeVerifyConfig,
    });
    const second = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody({
        messageId: "msg_renewal_2",
        notificationType:
          GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
      }),
      verifyConfig: fakeVerifyConfig,
    });

    // Both are distinct notifications and must BOTH be processed —
    // pre-fix the second was dropped as "duplicate" because the shared
    // purchaseToken was used as the dedup key.
    expect(first.status).toBe("processed");
    expect(second.status).toBe("processed");

    // The claim key must be the messageId, never the purchaseToken.
    expect(state.claimedStoreEventIds).toEqual([
      "msg_purchase_1",
      "msg_renewal_2",
    ]);
    expect(state.claimedStoreEventIds).not.toContain(PURCHASE_TOKEN);
  });

  it("dedupes a Pub/Sub redelivery of the SAME messageId", async () => {
    const pushBody = makePushBody({
      messageId: "msg_redelivered",
      notificationType:
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
    });

    const first = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody,
      verifyConfig: fakeVerifyConfig,
    });
    const redelivery = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody,
      verifyConfig: fakeVerifyConfig,
    });

    expect(first.status).toBe("processed");
    expect(redelivery.status).toBe("duplicate");
    // Dispatch ran exactly once: one revenue event.
    expect(state.revenueEvents).toHaveLength(1);
  });
});

describe("handleGoogleNotification — revenue correctness", () => {
  beforeEach(() => state.reset());

  it("keys revenue on the line item's latestSuccessfulOrderId, not the deprecated top-level latestOrderId", async () => {
    const res = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody({
        messageId: "msg_orderid_pref",
        notificationType:
          GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      }),
      verifyConfig: fakeVerifyConfig,
    });

    expect(res.status).toBe("processed");
    expect(state.revenueEvents).toEqual([
      { dedupeKey: "google:GPA.LINE-ITEM:purchase", amount: "9.99" },
    ]);
  });

  it("never writes a 0-USD revenue row: an unresolvable price skips the emission", async () => {
    state.pricing = null;

    const res = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody({
        messageId: "msg_pricing_miss",
        notificationType:
          GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      }),
      verifyConfig: fakeVerifyConfig,
    });

    // The purchase/entitlement side still processes; only the revenue
    // emission is skipped (pre-fix this wrote amount "0" / USD).
    expect(res.status).toBe("processed");
    expect(state.revenueEvents).toHaveLength(0);
  });
});
