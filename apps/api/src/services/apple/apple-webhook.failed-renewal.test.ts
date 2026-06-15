import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// applyFailedRenewal — status mapping (OD-1) + terminal guard
// =============================================================
//
// In-process unit harness (mocks the whole `drizzle` namespace, no
// Postgres). Two things are asserted:
//
//   GAP 2 (OD-1): a DID_FAIL_TO_RENEW WITHOUT the grace-period
//   subtype must still map to GRACE_PERIOD (billing-retry limbo, not
//   ACTIVE). The live path computes status inline in
//   `applyFailedRenewal`, so we assert the status arg handed to the
//   chain updater.
//
//   GAP 1: applyFailedRenewal routes through the guarded chain
//   updater `updateChainStatusGuarded` (which carries the
//   "never resurrect a terminal row" predicate), NOT the unguarded
//   `updatePurchasesByOriginalTransaction`.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    purchaseRepo: {
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
      updateChainStatusGuarded: vi.fn(async () => ({
        updatedIds: [] as string[],
        skippedTerminalIds: [] as string[],
      })),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    // Real schema so the transitively-imported audit lib loads; only
    // the repo namespaces the failed-renewal path touches are mocked.
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsRenewalInfoPayload,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

const PROJECT_ID = "prj_fr_test";

function makeTransaction(): AppleJwsTransactionPayload {
  return {
    transactionId: "txn_fr_1",
    originalTransactionId: "otxn_fr_1",
    productId: "premium_monthly",
    purchaseDate: 1_700_000_000_000,
    originalPurchaseDate: 1_700_000_000_000,
    expiresDate: 1_900_000_000_000,
    signedDate: 1_700_000_000_000,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    currency: "USD",
    price: 9_990_000,
  } as AppleJwsTransactionPayload;
}

function makeFailedRenewalNotification(opts: {
  grace: boolean;
}): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW,
    ...(opts.grace
      ? { subtype: APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD }
      : {}),
    notificationUUID: opts.grace ? "uuid-fr-grace" : "uuid-fr-nograce",
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-tx-jws",
      signedRenewalInfo: "stub-renewal-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  notification: AppleResponseBodyV2DecodedPayload,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => makeTransaction()),
    verifyRenewalInfo: vi.fn(
      async () =>
        ({
          originalTransactionId: "otxn_fr_1",
          productId: "premium_monthly",
          autoRenewStatus: 0,
          signedDate: 1_700_000_000_000,
          environment: APPLE_ENVIRONMENT.SANDBOX,
        }) as AppleJwsRenewalInfoPayload,
    ),
  };
}

function lastGuardedChainPatch(): { status: string } {
  const calls = drizzleMock.purchaseRepo.updateChainStatusGuarded.mock
    .calls as unknown as Array<unknown[]>;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("updateChainStatusGuarded was never called");
  // (db, projectId, originalTransactionId, patch) — index 3 is patch.
  return last[3] as { status: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    id: "wh_fr",
    status: "PROCESSING",
  });
});

describe("applyFailedRenewal — status mapping + terminal guard", () => {
  test("non-grace DID_FAIL_TO_RENEW maps to GRACE_PERIOD (OD-1)", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(
        makeFailedRenewalNotification({ grace: false }),
      ),
    });

    expect(result.status).toBe("processed");
    // Routes through the GUARDED chain updater (GAP 1) ...
    expect(
      drizzleMock.purchaseRepo.updateChainStatusGuarded,
    ).toHaveBeenCalledOnce();
    expect(
      drizzleMock.purchaseRepo.updatePurchasesByOriginalTransaction,
    ).not.toHaveBeenCalled();
    // ... with GRACE_PERIOD even though the grace subtype is absent.
    expect(lastGuardedChainPatch().status).toBe("GRACE_PERIOD");
  });

  test("grace-subtype DID_FAIL_TO_RENEW also maps to GRACE_PERIOD", async () => {
    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(
        makeFailedRenewalNotification({ grace: true }),
      ),
    });

    expect(lastGuardedChainPatch().status).toBe("GRACE_PERIOD");
  });
});
