import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_ENVIRONMENT,
  APPLE_OFFER_TYPE,
  APPLE_OWNERSHIP_TYPE,
  APPLE_TRANSACTION_TYPE,
  type AppleJwsTransactionPayload,
} from "../../src/services/apple/apple-types";
import { APPLE_SUBSCRIPTION_STATUS } from "../../src/services/apple/apple-server-api";
import { GOOGLE_SUBSCRIPTION_STATE } from "../../src/services/google/google-types";
import { PurchaseStatus } from "@rovenue/db";

// =============================================================
// verify-store-clients.ts — the REAL production functions (Task 9,
// fix round 2 FIX A)
// =============================================================
//
// Round 1's Google line-item fix and Apple TRIAL fix both live here, and
// NO test executed either: import-verify.integration.test.ts fakes
// `verifyGoogleAnchor`/`verifyAppleAnchor` at the `ImportVerifyDeps`
// boundary, so this file's real bodies were never called by the suite —
// exactly the gap that let the round-1 Critical through.
//
// This file calls the REAL `verifyGoogleAnchor` / `verifyAppleAnchor`
// (via `createProductionImportVerifyDeps()`) and fakes ONE LAYER LOWER:
// the credential loaders and the underlying store API calls
// (`verifyGoogleSubscription`, `getAppleSubscriptionStatuses`,
// `createAppleVerifier`) — never the functions under test themselves.
// No Postgres, no object storage: these functions touch neither.
// =============================================================

// vi.mock factories are hoisted above every top-level statement in this
// file, so anything they reference must be created via vi.hoisted (same
// pattern as import-runner.integration.test.ts's fakeObjects) — a plain
// top-level const here would throw "Cannot access before initialization".
const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../src/lib/logger", () => ({
  logger: { child: () => mockLog },
}));

const loadAppleCredentials = vi.hoisted(() => vi.fn());
const loadGoogleCredentials = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/project-credentials", () => ({
  loadAppleCredentials,
  loadGoogleCredentials,
}));

const verifyGoogleSubscription = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/google/google-verify", () => ({
  verifyGoogleSubscription,
}));

const getAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/apple/apple-server-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/apple/apple-server-api")>();
  return { ...actual, getAppleSubscriptionStatuses };
});

const { appleVerifier, createAppleVerifier } = vi.hoisted(() => {
  const verifier = {
    verifyNotification: vi.fn(),
    verifyTransaction: vi.fn(),
    verifyRenewalInfo: vi.fn(),
  };
  return { appleVerifier: verifier, createAppleVerifier: vi.fn(() => verifier) };
});
vi.mock("../../src/services/apple/apple-verify", () => ({
  createAppleVerifier,
}));

import { createProductionImportVerifyDeps } from "../../src/services/import/verify-store-clients";

const PROJECT_ID = "proj_verify_store_clients_test";

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================
// Google — the matching line item, never blindly lineItems[0]
// =============================================================

