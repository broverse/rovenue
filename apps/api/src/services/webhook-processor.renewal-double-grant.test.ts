import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle, ProductType } from "@rovenue/db";

// =============================================================
// Apple renewal double-grant regression — grantOn BOTH row
// =============================================================
//
// webhook-processor.test.ts mocks the ENTIRE `./purchase-credits` module,
// which is the right call for testing the isRenewalCharge gate in
// isolation, but it can't prove anything about what a grantOn BOTH row
// actually receives across a real renewal — grantProductCurrencies'
// trigger-matching logic (grantTriggersMatching: BOTH matches PURCHASE
// AND RENEWAL) never runs there.
//
// This file deliberately does NOT mock `./purchase-credits`. Only its
// dependencies — the grant-row repository and `addCredits` — are mocked,
// so the REAL trigger filtering executes. It drives the two calls a
// single Apple renewal produces in production:
//
//   1. runPostProcessing for the DID_RENEW webhook (isRenewalCharge:
//      true) — must withhold the PURCHASE-trigger call entirely.
//   2. grantProductCurrencies({ trigger: "RENEWAL" }) — the legitimate
//      grant, driven off the revenue event by the Kafka renewal-grants
//      consumer + worker (services/renewal-grants/consumer.ts,
//      workers/renewal-grant.ts — covered by their own tests).
//
// Before the isRenewalCharge gate existed, step 1 called
// grantProductCurrencies with trigger "PURCHASE", which ALSO matches a
// BOTH row (grantTriggersMatching("PURCHASE") = ["PURCHASE", "BOTH"]) —
// so addCredits fired once from step 1 and once from step 2: two grants
// for one renewal. This test fails (2 calls) against that code and
// passes (1 call) once the gate withholds step 1.
// =============================================================

vi.mock("./access-engine", () => ({
  syncAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./credit-engine", () => ({
  addCredits: vi.fn().mockResolvedValue({ id: "cl_1" }),
}));
import { addCredits } from "./credit-engine";

vi.mock("@rovenue/db", async (orig) => {
  const actual = await orig<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {
        transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) =>
          cb({}),
        ),
      },
      projectRepo: {
        findProjectWebhookConfig: vi
          .fn()
          .mockResolvedValue({ url: null, eventCategories: [] as string[] }),
      },
      outgoingWebhookRepo: {
        findRecentOutgoingByPurchaseAndType: vi.fn().mockResolvedValue(null),
        findOutgoingByWebhookEvent: vi.fn().mockResolvedValue(null),
        enqueueOutgoingWebhook: vi.fn().mockResolvedValue(undefined),
      },
      outboxRepo: {
        insert: vi.fn().mockResolvedValue(undefined),
        findByPurchaseAndType: vi.fn().mockResolvedValue(null),
        findByWebhookEventAndType: vi.fn().mockResolvedValue(null),
      },
      purchaseExtRepo: {
        findPurchaseWithCreditInfo: vi.fn(),
      },
      productCurrencyGrantRepo: {
        listProductGrantsForTrigger: vi.fn(),
      },
    },
  };
});

import {
  __test_runPostProcessing as runPostProcessing,
} from "./webhook-processor";
import { grantProductCurrencies } from "./purchase-credits";

const SUBSCRIBER_ID = "sub_1";
const PRODUCT_ID = "product-both-1";
const PRODUCT_IDENTIFIER = "com.example.pro_both";
const RENEWAL_PURCHASE_ID = "pur_renew_1";
const REVENUE_EVENT_ID = "rev_1";

// A single grantOn BOTH row — the real repo would return this row for
// EITHER trigger (see grantTriggersMatching), which is exactly what
// makes a BOTH row double-grantable if both call sites ever fire for
// the same renewal.
const BOTH_GRANT_ROW = {
  id: "g1",
  productId: PRODUCT_ID,
  currencyId: "cur_gems",
  amount: 100,
  grantOn: "BOTH",
};

describe("Apple renewal — grantOn BOTH row is credited exactly once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(
      drizzle.productCurrencyGrantRepo.listProductGrantsForTrigger,
    ).mockResolvedValue([BOTH_GRANT_ROW] as never);
    vi.mocked(drizzle.purchaseExtRepo.findPurchaseWithCreditInfo).mockResolvedValue(
      {
        id: RENEWAL_PURCHASE_ID,
        subscriberId: SUBSCRIBER_ID,
        product: {
          id: PRODUCT_ID,
          identifier: PRODUCT_IDENTIFIER,
          type: ProductType.SUBSCRIPTION,
        },
      } as never,
    );
  });

  it("one addCredits call across the whole renewal — RENEWAL trigger only, PURCHASE trigger withheld", async () => {
    // Step 1: the DID_RENEW webhook's post-processing.
    await runPostProcessing({
      projectId: "p1",
      subscriberId: SUBSCRIBER_ID,
      purchaseId: RENEWAL_PURCHASE_ID,
      eventType: "DID_RENEW",
      webhookEventId: "whe_renew_1",
      isRenewalCharge: true,
    });

    // Step 2: the legitimate RENEWAL-trigger grant for the same renewal.
    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REVENUE_EVENT_ID,
      productIdentifier: PRODUCT_IDENTIFIER,
      trigger: "RENEWAL",
    });

    expect(vi.mocked(addCredits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addCredits)).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceType: "renewal",
        referenceId: REVENUE_EVENT_ID,
      }),
    );
    // Never reached with the purchase reference — that would be the
    // erroneous second grant.
    expect(vi.mocked(addCredits)).not.toHaveBeenCalledWith(
      expect.objectContaining({ referenceType: "purchase" }),
    );
  });
});
