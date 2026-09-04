import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// DID_CHANGE_RENEWAL_PREF — immediate upgrade handling
// =============================================================
//
// Apple sends DID_CHANGE_RENEWAL_PREF with subtype UPGRADE when a
// subscriber cross-grades to a higher tier: the user is charged
// IMMEDIATELY and `signedTransactionInfo` carries the NEW transaction
// (new productId / transactionId / price). Ignoring it (the old
// default-branch behavior) left the subscriber paying for Tier B while
// still entitled to Tier A until the next DID_RENEW — and the upgrade
// charge was never counted as revenue.
//
// Subtype DOWNGRADE (and the no-subtype "reverted their pending change"
// case) take effect at the NEXT renewal — the later DID_RENEW carries
// the new product — so they must stay no-ops today.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    projectRepo: {
      findProjectById: vi.fn(),
    },
    subscriberRepo: {
      findSubscriberByAppleAppAccountToken: vi.fn(async () => null),
      upsertSubscriber: vi.fn(),
      createSubscriber: vi.fn(),
      findSubscriberById: vi.fn(async () => null),
      resolveSubscriberByRovenueId: vi.fn(async () => null),
      findSubscriberByRovenueId: vi.fn(async () => null),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(async () => null),
      findPurchaseByStoreTransaction: vi.fn(async () => null),
      // No prior-period sibling to supersede in these tests — the
      // upgrade-supersession path (apple-supersede.ts) is covered by
      // its own integration test.
      findSupersedableApplePurchases: vi.fn(async () => []),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
      lockPurchaseStatusByStoreTransaction: vi.fn(async () => null),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByOriginalTransaction: vi.fn(async () => undefined),
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
      // The first-charge emits (SUBSCRIBED, an UPGRADE renewal-pref change,
      // OFFER_REDEEMED) ask whether either INITIAL's or REACTIVATION's
      // dedupe key is already claimed for the transaction — those two
      // labels are the same charge and must not both be written. `false` =
      // nothing recorded yet, which is this fixture's situation.
      anyDedupeKeyClaimed: vi.fn(async () => false),
    },
    refundShieldResponseRepo: {
      insertConsumptionRequest: vi.fn(async () => true),
      updateOutcomeByOriginalTransactionIdIfNull: vi.fn(async () => true),
      updateOutcomeByOriginalTransactionIdOverwrite: vi.fn(
        async () => undefined,
      ),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

vi.mock("../../lib/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  APPLE_NOTIFICATION_SUBTYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
  type AppleNotificationSubtype,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

const PROJECT_ID = "prj_test";
const ORIGINAL_TRANSACTION_ID = "3000000010";
const UPGRADE_TRANSACTION_ID = "3000000042";
const FIXED_SIGNED_DATE_MS = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/** The NEW transaction Apple signs into an UPGRADE notification. */
function makeUpgradeTransaction(): AppleJwsTransactionPayload {
  return {
    transactionId: UPGRADE_TRANSACTION_ID,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    bundleId: "com.example.app",
    productId: "premium_yearly",
    purchaseDate: FIXED_SIGNED_DATE_MS,
    originalPurchaseDate: FIXED_SIGNED_DATE_MS - 60 * DAY_MS,
    expiresDate: FIXED_SIGNED_DATE_MS + 365 * DAY_MS,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: FIXED_SIGNED_DATE_MS,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: 79_990_000,
  } satisfies AppleJwsTransactionPayload;
}

function makeNotification(
  subtype: AppleNotificationSubtype | undefined,
  uuid: string,
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_PREF,
    ...(subtype ? { subtype } : {}),
    notificationUUID: uuid,
    version: "2.0",
    signedDate: FIXED_SIGNED_DATE_MS,
    data: {
      signedTransactionInfo: "signed-tx-stub",
      environment: APPLE_ENVIRONMENT.SANDBOX,
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  notification: AppleResponseBodyV2DecodedPayload,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => makeUpgradeTransaction()),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("renewal info not used in these tests");
    }),
  };
}

async function dispatchPrefChange(
  subtype: AppleNotificationSubtype | undefined,
  uuid: string,
) {
  return handleAppleNotification({
    projectId: PROJECT_ID,
    signedPayload: "signed-envelope-stub",
    verifier: makeStubVerifier(makeNotification(subtype, uuid)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    outcome: "claimed",
    row: { id: "wh_1", status: "PROCESSING" },
  });
  drizzleMock.subscriberRepo.createSubscriber.mockResolvedValue({
    id: "sub_up",
    appUserId: `apple:${ORIGINAL_TRANSACTION_ID}`,
  });
  drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
    id: "sub_up",
    appUserId: `apple:${ORIGINAL_TRANSACTION_ID}`,
  });
  drizzleMock.offeringRepo.findProductByStoreId.mockResolvedValue({
    id: "prod_yearly",
    accessIds: ["premium"],
  });
  drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({
    id: "pur_upgrade",
  });
});

describe("handleAppleNotification — DID_CHANGE_RENEWAL_PREF", () => {
  test("UPGRADE: upserts the new transaction's purchase, grants access, and counts the charge", async () => {
    const result = await dispatchPrefChange(
      APPLE_NOTIFICATION_SUBTYPE.UPGRADE,
      "uuid-up-1",
    );

    expect(result.status).toBe("processed");

    // New purchase row keyed by the upgrade's own transactionId + product.
    expect(drizzleMock.purchaseRepo.upsertPurchase).toHaveBeenCalledOnce();
    const upsertArgs = drizzleMock.purchaseRepo.upsertPurchase.mock
      .calls[0]![1] as {
      storeTransactionId: string;
      create: { productId: string; status: string };
    };
    expect(upsertArgs.storeTransactionId).toBe(UPGRADE_TRANSACTION_ID);
    expect(upsertArgs.create.productId).toBe("prod_yearly");
    expect(upsertArgs.create.status).toBe("ACTIVE");

    // The new tier's entitlement is granted now, not at next renewal.
    expect(drizzleMock.accessRepo.createAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessId: "premium", purchaseId: "pur_upgrade" }),
    );

    // The immediate upgrade charge lands in revenue, dedupe-keyed on the
    // new transaction so replays are no-ops.
    expect(drizzleMock.revenueEventRepo.createRevenueEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purchaseId: "pur_upgrade",
        productId: "prod_yearly",
        amount: "79.99",
      }),
    );
  });

  test("DOWNGRADE: no purchase write, no access, no revenue (applies at next renewal)", async () => {
    const result = await dispatchPrefChange(
      APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE,
      "uuid-down-1",
    );

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
    expect(drizzleMock.accessRepo.createAccess).not.toHaveBeenCalled();
    expect(drizzleMock.revenueEventRepo.createRevenueEvent).not.toHaveBeenCalled();
  });

  test("no subtype (pending change reverted): no-op", async () => {
    const result = await dispatchPrefChange(undefined, "uuid-none-1");

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
    expect(drizzleMock.revenueEventRepo.createRevenueEvent).not.toHaveBeenCalled();
  });
});
