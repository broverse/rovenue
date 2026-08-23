import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// expireSupersededGooglePurchase — linkedPurchaseToken handling
// =============================================================
//
// On upgrade/downgrade Google issues a NEW token and references the
// retired one via linkedPurchaseToken — with no independent RTDN for the
// old token. The old row must be expired and its access revoked, or the
// access engine's union keeps the old tier granted until its frozen
// expiresDate lapses (a full billing period of misgranted entitlement
// after a downgrade).
// =============================================================

const { drizzleMock, guardStatusWriteMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {},
    purchaseExtRepo: {
      findPurchaseByStoreTransaction: vi.fn(),
    },
    purchaseRepo: {
      updatePurchase: vi.fn(async () => undefined),
    },
    accessRepo: {
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
  },
  guardStatusWriteMock: vi.fn(),
}));

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, drizzle: { ...actual.drizzle, ...drizzleMock } };
});

vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: guardStatusWriteMock,
}));

import { expireSupersededGooglePurchase } from "./google-supersede";

const OLD_TOKEN = "old-token-abcdefghijklmnop";
const NEW_TOKEN = "new-token-abcdefghijklmnop";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("expireSupersededGooglePurchase", () => {
  test("expires the old token's row and revokes its access", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue(
      { id: "pur_old", status: "ACTIVE" },
    );
    guardStatusWriteMock.mockResolvedValue({ apply: true });

    await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: OLD_TOKEN,
      currentToken: NEW_TOKEN,
      source: "google:SUBSCRIPTION_PURCHASED",
    });

    expect(guardStatusWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeTransactionId: OLD_TOKEN,
        to: "EXPIRED",
      }),
    );
    expect(drizzleMock.purchaseRepo.updatePurchase).toHaveBeenCalledWith(
      expect.anything(),
      "pur_old",
      expect.objectContaining({
        status: "EXPIRED",
        autoRenewStatus: false,
        expiresDate: expect.any(Date),
      }),
    );
    expect(drizzleMock.accessRepo.revokeAccessByPurchaseId).toHaveBeenCalledWith(
      expect.anything(),
      "pur_old",
    );
  });

  test("terminal old row: guard withholds the status write but access is still revoked (idempotent)", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue(
      { id: "pur_refunded", status: "REFUNDED" },
    );
    guardStatusWriteMock.mockResolvedValue({ apply: false });

    await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: OLD_TOKEN,
      currentToken: NEW_TOKEN,
      source: "google:SUBSCRIPTION_PURCHASED",
    });

    expect(drizzleMock.purchaseRepo.updatePurchase).not.toHaveBeenCalled();
    expect(drizzleMock.accessRepo.revokeAccessByPurchaseId).toHaveBeenCalledWith(
      expect.anything(),
      "pur_refunded",
    );
  });

  test("no row for the old token: no-op", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue(
      null,
    );

    await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: OLD_TOKEN,
      currentToken: NEW_TOKEN,
      source: "receipt-verify",
    });

    expect(guardStatusWriteMock).not.toHaveBeenCalled();
    expect(drizzleMock.accessRepo.revokeAccessByPurchaseId).not.toHaveBeenCalled();
  });

  test("self-reference guard: linked token equal to the current token is ignored", async () => {
    await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: NEW_TOKEN,
      currentToken: NEW_TOKEN,
      source: "google:SUBSCRIPTION_PURCHASED",
    });

    expect(
      drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction,
    ).not.toHaveBeenCalled();
  });
});
