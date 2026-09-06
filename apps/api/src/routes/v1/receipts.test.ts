import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// handleReceipt — isRenewalCharge gate (Apple renewal double-grant)
// =============================================================
//
// The Swift SDK reposts EVERY `Transaction.updates` delivery to
// `/v1/receipts` — "renewals, refunds, Ask-to-Buy approvals, and
// cross-device buys" per its own comment (Rovenue.swift) — so an Apple
// auto-renewal reaches this route directly, not only the App Store
// Server Notification webhook. Before this fix, `handleReceipt` called
// `grantProductCurrencies` with trigger "PURCHASE" unconditionally,
// which would re-grant a grantOn PURCHASE row (and double-grant a
// grantOn BOTH row against its RENEWAL-trigger grant) on every such
// renewal repost — the exact same defect class as the webhook path,
// through a different door.
//
// `verifyReceipt` now reports `isRenewalCharge` (true only when Apple's
// own `transactionReason === "RENEWAL"`; always false for Google, whose
// stable purchaseToken already makes a repeat grant harmless via
// addCredits' dedupe). This file mocks every dependency of
// `handleReceipt` — including `verifyReceipt` itself — so it can drive
// the route function directly without the receipt-verification/DB
// machinery those `*.integration.test.ts` files already cover.
// =============================================================

vi.mock("../../services/access-engine", () => ({
  syncAccess: vi.fn().mockResolvedValue(undefined),
  // buildAccessResponse (lib/access-response.ts) calls this directly;
  // an empty map short-circuits it before it ever touches drizzle.
  getActiveAccess: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../services/purchase-credits", () => ({
  grantProductCurrencies: vi.fn().mockResolvedValue(undefined),
}));
import { grantProductCurrencies } from "../../services/purchase-credits";

vi.mock("../../services/credit-engine", () => ({
  getAllBalances: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../services/experiment-engine", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/receipt-verify", () => ({
  verifyReceipt: vi.fn(),
}));
import { verifyReceipt } from "../../services/receipt-verify";

vi.mock("@rovenue/db", async (orig) => {
  const actual = await orig<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      virtualCurrencyRepo: {
        listVirtualCurrencies: vi.fn().mockResolvedValue([]),
      },
    },
  };
});

import { __test_handleReceipt as handleReceipt } from "./receipts";

const SUBSCRIBER = {
  id: "sub_1",
  projectId: "prj_1",
  appUserId: "user_1",
  attributes: {},
};
const PRODUCT = { id: "prod_1", identifier: "com.example.pro_monthly" };
const PURCHASE = { id: "pur_1", priceAmount: "9.99" };

const RECEIPT_BODY = {
  receipt: "receipt-stub",
  appUserId: "user_1",
  productId: "premium_monthly",
};

describe("handleReceipt — isRenewalCharge gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(grantProductCurrencies).mockResolvedValue(undefined);
  });

  it("does not grant the PURCHASE trigger for an Apple renewal (transactionReason RENEWAL reposted via Transaction.updates)", async () => {
    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: SUBSCRIBER,
      product: PRODUCT,
      purchase: PURCHASE,
      isRenewalCharge: true,
    } as never);

    await handleReceipt("APP_STORE", "prj_1", RECEIPT_BODY as never);

    expect(vi.mocked(grantProductCurrencies)).not.toHaveBeenCalled();
  });

  it("still grants the PURCHASE trigger for an ordinary Apple purchase (guards against over-correcting into granting nothing)", async () => {
    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: SUBSCRIBER,
      product: PRODUCT,
      purchase: PURCHASE,
      isRenewalCharge: false,
    } as never);

    await handleReceipt("APP_STORE", "prj_1", RECEIPT_BODY as never);

    expect(vi.mocked(grantProductCurrencies)).toHaveBeenCalledOnce();
    expect(vi.mocked(grantProductCurrencies)).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: SUBSCRIBER.id,
        productId: PRODUCT.id,
        referenceId: PURCHASE.id,
        trigger: "PURCHASE",
      }),
    );
  });

  it("still grants the PURCHASE trigger for a Google purchase (isRenewalCharge always false there)", async () => {
    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: SUBSCRIBER,
      product: PRODUCT,
      purchase: PURCHASE,
      isRenewalCharge: false,
    } as never);

    await handleReceipt("PLAY_STORE", "prj_1", RECEIPT_BODY as never);

    expect(vi.mocked(grantProductCurrencies)).toHaveBeenCalledOnce();
  });
});
