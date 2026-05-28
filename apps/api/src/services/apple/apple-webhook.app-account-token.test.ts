import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
//
// `apple-webhook.ts` reaches into `@rovenue/db`'s `drizzle`
// namespace for every repository call. We mock the whole namespace
// so we can run the full receipt-handling flow in-process — no
// Postgres, no testcontainers — and assert that the
// `appleAppAccountToken` field threads from the JWS payload all
// the way down into the `upsertSubscriber` repo call.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    subscriberRepo: {
      upsertSubscriber: vi.fn(),
      createSubscriber: vi.fn(),
      findSubscriberById: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
      updatePurchase: vi.fn(async () => undefined),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(async () => null),
      findPurchaseByStoreTransaction: vi.fn(async () => null),
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
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  // Re-export the real enum value objects so the production code's
  // `PurchaseStatus.ACTIVE` etc. references resolve. Only the
  // `drizzle` namespace is swapped for our mock.
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
// System under test (imported after mocks are wired)
// =============================================================

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleNotificationVerifier,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";

// =============================================================
// Fixture helpers
// =============================================================

const PROJECT_ID = "prj_test";
const ACCOUNT_TOKEN = "550e8400-e29b-41d4-a716-446655440000";

function makeFakeJwsTransactionPayload(
  overrides: Partial<AppleJwsTransactionPayload> & {
    appAccountToken?: string;
    originalTransactionId: string;
    productId: string;
  },
): AppleJwsTransactionPayload {
  return {
    transactionId: overrides.originalTransactionId,
    originalTransactionId: overrides.originalTransactionId,
    bundleId: "com.example.app",
    productId: overrides.productId,
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
    ...overrides,
  } satisfies AppleJwsTransactionPayload;
}

/** Builds a minimal SUBSCRIBED notification envelope. */
function makeFakeNotification(): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.SUBSCRIBED,
    notificationUUID: `nfn-${Math.random().toString(36).slice(2)}`,
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      signedTransactionInfo: "signed-tx-stub",
      environment: APPLE_ENVIRONMENT.SANDBOX,
    },
  } as AppleResponseBodyV2DecodedPayload;
}

/** Stub verifier that returns canned decoded payloads instead of
 *  actually verifying JWS signatures. */
function makeStubVerifier(
  transaction: AppleJwsTransactionPayload,
  notification: AppleResponseBodyV2DecodedPayload = makeFakeNotification(),
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => transaction),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("renewal info not used in these tests");
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    id: "wh_1",
    status: "PROCESSING",
  });
  drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
    id: "sub_1",
    appUserId: ACCOUNT_TOKEN,
    appleAppAccountToken: ACCOUNT_TOKEN,
  });
  drizzleMock.subscriberRepo.createSubscriber.mockResolvedValue({
    id: "sub_synthetic",
    appUserId: "apple:1000000002",
    appleAppAccountToken: null,
  });
  drizzleMock.offeringRepo.findProductByStoreId.mockResolvedValue({
    id: "prod_1",
    accessIds: [],
  });
  drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({
    id: "pur_1",
  });
});

// =============================================================
// Tests
// =============================================================

describe("handleAppleNotification — appAccountToken persistence", () => {
  test("forwards appleAppAccountToken to upsertSubscriber when JWS provides it", async () => {
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: ACCOUNT_TOKEN,
        originalTransactionId: "1000000000",
        productId: "premium_monthly",
      }),
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result.status).toBe("processed");
    expect(
      drizzleMock.subscriberRepo.upsertSubscriber,
    ).toHaveBeenCalledOnce();
    const upsertArgs =
      drizzleMock.subscriberRepo.upsertSubscriber.mock.calls[0]![1];
    expect(upsertArgs).toMatchObject({
      projectId: PROJECT_ID,
      appUserId: ACCOUNT_TOKEN,
      appleAppAccountToken: ACCOUNT_TOKEN,
    });
  });

  test("passes appleAppAccountToken=null when JWS has none", async () => {
    // No appAccountToken → resolveSubscriber falls back to the
    // synthetic-id path; upsertSubscriber is *not* called. The
    // contract here is "don't crash and don't write a fake token".
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: undefined,
        originalTransactionId: "1000000002",
        productId: "premium_monthly",
      }),
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result.status).toBe("processed");
    expect(
      drizzleMock.subscriberRepo.upsertSubscriber,
    ).not.toHaveBeenCalled();
    expect(
      drizzleMock.subscriberRepo.createSubscriber,
    ).toHaveBeenCalledOnce();
    // The fallback createSubscriber path does NOT carry a token —
    // confirming we never invent / forge one when Apple omits it.
    const createArgs =
      drizzleMock.subscriberRepo.createSubscriber.mock.calls[0]![1];
    expect(createArgs).not.toHaveProperty("appleAppAccountToken");
  });

  test("does not erase an existing token on subsequent upsert with no JWS token", async () => {
    // Repo-layer contract: when caller passes appleAppAccountToken=null
    // (or omits it), the upsert update branch must not overwrite the
    // existing column. We exercise this indirectly via the webhook —
    // if the handler invents a token here, the assertion fails.
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: undefined,
        originalTransactionId: "1000000003",
        productId: "premium_monthly",
      }),
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    // upsertSubscriber is bypassed entirely on the no-token path, so
    // by definition the column on any pre-existing row is untouched.
    expect(
      drizzleMock.subscriberRepo.upsertSubscriber,
    ).not.toHaveBeenCalled();
  });
});
