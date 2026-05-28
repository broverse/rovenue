import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
//
// CONSUMPTION_REQUEST handling threads through several repository
// calls: project lookup (for refund-shield settings), subscriber
// lookup by appAccountToken, purchase lookup as fallback, and
// finally the refund_shield_responses insert. We mock the whole
// `drizzle` namespace from `@rovenue/db` so the test runs in-process
// without Postgres — same approach as the app-account-token suite.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    webhookEventRepo: {
      upsertWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    projectRepo: {
      findProjectById: vi.fn(),
    },
    subscriberRepo: {
      findSubscriberByAppleAppAccountToken: vi.fn(async () => null),
      // Required by resolveSubscriber even though CONSUMPTION_REQUEST
      // never traverses that branch — kept here to satisfy the mock
      // shape so the production code can `drizzle.subscriberRepo.*`
      // without throwing on unrelated handlers.
      upsertSubscriber: vi.fn(),
      createSubscriber: vi.fn(),
      findSubscriberById: vi.fn(async () => null),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(async () => null),
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByOriginalTransaction: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
    refundShieldResponseRepo: {
      insertConsumptionRequest: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: drizzleMock,
  };
});

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

// =============================================================
// System under test
// =============================================================

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

// =============================================================
// Fixtures
// =============================================================

const PROJECT_ID = "prj_test";
const APP_ACCOUNT_TOKEN = "550e8400-e29b-41d4-a716-446655440000";

interface MakeTxOverrides {
  appAccountToken?: string;
  originalTransactionId: string;
  transactionId: string;
}

function makeFakeJwsTransactionPayload(
  overrides: MakeTxOverrides,
): AppleJwsTransactionPayload {
  return {
    transactionId: overrides.transactionId,
    originalTransactionId: overrides.originalTransactionId,
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: 1_700_000_000_000,
    originalPurchaseDate: 1_700_000_000_000,
    expiresDate: 1_700_000_000_000 + 30 * 86_400_000,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    appAccountToken: overrides.appAccountToken,
    inAppOwnershipType: "PURCHASED",
    signedDate: 1_700_000_000_000,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: 9_990_000,
  } satisfies AppleJwsTransactionPayload;
}

function makeConsumptionRequestNotification(
  uuid: string,
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.CONSUMPTION_REQUEST,
    notificationUUID: uuid,
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      signedTransactionInfo: "signed-tx-stub",
      environment: APPLE_ENVIRONMENT.SANDBOX,
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  transaction: AppleJwsTransactionPayload,
  notification: AppleResponseBodyV2DecodedPayload,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => transaction),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("renewal info not used in CONSUMPTION_REQUEST tests");
    }),
  };
}

function makeProjectRow(overrides: {
  refundShieldEnabled: boolean;
  refundShieldResponseDelayMinutes?: number;
}) {
  return {
    id: PROJECT_ID,
    name: "Test",
    description: null,
    appleCredentials: null,
    googleCredentials: null,
    stripeCredentials: null,
    webhookUrl: null,
    webhookSecret: null,
    settings: {},
    refundShieldEnabled: overrides.refundShieldEnabled,
    refundShieldConsentAcknowledgedAt: null,
    refundShieldConsentAcknowledgedBy: null,
    refundShieldResponseDelayMinutes:
      overrides.refundShieldResponseDelayMinutes ?? 60,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  drizzleMock.webhookEventRepo.upsertWebhookEvent.mockResolvedValue({
    id: "wh_1",
    status: "PROCESSING",
  });
});

/**
 * Pull the typed insert payload out of the mock's most recent
 * invocation. Centralises the `!` narrowing so individual tests
 * stay readable.
 */
function lastInsertArgs(): {
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: string;
} {
  const calls = drizzleMock.refundShieldResponseRepo.insertConsumptionRequest
    .mock.calls as unknown as Array<unknown[]>;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("insertConsumptionRequest was never called");
  // [db, input] — index 1 is the input payload.
  return last[1] as never;
}

// =============================================================
// Tests
// =============================================================

