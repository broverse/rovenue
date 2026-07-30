import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// receipt-verify status-transition guard
//
// Proves a REFUNDED purchase is NOT resurrected to ACTIVE by a
// later Apple receipt verify: `upsertPurchase` is called WITHOUT
// `status` in its update branch, and an audit row is written.
// All `@rovenue/db` repo calls are mocked — no Postgres needed.
// =============================================================

const { drizzleMock, auditMock } = vi.hoisted(() => {
  const auditMock = vi.fn(async () => undefined);
  // FINDING 1: verifyReceipt runs the guard + upsert inside
  // db.transaction(...). Run the callback inline with the same stub.
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    subscriberRepo: {
      findSubscriberById: vi.fn(async () => ({ id: "sub_1", projectId: "proj_1" })),
      findSubscriberByAppleAppAccountToken: vi.fn(async () => null),
      setAppleAppAccountToken: vi.fn(async () => undefined),
      clearAppleAppAccountToken: vi.fn(async () => undefined),
      upsertSubscriber: vi.fn(async () => ({ id: "sub_1" })),
    },
    offeringRepo: {
      findProductByIdentifierOrStoreId: vi.fn(async () => ({
        id: "prod_1",
        accessIds: [],
        // verifyAppleReceipt refuses to grant a product that does not
        // correspond to the verified transaction — otherwise a valid cheap
        // receipt could be paired with an expensive product identifier. The
        // fixture predated that guard and carried neither an Apple store id
        // nor an identifier, so the comparison failed and every call 400'd
        // before reaching the status-transition logic under test.
        identifier: "com.app.pro",
        storeIds: { apple: "com.app.pro" },
      })),
    },
    // receipt-verify serialises concurrent verifications of the same
    // transaction with a transaction-scoped advisory lock before touching
    // purchase state. The mock had no lockRepo, so the call blew up on
    // `undefined.advisoryXactLock2` once the product guard above stopped
    // short-circuiting the request.
    lockRepo: {
      advisoryXactLock2: vi.fn(async () => undefined),
    },
    // Receipt verification resolves the subscriber the RC/Adapty way: the
    // Apple originalTransactionId is the anchor and appAccountToken is the
    // binding, so the lookup goes through purchaseExtRepo and the token
    // helpers below. None of it existed when this mock was written; each
    // missing member surfaced one at a time as
    // "Cannot read properties of undefined".
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(async () => null),
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      lockPurchaseStatusByStoreTransaction: vi.fn(),
      upsertPurchase: vi.fn(async () => ({ id: "pur_1" })),
    },
    // R6: the receipt path now records revenue idempotently.
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => ({ id: "rev_1" })),
    },
  };
  return { drizzleMock, auditMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, drizzle: drizzleMock };
});

vi.mock("../src/lib/audit", () => ({ audit: auditMock }));

// Stub the Apple verifier so verifyTransaction returns a fixed
// ACTIVE-resolving transaction without any crypto / network.
vi.mock("../src/services/apple/apple-verify", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/apple/apple-verify")
  >("../src/services/apple/apple-verify");
  return {
    ...actual,
    JoseAppleNotificationVerifier: class {
      async verifyTransaction() {
        return {
          transactionId: "txn_1",
          originalTransactionId: "otxn_1",
          productId: "com.app.pro",
          purchaseDate: 1_700_000_000_000,
          originalPurchaseDate: 1_700_000_000_000,
          expiresDate: 1_800_000_000_000,
          price: 9_990_000,
          currency: "USD",
          environment: "Production",
        };
      }
    },
  };
});

vi.mock("../src/lib/project-credentials", () => ({
  loadAppleCredentials: vi.fn(async () => null),
  loadGoogleCredentials: vi.fn(async () => null),
}));

vi.mock("../src/lib/circuit-breaker", () => ({
  appleCircuit: { exec: (fn: () => unknown) => fn(), state: "CLOSED" },
  googleCircuit: { exec: (fn: () => unknown) => fn(), state: "CLOSED" },
}));

import { verifyReceipt } from "../src/services/receipt-verify";

describe("verifyReceipt — status transition guard (Apple)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
      id: "sub_1",
    });
    drizzleMock.offeringRepo.findProductByIdentifierOrStoreId.mockResolvedValue({
      id: "prod_1",
      accessIds: [],
      identifier: "com.app.pro",
      storeIds: { apple: "com.app.pro" },
    });
    drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({ id: "pur_1" });
  });

  it("does NOT write status when the existing purchase is REFUNDED, and audits", async () => {
    drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
      { id: "pur_1", status: "REFUNDED" },
    );

    await verifyReceipt({
      projectId: "prj_1",
      store: "APP_STORE",
      receipt: "signed-jws",
      productId: "com.app.pro",
      appUserId: "user_1",
    });

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    expect(call).toBeDefined();
    const update = call?.[1]?.update as Record<string, unknown>;
    expect(update).not.toHaveProperty("status");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "subscription.transition_rejected",
      resource: "purchase",
    });
  });

  it("writes status when no prior row exists (first insert)", async () => {
    drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
      null,
    );

    await verifyReceipt({
      projectId: "prj_1",
      store: "APP_STORE",
      receipt: "signed-jws",
      productId: "com.app.pro",
      appUserId: "user_1",
    });

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    const update = call?.[1]?.update as Record<string, unknown>;
    expect(update).toHaveProperty("status", "ACTIVE");
    expect(auditMock).not.toHaveBeenCalled();
  });
});
