import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
//
// REFUND_REVERSED must not only compensate analytics — it must
// RESTORE the purchase row a prior REFUND put into the terminal
// REFUNDED state (status + cleared refundDate), so the post-
// processing `syncAccess` can re-grant entitlement. We mock the
// whole `drizzle` namespace from `@rovenue/db` so the test runs
// in-process without Postgres — same approach as the refund-shield
// suite. `guardStatusWrite` itself runs REAL (it reads through the
// mocked `lockPurchaseStatusByStoreTransaction`), so these tests
// exercise the actual state-machine exception, not a stub of it.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    // Guarded write paths run inside db.transaction(...).
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    projectRepo: {
      findProjectById: vi.fn(),
    },
    subscriberRepo: {
      findSubscriberByAppleAppAccountToken: vi.fn(async () => null),
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
      lockPurchaseStatusByStoreTransaction: vi.fn(async () => null),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByOriginalTransaction: vi.fn(async () => undefined),
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
    refundShieldResponseRepo: {
      insertConsumptionRequest: vi.fn(async () => true),
      updateOutcomeByOriginalTransactionIdIfNull: vi.fn(async () => true),
      updateOutcomeByOriginalTransactionIdOverwrite: vi.fn(
        async () => undefined,
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
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

// The transition guard writes a `subscription.transition_rejected`
// audit row when it withholds a status write (e.g. the REVOKED
// non-resurrection test below). The real audit lib would run a
// Drizzle insert against our stub db, so replace it with a spy.
vi.mock("../../lib/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

// =============================================================
// System under test
// =============================================================

import { handleAppleNotification } from "./apple-webhook";
import { audit } from "../../lib/audit";
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
const PURCHASE_ID = "pur_rev";
const SUBSCRIBER_ID = "sub_rev";
const PRODUCT_ID = "prod_rev";
const ORIGINAL_TRANSACTION_ID = "2000000010";
const TRANSACTION_ID = "2000000099";
const PRICE_MICROS = 9_990_000;
const DAY_MS = 86_400_000;
// Fixed fixture epoch (Nov 2023) — comfortably in the past, so a
// "past expiry" derived from it stays past no matter when the suite
// runs, while "future expiry" is derived from Date.now() instead.
const FIXED_SIGNED_DATE_MS = 1_700_000_000_000;
const PAST_EXPIRES_MS = FIXED_SIGNED_DATE_MS + 30 * DAY_MS;
const FUTURE_EXPIRES_MS = () => Date.now() + 30 * DAY_MS;

function makeFakeJwsTransactionPayload(overrides: {
  /** null = omit the field entirely (lifetime non-consumable). */
  expiresDate: number | null;
}): AppleJwsTransactionPayload {
  return {
    transactionId: TRANSACTION_ID,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: FIXED_SIGNED_DATE_MS,
    originalPurchaseDate: FIXED_SIGNED_DATE_MS,
    ...(overrides.expiresDate === null
      ? {}
      : { expiresDate: overrides.expiresDate }),
    quantity: 1,
    type: "Auto-Renewable Subscription",
    appAccountToken: APP_ACCOUNT_TOKEN,
    inAppOwnershipType: "PURCHASED",
    signedDate: FIXED_SIGNED_DATE_MS,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: PRICE_MICROS,
  } satisfies AppleJwsTransactionPayload;
}

function makeNotification(
  type:
    | typeof APPLE_NOTIFICATION_TYPE.REFUND
    | typeof APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
  uuid: string,
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: type,
    notificationUUID: uuid,
    version: "2.0",
    signedDate: FIXED_SIGNED_DATE_MS,
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
      throw new Error("renewal info not used in these tests");
    }),
  };
}

/** Seed a resolvable purchase + subscriber + lockable status row. */
function seedPurchase(currentStatus: "REFUNDED" | "REVOKED" | "ACTIVE") {
  drizzleMock.purchaseExtRepo.findPurchaseByStoreTransaction.mockResolvedValue({
    id: PURCHASE_ID,
    subscriberId: SUBSCRIBER_ID,
    productId: PRODUCT_ID,
    status: currentStatus,
  } as never);
  drizzleMock.subscriberRepo.findSubscriberById.mockResolvedValue({
    id: SUBSCRIBER_ID,
  } as never);
  drizzleMock.purchaseRepo.lockPurchaseStatusByStoreTransaction.mockResolvedValue(
    { id: PURCHASE_ID, status: currentStatus } as never,
  );
}

async function dispatchNotification(
  type:
    | typeof APPLE_NOTIFICATION_TYPE.REFUND
    | typeof APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
  uuid: string,
  expiresDate: number | null,
) {
  const verifier = makeStubVerifier(
    makeFakeJwsTransactionPayload({ expiresDate }),
    makeNotification(type, uuid),
  );
  return handleAppleNotification({
    projectId: PROJECT_ID,
    signedPayload: "signed-envelope-stub",
    verifier,
  });
}

/** [db, id, patch, opts] of the most recent updatePurchase call. */
function lastUpdatePurchaseArgs(): {
  id: string;
  patch: Record<string, unknown>;
  opts: { guardTerminalStatus?: boolean } | undefined;
} {
  const calls = drizzleMock.purchaseRepo.updatePurchase.mock
    .calls as unknown as Array<unknown[]>;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("updatePurchase was never called");
  return {
    id: last[1] as string,
    patch: last[2] as Record<string, unknown>,
    opts: last[3] as { guardTerminalStatus?: boolean } | undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    outcome: "claimed",
    row: { id: "wh_1", status: "PROCESSING" },
  });
});

