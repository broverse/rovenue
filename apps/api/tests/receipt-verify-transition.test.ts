import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// receipt-verify status-transition guard
//
// Proves a REFUNDED purchase is NOT resurrected to ACTIVE by a
// later Apple receipt verify: `upsertPurchase` is called WITHOUT
// `status` in its update branch, and an audit row is written.
// All `@rovenue/db` repo calls are mocked — no Postgres needed.
// =============================================================

const { drizzleMock, auditMock, googleMocks } = vi.hoisted(() => {
  const auditMock = vi.fn(async () => undefined);
  // Google paid-state gate: the verifier + credential loader are swapped for
  // configurable fns so each test can serve a fixture in any purchase state.
  const googleMocks = {
    verifyGoogleSubscription: vi.fn(),
    verifyGoogleProductPurchase: vi.fn(),
    loadGoogleCredentials: vi.fn(async (): Promise<unknown> => null),
  };
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
  return { drizzleMock, auditMock, googleMocks };
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
  loadGoogleCredentials: googleMocks.loadGoogleCredentials,
}));

vi.mock("../src/services/google/google-verify", () => ({
  verifyGoogleSubscription: googleMocks.verifyGoogleSubscription,
  verifyGoogleProductPurchase: googleMocks.verifyGoogleProductPurchase,
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

// =============================================================
// Google paid-state gate
//
// A Google receipt only proves the purchaseToken exists — the store
// state decides entitlement. PENDING (payment not completed) must be
// rejected with the machine-readable `purchase_not_paid` code and
// persist NOTHING; non-paid states (ON_HOLD, ...) must map through
// the shared RTDN mapper instead of being hardcoded ACTIVE.
// =============================================================

const GOOGLE_CREDS_FIXTURE = {
  packageName: "com.app",
  serviceAccount: { client_email: "svc@x.iam", private_key: "k" },
};

const SUBSCRIPTION_PRODUCT_FIXTURE = {
  id: "prod_gsub",
  type: "SUBSCRIPTION",
  identifier: "com.app.sub",
  storeIds: { google: "com.app.sub" },
  accessIds: [],
};

const CONSUMABLE_PRODUCT_FIXTURE = {
  id: "prod_gcoin",
  type: "CONSUMABLE",
  identifier: "com.app.coins",
  storeIds: { google: "com.app.coins" },
  accessIds: [],
};

function googleSubscriptionFixture(subscriptionState: string) {
  return {
    subscriptionState,
    startTime: "2026-01-01T00:00:00Z",
    lineItems: [
      {
        productId: "com.app.sub",
        expiryTime: "2030-01-01T00:00:00Z",
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  };
}

function verifyGoogle(productId: string) {
  return verifyReceipt({
    projectId: "prj_1",
    store: "PLAY_STORE",
    receipt: "tok_1",
    productId,
    appUserId: "user_1",
  });
}

describe("verifyReceipt — Google subscription paid-state gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleMocks.loadGoogleCredentials.mockResolvedValue(GOOGLE_CREDS_FIXTURE);
    drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
      id: "sub_1",
    });
    drizzleMock.offeringRepo.findProductByIdentifierOrStoreId.mockResolvedValue(
      SUBSCRIPTION_PRODUCT_FIXTURE,
    );
    drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
      null,
    );
    drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({ id: "pur_1" });
  });

  it("rejects a PENDING subscription with 400 purchase_not_paid and persists nothing", async () => {
    googleMocks.verifyGoogleSubscription.mockResolvedValue(
      googleSubscriptionFixture("SUBSCRIPTION_STATE_PENDING"),
    );

    await expect(verifyGoogle("com.app.sub")).rejects.toMatchObject({
      status: 400,
      cause: "purchase_not_paid",
    });
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
  });

  it("writes the mapper's status for ON_HOLD (PAUSED), not hardcoded ACTIVE", async () => {
    googleMocks.verifyGoogleSubscription.mockResolvedValue(
      googleSubscriptionFixture("SUBSCRIPTION_STATE_ON_HOLD"),
    );

    await verifyGoogle("com.app.sub");

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    expect(call).toBeDefined();
    const create = call?.[1]?.create as Record<string, unknown>;
    const update = call?.[1]?.update as Record<string, unknown>;
    expect(create).toHaveProperty("status", "PAUSED");
    expect(update).toHaveProperty("status", "PAUSED");
  });

  it("still activates a paid ACTIVE subscription", async () => {
    googleMocks.verifyGoogleSubscription.mockResolvedValue(
      googleSubscriptionFixture("SUBSCRIPTION_STATE_ACTIVE"),
    );

    await verifyGoogle("com.app.sub");

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    const create = call?.[1]?.create as Record<string, unknown>;
    expect(create).toHaveProperty("status", "ACTIVE");
  });
});