describe("handleAppleNotification — CONSUMPTION_REQUEST", () => {
  test("inserts a PENDING refund_shield_responses row when project enabled", async () => {
    drizzleMock.projectRepo.findProjectById.mockResolvedValue(
      makeProjectRow({
        refundShieldEnabled: true,
        refundShieldResponseDelayMinutes: 60,
      }),
    );
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      { id: "sub_1", appleAppAccountToken: APP_ACCOUNT_TOKEN } as never,
    );

    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: APP_ACCOUNT_TOKEN,
        originalTransactionId: "1000000001",
        transactionId: "1000000099",
      }),
      makeConsumptionRequestNotification("uuid-1"),
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result.status).toBe("processed");
    expect(
      drizzleMock.refundShieldResponseRepo.insertConsumptionRequest,
    ).toHaveBeenCalledOnce();
    const insertArgs = lastInsertArgs();
    expect(insertArgs).toMatchObject({
      projectId: PROJECT_ID,
      subscriberId: "sub_1",
      appleNotificationUuid: "uuid-1",
      appleOriginalTransactionId: "1000000001",
      appleTransactionId: "1000000099",
      status: "PENDING",
    });
    expect(
      insertArgs.scheduledFor.getTime() - insertArgs.detectedAt.getTime(),
    ).toBe(60 * 60 * 1000);
  });

  test("inserts SKIPPED_DISABLED when project not enabled", async () => {
    drizzleMock.projectRepo.findProjectById.mockResolvedValue(
      makeProjectRow({ refundShieldEnabled: false }),
    );

    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: APP_ACCOUNT_TOKEN,
        originalTransactionId: "1000000002",
        transactionId: "1000000099",
      }),
      makeConsumptionRequestNotification("uuid-2"),
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    const insertArgs = lastInsertArgs();
    expect(insertArgs.status).toBe("SKIPPED_DISABLED");
    // When disabled, scheduledFor is set to detectedAt (no delay).
    expect(insertArgs.scheduledFor.getTime()).toBe(
      insertArgs.detectedAt.getTime(),
    );
  });

  test("inserts SKIPPED_NOT_FOUND when no subscriber resolves", async () => {
    drizzleMock.projectRepo.findProjectById.mockResolvedValue(
      makeProjectRow({ refundShieldEnabled: true }),
    );
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      null,
    );
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      null,
    );

    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: APP_ACCOUNT_TOKEN,
        originalTransactionId: "9999999999",
        transactionId: "9999999999",
      }),
      makeConsumptionRequestNotification("uuid-3"),
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    const insertArgs = lastInsertArgs();
    expect(insertArgs.status).toBe("SKIPPED_NOT_FOUND");
    expect(insertArgs.subscriberId).toBeNull();
  });

  test("falls back to original_transaction_id lookup when appAccountToken absent", async () => {
    drizzleMock.projectRepo.findProjectById.mockResolvedValue(
      makeProjectRow({ refundShieldEnabled: true }),
    );
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      {
        id: "pur_1",
        subscriberId: "sub_via_purchase",
      } as never,
    );

    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: undefined,
        originalTransactionId: "1000000004",
        transactionId: "1000000099",
      }),
      makeConsumptionRequestNotification("uuid-4"),
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    // Token lookup is skipped entirely when JWS has no appAccountToken.
    expect(
      drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken,
    ).not.toHaveBeenCalled();
    expect(
      drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction,
    ).toHaveBeenCalledOnce();

    const insertArgs = lastInsertArgs();
    expect(insertArgs.status).toBe("PENDING");
    expect(insertArgs.subscriberId).toBe("sub_via_purchase");
  });

  test("is idempotent on duplicate notification UUID", async () => {
    drizzleMock.projectRepo.findProjectById.mockResolvedValue(
      makeProjectRow({ refundShieldEnabled: true }),
    );
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      { id: "sub_1", appleAppAccountToken: APP_ACCOUNT_TOKEN } as never,
    );

    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: APP_ACCOUNT_TOKEN,
        originalTransactionId: "1000000005",
        transactionId: "1000000099",
      }),
      makeConsumptionRequestNotification("uuid-5"),
    );

    // First delivery proceeds normally.
    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    // Second delivery: webhook_events.upsert returns the prior row in
    // PROCESSED state. The handler short-circuits as "duplicate" and
    // never re-invokes the dispatch path → no second insert.
    drizzleMock.webhookEventRepo.upsertWebhookEvent.mockResolvedValueOnce({
      id: "wh_1",
      status: "PROCESSED",
    });
    const result2 = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result2.status).toBe("duplicate");
    expect(
      drizzleMock.refundShieldResponseRepo.insertConsumptionRequest,
    ).toHaveBeenCalledOnce();
  });
});