// =============================================================
// Tests
// =============================================================

describe("handleAppleNotification — REFUND_REVERSED restores the purchase", () => {
  test("future expiresDate: REFUNDED purchase returns to ACTIVE with refundDate cleared", async () => {
    seedPurchase("REFUNDED");

    const result = await dispatchNotification(
      APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
      "uuid-rr-1",
      FUTURE_EXPIRES_MS(),
    );

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.updatePurchase).toHaveBeenCalledOnce();
    const { id, patch, opts } = lastUpdatePurchaseArgs();
    expect(id).toBe(PURCHASE_ID);
    // ACTIVE is access-granting, so the post-processing syncAccess
    // pass re-grants entitlement off this status (access-engine has
    // its own coverage for ACCESS_GRANTING_STATUSES).
    expect(patch).toMatchObject({ status: "ACTIVE", refundDate: null });
    // The SQL-level terminal CASE guard must be explicitly bypassed
    // for this one write, or REFUNDED would silently survive.
    expect(opts).toMatchObject({ guardTerminalStatus: false });
    // The compensating REACTIVATION revenue emission must be kept.
    expect(
      drizzleMock.revenueEventRepo.createRevenueEvent,
    ).toHaveBeenCalledOnce();
  });

  test("absent expiresDate (lifetime non-consumable): restores to ACTIVE", async () => {
    seedPurchase("REFUNDED");

    const result = await dispatchNotification(
      APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
      "uuid-rr-2",
      null,
    );

    expect(result.status).toBe("processed");
    const { patch } = lastUpdatePurchaseArgs();
    expect(patch).toMatchObject({ status: "ACTIVE", refundDate: null });
  });

  test("past expiresDate: restores to EXPIRED and grants no access", async () => {
    seedPurchase("REFUNDED");

    const result = await dispatchNotification(
      APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
      "uuid-rr-3",
      PAST_EXPIRES_MS,
    );

    expect(result.status).toBe("processed");
    const { patch } = lastUpdatePurchaseArgs();
    expect(patch).toMatchObject({ status: "EXPIRED", refundDate: null });
    // EXPIRED is not access-granting — nothing may grant access here.
    expect(drizzleMock.accessRepo.createAccess).not.toHaveBeenCalled();
    expect(
      drizzleMock.accessRepo.setAccessActiveAndExpiry,
    ).not.toHaveBeenCalled();
  });

  test("does NOT resurrect a REVOKED purchase (exception is scoped to REFUNDED)", async () => {
    seedPurchase("REVOKED");

    const result = await dispatchNotification(
      APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
      "uuid-rr-4",
      FUTURE_EXPIRES_MS(),
    );

    expect(result.status).toBe("processed");
    // The status write is withheld (REVOKED is not in the allow list);
    // only the refundDate clear may go through.
    expect(drizzleMock.purchaseRepo.updatePurchase).toHaveBeenCalledOnce();
    const { patch } = lastUpdatePurchaseArgs();
    expect(patch).not.toHaveProperty("status");
    expect(patch).toMatchObject({ refundDate: null });
    // The withheld transition is tamper-evidently recorded.
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscription.transition_rejected",
      }),
      expect.anything(),
    );
  });

  test("forward guard intact: a REFUND after the reversal still lands REFUNDED", async () => {
    // Post-reversal state: the purchase is ACTIVE again. A customer
    // can re-refund — the ordinary REFUND path must keep working.
    seedPurchase("ACTIVE");

    const result = await dispatchNotification(
      APPLE_NOTIFICATION_TYPE.REFUND,
      "uuid-rr-5",
      FUTURE_EXPIRES_MS(),
    );

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.updatePurchase).toHaveBeenCalledOnce();
    const { patch } = lastUpdatePurchaseArgs();
    expect(patch).toMatchObject({ status: "REFUNDED" });
    expect(patch.refundDate).toBeInstanceOf(Date);
    expect(
      drizzleMock.accessRepo.revokeAccessByPurchaseId,
    ).toHaveBeenCalledOnce();
  });
});
