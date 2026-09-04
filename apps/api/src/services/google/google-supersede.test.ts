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

const { drizzleMock, guardStatusWriteMock, TX } = vi.hoisted(() => {
  // The supersede runs guard + expiry write + the caller's outbox emit in
  // ONE transaction, so the mock db must hand out a transaction handle.
  const TX = { __tx: "google-supersede" };
  return {
  TX,
  drizzleMock: {
    db: {
      transaction: vi.fn(
        async (fn: (tx: unknown) => Promise<unknown>) => fn(TX),
      ),
    },
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
  };
});

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
    guardStatusWriteMock.mockResolvedValue({
      apply: true,
      previous: { status: "ACTIVE" },
    });

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

  // ---------------------------------------------------------------------
  // onSuperseded — the seam that keeps `subscription.product_changed`
  // atomic with the retirement that makes the plan change true.
  // ---------------------------------------------------------------------

  test("onSuperseded runs INSIDE the expiry transaction, with that tx handle", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue(
      { id: "pur_old", status: "ACTIVE", productId: "prod_basic" },
    );
    guardStatusWriteMock.mockResolvedValue({
      apply: true,
      previous: { status: "ACTIVE" },
    });
    const onSuperseded = vi.fn(async () => undefined);

    const retired = await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: OLD_TOKEN,
      currentToken: NEW_TOKEN,
      source: "google:SUBSCRIPTION_PURCHASED",
      onSuperseded,
    });

    // The handle it receives must be the TRANSACTION, never the pool: the
    // outbox row has to commit or roll back with the expiry write.
    expect(onSuperseded).toHaveBeenCalledWith(TX, {
      purchaseId: "pur_old",
      productId: "prod_basic",
    });
    expect(retired).toEqual({ purchaseId: "pur_old", productId: "prod_basic" });
  });

  test("onSuperseded is NOT called when the row was already EXPIRED", async () => {
    // A redelivered RTDN. EXPIRED is not terminal, so the guard still
    // applies an EXPIRED -> EXPIRED write — but nothing MOVED, so there is
    // no plan change to announce a second time.
    drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue(
      { id: "pur_old", status: "EXPIRED", productId: "prod_basic" },
    );
    guardStatusWriteMock.mockResolvedValue({
      apply: true,
      previous: { status: "EXPIRED" },
    });
    const onSuperseded = vi.fn(async () => undefined);

    const retired = await expireSupersededGooglePurchase({
      projectId: "proj_1",
      supersededToken: OLD_TOKEN,
      currentToken: NEW_TOKEN,
      source: "google:SUBSCRIPTION_PURCHASED",
      onSuperseded,
    });

    expect(onSuperseded).not.toHaveBeenCalled();
    expect(retired).toBeNull();
    // The idempotent re-write still happens — only the REPORTING narrows.
    expect(drizzleMock.purchaseRepo.updatePurchase).toHaveBeenCalled();
  });
});