// =============================================================
// Google subscription product binding (ports the Apple check)
//
// `subscriptionsv2.get` is token-only: a valid cheap-subscription
// token paired with an expensive product's id would otherwise
// resolve — and grant — the expensive product. The verified
// `lineItems[].productId` must cover the resolved product, and the
// MATCHING line item (not blindly `lineItems[0]`) must drive
// expiry/autorenew extraction.
// =============================================================

const EXPENSIVE_SUBSCRIPTION_PRODUCT_FIXTURE = {
  id: "prod_gsub_premium",
  type: "SUBSCRIPTION",
  identifier: "com.app.premium",
  storeIds: { google: "com.app.premium" },
  accessIds: [],
};

describe("verifyReceipt — Google subscription product binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleMocks.loadGoogleCredentials.mockResolvedValue(GOOGLE_CREDS_FIXTURE);
    drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
      id: "sub_1",
    });
    drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
      null,
    );
    drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({ id: "pur_1" });
  });

  it("rejects a token whose lineItems do not cover the claimed product — 400, nothing persisted", async () => {
    // The token's lineItems name the cheap sub; the client claimed the
    // expensive one, and the lookup resolved it.
    drizzleMock.offeringRepo.findProductByIdentifierOrStoreId.mockResolvedValue(
      EXPENSIVE_SUBSCRIPTION_PRODUCT_FIXTURE,
    );
    googleMocks.verifyGoogleSubscription.mockResolvedValue(
      googleSubscriptionFixture("SUBSCRIPTION_STATE_ACTIVE"),
    );

    await expect(verifyGoogle("com.app.premium")).rejects.toMatchObject({
      status: 400,
      message: "productId does not match the verified transaction",
    });
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.upsertSubscriber).not.toHaveBeenCalled();
  });

  it("uses the MATCHING line item, not lineItems[0], for expiry/autorenew", async () => {
    drizzleMock.offeringRepo.findProductByIdentifierOrStoreId.mockResolvedValue(
      SUBSCRIPTION_PRODUCT_FIXTURE,
    );
    googleMocks.verifyGoogleSubscription.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      startTime: "2026-01-01T00:00:00Z",
      lineItems: [
        {
          // Some other line of a multi-line subscription — must NOT drive
          // the resolved product's expiry/autorenew.
          productId: "com.app.addon",
          expiryTime: "2027-06-01T00:00:00Z",
          autoRenewingPlan: { autoRenewEnabled: false },
        },
        {
          productId: "com.app.sub",
          expiryTime: "2030-01-01T00:00:00Z",
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    });

    await verifyGoogle("com.app.sub");

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    expect(call).toBeDefined();
    const create = call?.[1]?.create as Record<string, unknown>;
    expect(create).toHaveProperty(
      "expiresDate",
      new Date("2030-01-01T00:00:00Z"),
    );
    expect(create).toHaveProperty("autoRenewStatus", true);
  });
});

describe("verifyReceipt — Google one-time purchaseState gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleMocks.loadGoogleCredentials.mockResolvedValue(GOOGLE_CREDS_FIXTURE);
    drizzleMock.subscriberRepo.upsertSubscriber.mockResolvedValue({
      id: "sub_1",
    });
    drizzleMock.offeringRepo.findProductByIdentifierOrStoreId.mockResolvedValue(
      CONSUMABLE_PRODUCT_FIXTURE,
    );
    drizzleMock.purchaseRepo.upsertPurchase.mockResolvedValue({ id: "pur_1" });
  });

  it("rejects purchaseState PENDING (2) with 400 purchase_not_paid — no row, so no credit grant", async () => {
    googleMocks.verifyGoogleProductPurchase.mockResolvedValue({
      purchaseState: 2,
      purchaseTimeMillis: "1700000000000",
    });

    await expect(verifyGoogle("com.app.coins")).rejects.toMatchObject({
      status: 400,
      cause: "purchase_not_paid",
    });
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
  });

  it("rejects purchaseState CANCELED (1) as an invalid receipt", async () => {
    googleMocks.verifyGoogleProductPurchase.mockResolvedValue({
      purchaseState: 1,
      purchaseTimeMillis: "1700000000000",
    });

    await expect(verifyGoogle("com.app.coins")).rejects.toMatchObject({
      status: 400,
    });
    expect(drizzleMock.purchaseRepo.upsertPurchase).not.toHaveBeenCalled();
  });

  it("accepts purchaseState PURCHASED (0) and writes ACTIVE", async () => {
    googleMocks.verifyGoogleProductPurchase.mockResolvedValue({
      purchaseState: 0,
      purchaseTimeMillis: "1700000000000",
    });

    await verifyGoogle("com.app.coins");

    const call = drizzleMock.purchaseRepo.upsertPurchase.mock.calls[0];
    expect(call).toBeDefined();
    const create = call?.[1]?.create as Record<string, unknown>;
    expect(create).toHaveProperty("status", "ACTIVE");
  });
});
