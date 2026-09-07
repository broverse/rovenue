import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// DID_RENEW — the PURCHASE-trigger grant must never fire on a renewal
// =============================================================
//
// Apple mints a NEW transactionId for every charging renewal (see
// `applyOfferRedeemed`'s comment in apple-webhook.ts), so DID_RENEW
// always creates a brand-new purchase row. Before this fix,
// `applyRenewal`'s `ctx.outcome.purchaseId` flowed into
// `runPostProcessing` -> `maybeCreditConsumablePurchase`, which called
// `grantProductCurrencies` unconditionally with trigger "PURCHASE" and
// that fresh purchaseId as the reference — a reference `addCredits`'
// dedupe had never seen before, so every renewal re-granted a
// grantOn PURCHASE row, and double-granted a grantOn BOTH row (once
// here under referenceType "purchase", once via the Kafka
// renewal-grants consumer under referenceType "renewal").
//
// `applyRenewal` now sets `DispatchOutcome.isRenewalCharge = true`,
// threaded through `postProcess` -> `runPostProcessing`
// (webhook-processor.ts), which withholds the PURCHASE-trigger call
// entirely for it.
//
// This test drives a REAL DID_RENEW notification through
// `handleAppleNotification`, with `postProcess` wired to
// webhook-processor.ts's REAL `runPostProcessing` (only the `drizzle`
// repo calls and `grantProductCurrencies` are mocked) — matching the
// existing convention in apple-webhook.renewal-status.test.ts. A test
// that only unit-tested `runPostProcessing` in isolation would prove
// the gate exists, not that `applyRenewal` actually sets the flag that
// drives it.
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
    subscriberRepo: {
      upsertSubscriber: vi.fn(),
      findSubscriberById: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
      findSubscriberByAppleAppAccountToken: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      lockPurchaseStatusByStoreTransaction: vi.fn(async () => null),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
      findPurchaseWithCreditInfo: vi.fn(),
      // A DID_RENEW dispatch reaches `retireChainBillingIssue`
      // (services/apple/apple-recovery.ts), which calls this. Returning an
      // empty chain is the "nothing stale to retire" case and keeps this
      // test focused on the credit gate. NOTE: no other mock of
      // `purchaseExtRepo` in this repo defines it either (12 files mock the
      // namespace, none had this method) — they simply do not dispatch a
      // path that reaches it. Any test that starts to will fail the same way.
      findChainBillingIssuePurchases: vi.fn(
        async (): Promise<
          Array<{
            id: string;
            storeTransactionId: string;
            subscriberId: string;
            productId: string;
          }>
        > => [],
      ),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
    projectRepo: {
      findProjectWebhookConfig: vi.fn(async () => ({
        url: null,
        eventCategories: [] as string[],
      })),
    },
    outboxRepo: {
      insert: vi.fn(async () => undefined),
      findByWebhookEventAndType: vi.fn(async () => null),
      findByPurchaseAndType: vi.fn(async () => null),
    },
    outgoingWebhookRepo: {
      findRecentOutgoingByPurchaseAndType: vi.fn(async () => null),
      findOutgoingByWebhookEvent: vi.fn(async () => null),
      enqueueOutgoingWebhook: vi.fn(async () => undefined),
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

// Only `syncAccess` is stubbed: it writes. `entitlementExpiry` is a pure
// computation the DID_RENEW path calls, so the real one is kept — mocking a
// pure function here would let this test pin behaviour the implementation
// does not have.
vi.mock("../access-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../access-engine")>()),
  syncAccess: vi.fn(async () => undefined),
}));

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

vi.mock("../purchase-credits", () => ({
  grantProductCurrencies: vi.fn(async () => undefined),
}));

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";
import { __test_runPostProcessing as runPostProcessing } from "../webhook-processor";
import type { WebhookPostProcess } from "../webhook-processor";
import { grantProductCurrencies } from "../purchase-credits";

const PROJECT_ID = "prj_rg_test";
const ORIGINAL_TRANSACTION_ID = "otxn_rg_1";
const RENEWAL_TRANSACTION_ID = "txn_rg_renewal_1";
const SUBSCRIBER_ID = "sub_rg_1";
const PURCHASE_ID = "pur_rg_1";
const PRODUCT_ID = "prod_rg_1";
const FIXED_MS = 1_700_000_000_000;

