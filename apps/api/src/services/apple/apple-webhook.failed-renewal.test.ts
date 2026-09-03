import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// applyFailedRenewal — status mapping (OD-1) + terminal guard
// =============================================================
//
// In-process unit harness (mocks the whole `drizzle` namespace, no
// Postgres). Asserted:
//
//   GAP 2 (OD-1), revised by Task 4 (2026-09-04): a DID_FAIL_TO_RENEW
//   WITHOUT the grace-period subtype now maps to BILLING_ISSUE, not
//   GRACE_PERIOD — Apple only keeps access DURING the retry when an
//   app-configured grace period is present (the GRACE_PERIOD subtype);
//   without it Apple has already withdrawn access on its side. The live
//   path computes status inline in `applyFailedRenewal`, so we assert the
//   status arg handed to the chain updater.
//
//   GAP 1: applyFailedRenewal routes through the guarded chain
//   updater `updateChainStatusGuarded` (which carries the
//   "never resurrect a terminal row" predicate), NOT the unguarded
//   `updatePurchasesByOriginalTransaction`.
//
//   Task 4: `billingIssueDetectedAt` is stamped on entry into
//   BILLING_ISSUE and left alone on a repeated signal.
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
    purchaseExtRepo: {
      // applyFailedRenewal reads the chain's current row to compute
      // billingIssueStamp's `from` (the chain-wide write has no single
      // `from` of its own — see guardedChainStatusWrite's docstring).
      // Default: no prior row, i.e. first sighting of this chain.
      findPurchaseByOriginalTransaction: vi.fn(
        async (): Promise<{ status: string } | null> => null,
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

function lastGuardedChainPatch(): {
  status: string;
  billingIssueDetectedAt?: Date | null;
} {
  const calls = drizzleMock.purchaseRepo.updateChainStatusGuarded.mock
    .calls as unknown as Array<unknown[]>;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("updateChainStatusGuarded was never called");
  // (db, projectId, originalTransactionId, patch) — index 3 is patch.
  return last[3] as { status: string; billingIssueDetectedAt?: Date | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    outcome: "claimed",
    row: { id: "wh_fr", status: "PROCESSING" },
  });
});

describe("applyFailedRenewal — status mapping + terminal guard", () => {
  // Task 4 (2026-09-04): a non-grace DID_FAIL_TO_RENEW used to map to
  // GRACE_PERIOD (the OD-1 choice) — that granted entitlement Apple itself
  // had already withdrawn (Apple only keeps access DURING the retry when
  // an app-configured grace period is present; that is exactly the GRACE_PERIOD
  // subtype). It now routes to BILLING_ISSUE instead.
  test("non-grace DID_FAIL_TO_RENEW maps to BILLING_ISSUE", async () => {
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
    // ... with BILLING_ISSUE since the grace subtype is absent.
    expect(lastGuardedChainPatch().status).toBe("BILLING_ISSUE");
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

  // billingIssueStamp: entry vs. repeat, using the chain's current row
  // (purchaseExtRepo.findPurchaseByOriginalTransaction) as `from`.
  test("stamps billingIssueDetectedAt on entry into BILLING_ISSUE", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValueOnce(
      { status: "ACTIVE" },
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(
        makeFailedRenewalNotification({ grace: false }),
      ),
    });

    const patch = lastGuardedChainPatch();
    expect(patch.status).toBe("BILLING_ISSUE");
    expect(patch.billingIssueDetectedAt).toEqual(new Date(1_700_000_000_000));
  });

  test("does not reset billingIssueDetectedAt on a repeated BILLING_ISSUE signal", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValueOnce(
      { status: "BILLING_ISSUE" },
    );

    await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(
        makeFailedRenewalNotification({ grace: false }),
      ),
    });

    const patch = lastGuardedChainPatch();
    expect(patch.status).toBe("BILLING_ISSUE");
    expect(patch.billingIssueDetectedAt).toBeUndefined();
  });
});
