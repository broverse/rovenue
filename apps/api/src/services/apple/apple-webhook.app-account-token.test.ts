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
  const db: Record<string, unknown> = {
    // FINDING 1: guarded write paths now run inside db.transaction(...).
    // Run the callback inline with the same stub so the mocked repos
    // still receive the calls.
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
      createSubscriber: vi.fn(),
      findSubscriberById: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
      findSubscriberByAppleAppAccountToken: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(),
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
      updatePurchase: vi.fn(async () => undefined),
      lockPurchaseStatusByStoreTransaction: vi.fn(async () => null),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
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
    // Expose the real schema so the transitively-imported audit lib
    // (`drizzle.schema.auditLogs`) loads; only the repo namespaces
    // used by the handler are swapped for our mock.
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
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
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

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
    bundleId: "com.example.app",
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
    outcome: "claimed",
    row: { id: "wh_1", status: "PROCESSING" },
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

describe("handleAppleNotification — appAccountToken-first subscriber resolution", () => {
  test("resolves the existing subscriber bound to the appAccountToken (no fabrication)", async () => {
    // RC/Adapty model: the appAccountToken is the cross-path join key.
    // When a subscriber already carries it (e.g. set by the receipt path
    // from the JWS), the webhook MUST resolve to that row — never mint a
    // new subscriber keyed by the token (the old rovenueId=token bug).
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      { id: "sub_real", appUserId: "rov_device", appleAppAccountToken: ACCOUNT_TOKEN },
    );
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
      drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken,
    ).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, ACCOUNT_TOKEN);
    // Never fabricate a parallel identity for an already-bound token.
    expect(drizzleMock.subscriberRepo.upsertSubscriber).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.createSubscriber).not.toHaveBeenCalled();
  });

  test("anchors on originalTransactionId when token has no binding yet", async () => {
    // Token present but unbound (no column hit). Fall back to the store
    // transaction anchor: whoever already owns this originalTransactionId
    // (e.g. the receipt-created subscriber) is the canonical owner.
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      null,
    );
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      { id: "pur_x", subscriberId: "sub_receipt" },
    );
    drizzleMock.subscriberRepo.findSubscriberById.mockResolvedValue({
      id: "sub_receipt",
      appUserId: "rov_device",
      appleAppAccountToken: null,
    });
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: ACCOUNT_TOKEN,
        originalTransactionId: "1000000001",
        productId: "premium_monthly",
      }),
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result.status).toBe("processed");
    expect(drizzleMock.subscriberRepo.findSubscriberById).toHaveBeenCalledWith(
      expect.anything(),
      "sub_receipt",
    );
    // Resolved an existing owner → no new row.
    expect(drizzleMock.subscriberRepo.upsertSubscriber).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.createSubscriber).not.toHaveBeenCalled();
  });

  test("first sighting (webhook-first) creates a synthetic keyed by the transaction anchor, carrying the token", async () => {
    // No token binding, no existing purchase → genuinely first sighting.
    // Key the row by the STABLE transaction anchor (apple:<originalTx>),
    // NOT by the appAccountToken, and stash the token in its column so a
    // later receipt converges onto this row.
    drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken.mockResolvedValue(
      null,
    );
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      null,
    );
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: ACCOUNT_TOKEN,
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
    expect(drizzleMock.subscriberRepo.upsertSubscriber).toHaveBeenCalledOnce();
    const upsertArgs =
      drizzleMock.subscriberRepo.upsertSubscriber.mock.calls[0]![1];
    expect(upsertArgs).toMatchObject({
      projectId: PROJECT_ID,
      rovenueId: "apple:1000000002",
      appleAppAccountToken: ACCOUNT_TOKEN,
    });
    // The token is NEVER used as the rovenueId / appUserId identity.
    expect(upsertArgs.rovenueId).not.toBe(ACCOUNT_TOKEN);
  });

  test("no JWS token: never forges one; keys the synthetic by the transaction anchor", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      null,
    );
    const verifier = makeStubVerifier(
      makeFakeJwsTransactionPayload({
        appAccountToken: undefined,
        originalTransactionId: "1000000003",
        productId: "premium_monthly",
      }),
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier,
    });

    expect(result.status).toBe("processed");
    // Token lookup is skipped when Apple omits the claim.
    expect(
      drizzleMock.subscriberRepo.findSubscriberByAppleAppAccountToken,
    ).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.upsertSubscriber).toHaveBeenCalledOnce();
    const upsertArgs =
      drizzleMock.subscriberRepo.upsertSubscriber.mock.calls[0]![1];
    expect(upsertArgs).toMatchObject({ rovenueId: "apple:1000000003" });
    // appleAppAccountToken must be null/absent — never invented.
    expect(upsertArgs.appleAppAccountToken ?? null).toBeNull();
  });
});