function makeRenewalTransaction(): AppleJwsTransactionPayload {
  return {
    // A renewal transactionId is always fresh — never equal to
    // originalTransactionId — which is precisely why a purchaseId-keyed
    // dedupe can't catch a repeat grant.
    transactionId: RENEWAL_TRANSACTION_ID,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: FIXED_MS,
    originalPurchaseDate: FIXED_MS,
    expiresDate: FIXED_MS + 30 * 86_400_000,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: FIXED_MS,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: 9_990_000,
    transactionReason: "RENEWAL",
  } as AppleJwsTransactionPayload;
}

function makeRenewalNotification(uuid: string): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_RENEW,
    notificationUUID: uuid,
    version: "2.0",
    signedDate: FIXED_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-tx-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  notification: AppleResponseBodyV2DecodedPayload,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => makeRenewalTransaction()),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("renewal info not used in this test");
    }),
  };
}

/**
 * The REAL postProcess wiring, copied verbatim from
 * `processWebhookEvent` in webhook-processor.ts (that closure isn't
 * exported — only `runPostProcessing` is, via `__test_runPostProcessing`).
 * Matches apple-webhook.renewal-status.test.ts's `makePostProcess`.
 */
function makePostProcess(): WebhookPostProcess {
  return async (ctx) => {
    if (!ctx.subscriberId) return;
    await runPostProcessing({
      projectId: PROJECT_ID,
      subscriberId: ctx.subscriberId,
      purchaseId: ctx.purchaseId,
      eventType: ctx.eventType,
      webhookEventId: ctx.webhookEventId,
      eventContext: ctx.eventContext,
      isRenewalCharge: ctx.isRenewalCharge,
    });
  };
}

async function dispatchRenewal(uuid: string) {
  return handleAppleNotification({
    projectId: PROJECT_ID,
    signedPayload: "signed-envelope-stub",
    verifier: makeStubVerifier(makeRenewalNotification(uuid)),
    postProcess: makePostProcess(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    outcome: "claimed",
    row: { id: "wh_rg" },
  });
  // First sighting of this (store, transactionId) — accurately mirrors
  // an Apple renewal, which is ALWAYS a brand-new transactionId.
  drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
    null,
  );
  drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
    { id: PURCHASE_ID, subscriberId: SUBSCRIBER_ID },
  );
  drizzleMock.subscriberRepo.findSubscriberById.mockResolvedValue({
    id: SUBSCRIBER_ID,
    appUserId: "rov_device",
  });
  drizzleMock.offeringRepo.findProductByStoreId.mockResolvedValue({
    id: PRODUCT_ID,
    accessIds: [] as string[],
  });
  drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({
    id: PURCHASE_ID,
  });
  drizzleMock.projectRepo.findProjectWebhookConfig.mockResolvedValue({
    url: null,
    eventCategories: [],
  });
  // A subscription with a currency grant row configured — mocked away
  // at the grantProductCurrencies boundary, so its exact grantOn value
  // doesn't matter here: the assertion is that this call site never
  // reaches grantProductCurrencies with trigger "PURCHASE" at all for a
  // renewal, which covers a PURCHASE-only row (would re-grant) and a
  // BOTH row (would double-grant against its separate RENEWAL-trigger
  // grant) identically.
  drizzleMock.purchaseExtRepo.findPurchaseWithCreditInfo.mockResolvedValue({
    id: PURCHASE_ID,
    subscriberId: SUBSCRIBER_ID,
    product: {
      id: PRODUCT_ID,
      identifier: "com.example.pro_monthly",
      type: "SUBSCRIPTION",
    },
  });
});

describe("handleAppleNotification — DID_RENEW must never fire the PURCHASE-trigger grant", () => {
  test("grantProductCurrencies is never called with trigger PURCHASE for a real DID_RENEW dispatch", async () => {
    const result = await dispatchRenewal("uuid-renew-1");

    expect(result.status).toBe("processed");
    if (result.status === "processed") {
      expect(result.purchaseId).toBe(PURCHASE_ID);
    }

    // The webhook actually created a brand-new purchase row for this
    // renewal (a real DID_RENEW dispatch, not one that bailed before
    // reaching a purchase at all) — `upsertPurchase` was called and
    // `postProcess` received that purchaseId, which is what makes the
    // assertion below meaningful: the gate skips
    // `maybeCreditConsumablePurchase` (and so its
    // `findPurchaseWithCreditInfo` lookup) entirely for this dispatch,
    // rather than that lookup running and finding nothing to grant.
    expect(drizzleMock.purchaseRepo.upsertPurchase).toHaveBeenCalledOnce();
    expect(
      drizzleMock.purchaseExtRepo.findPurchaseWithCreditInfo,
    ).not.toHaveBeenCalled();

    expect(vi.mocked(grantProductCurrencies)).not.toHaveBeenCalled();
  });
});