describe("verifyGoogleAnchor (real function, fake verifyGoogleSubscription)", () => {
  beforeEach(() => {
    loadGoogleCredentials.mockResolvedValue({
      packageName: "com.example.app",
      serviceAccount: { client_email: "svc@example.com", private_key: "key" },
    });
  });

  it("uses the MATCHING line item's expiry/autorenew, not lineItems[0]'s, when the wrong product is first", async () => {
    verifyGoogleSubscription.mockResolvedValue({
      subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
      lineItems: [
        {
          productId: "wrong_product",
          expiryTime: "2020-01-01T00:00:00.000Z",
          autoRenewingPlan: { autoRenewEnabled: false },
        },
        {
          productId: "correct_product",
          expiryTime: "2028-06-01T00:00:00.000Z",
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    });

    const deps = createProductionImportVerifyDeps();
    const result = await deps.verifyGoogleAnchor({
      projectId: PROJECT_ID,
      purchaseToken: "tok_1",
      productIdentifier: "correct_product",
    });

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unreachable");
    expect(result.status).toBe(PurchaseStatus.ACTIVE);
    expect(result.expiresDate?.toISOString()).toBe("2028-06-01T00:00:00.000Z");
    expect(result.autoRenewStatus).toBe(true);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("falls back to the first line item AND logs a warning when nothing matches the imported product", async () => {
    verifyGoogleSubscription.mockResolvedValue({
      subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
      lineItems: [
        {
          productId: "some_other_product",
          expiryTime: "2028-01-01T00:00:00.000Z",
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    });

    const deps = createProductionImportVerifyDeps();
    const result = await deps.verifyGoogleAnchor({
      projectId: PROJECT_ID,
      purchaseToken: "tok_2",
      productIdentifier: "product_that_does_not_exist_on_this_subscription",
    });

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unreachable");
    // Fallback used the only line item present.
    expect(result.expiresDate?.toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(result.autoRenewStatus).toBe(true);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0]![0]).toMatch(/no line item matches/i);
  });
});

// =============================================================
// Apple — TRIAL is derived from the decoded transaction, not collapsed
// to ACTIVE
// =============================================================

function baseDecodedTransaction(
  overrides: Partial<AppleJwsTransactionPayload>,
): AppleJwsTransactionPayload {
  return {
    transactionId: "orig_1",
    originalTransactionId: "orig_1",
    bundleId: "com.example.app",
    productId: "pro_monthly",
    purchaseDate: Date.parse("2026-01-01T00:00:00.000Z"),
    originalPurchaseDate: Date.parse("2026-01-01T00:00:00.000Z"),
    expiresDate: Date.parse("2028-01-01T00:00:00.000Z"),
    quantity: 1,
    type: APPLE_TRANSACTION_TYPE.AUTO_RENEWABLE_SUBSCRIPTION,
    inAppOwnershipType: APPLE_OWNERSHIP_TYPE.PURCHASED,
    signedDate: Date.parse("2026-01-01T00:00:00.000Z"),
    environment: APPLE_ENVIRONMENT.PRODUCTION,
    storefront: "USA",
    storefrontId: "143441",
    ...overrides,
  };
}

describe("verifyAppleAnchor (real function, fake getAppleSubscriptionStatuses + createAppleVerifier)", () => {
  beforeEach(() => {
    loadAppleCredentials.mockResolvedValue({
      bundleId: "com.example.app",
      keyId: "KEYID1234",
      issuerId: "11111111-2222-3333-4444-555555555555",
      privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      appAppleId: 123456,
    });
    getAppleSubscriptionStatuses.mockResolvedValue({
      data: [
        {
          subscriptionGroupIdentifier: "grp_1",
          lastTransactions: [
            {
              originalTransactionId: "orig_1",
              status: APPLE_SUBSCRIPTION_STATUS.ACTIVE,
              signedTransactionInfo: "signed-transaction-jws",
            },
          ],
        },
      ],
      environment: "Production",
      bundleId: "com.example.app",
    });
  });

  it("status 1 WITH an introductory zero-price offer → TRIAL", async () => {
    appleVerifier.verifyTransaction.mockResolvedValue(
      baseDecodedTransaction({ offerType: APPLE_OFFER_TYPE.INTRODUCTORY, price: 0 }),
    );

    const deps = createProductionImportVerifyDeps();
    const result = await deps.verifyAppleAnchor({
      projectId: PROJECT_ID,
      originalTransactionId: "orig_1",
      isSandbox: false,
    });

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unreachable");
    expect(result.status).toBe(PurchaseStatus.TRIAL);
  });

  it("status 1 WITHOUT an introductory offer → ACTIVE", async () => {
    appleVerifier.verifyTransaction.mockResolvedValue(baseDecodedTransaction({}));

    const deps = createProductionImportVerifyDeps();
    const result = await deps.verifyAppleAnchor({
      projectId: PROJECT_ID,
      originalTransactionId: "orig_1",
      isSandbox: false,
    });

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unreachable");
    expect(result.status).toBe(PurchaseStatus.ACTIVE);
  });

  it("an introductory offer with a NON-ZERO price is not a trial (paid intro pricing) → ACTIVE", async () => {
    appleVerifier.verifyTransaction.mockResolvedValue(
      baseDecodedTransaction({ offerType: APPLE_OFFER_TYPE.INTRODUCTORY, price: 999 }),
    );

    const deps = createProductionImportVerifyDeps();
    const result = await deps.verifyAppleAnchor({
      projectId: PROJECT_ID,
      originalTransactionId: "orig_1",
      isSandbox: false,
    });

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unreachable");
    expect(result.status).toBe(PurchaseStatus.ACTIVE);
  });
});
