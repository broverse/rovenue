import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle, ProductType } from "@rovenue/db";
import {
  __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook,
  __test_maybeCreditConsumablePurchase as maybeCreditConsumablePurchase,
} from "./webhook-processor";

vi.mock("./purchase-credits", () => ({
  grantPurchaseCurrencies: vi.fn().mockResolvedValue(undefined),
}));
import { grantPurchaseCurrencies } from "./purchase-credits";

vi.mock("@rovenue/db", async (orig) => {
  const actual = await orig<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { findProjectWebhookConfig: vi.fn() },
      outgoingWebhookRepo: {
        findRecentOutgoingByPurchaseAndType: vi.fn().mockResolvedValue(null),
        enqueueOutgoingWebhook: vi.fn().mockResolvedValue(undefined),
      },
      purchaseExtRepo: {
        findPurchaseWithCreditInfo: vi.fn(),
      },
    },
  };
});

const cfg = (eventCategories: string[]) =>
  vi.mocked(drizzle.projectRepo.findProjectWebhookConfig).mockResolvedValue({
    url: "https://hook.example.com",
    eventCategories,
  });
const enqueueSpy = () =>
  vi.mocked(drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook);

const mockFindPurchase = () =>
  vi.mocked(drizzle.purchaseExtRepo.findPurchaseWithCreditInfo);
const mockGrant = () => vi.mocked(grantPurchaseCurrencies);

describe("maybeCreditConsumablePurchase", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls grantPurchaseCurrencies for a consumable purchase", async () => {
    mockFindPurchase().mockResolvedValue({
      id: "purchase-1",
      subscriberId: "sub-1",
      product: {
        id: "product-1",
        identifier: "com.example.coins100",
        type: ProductType.CONSUMABLE,
        creditAmount: null,
      },
    });

    await maybeCreditConsumablePurchase("sub-1", "purchase-1");

    expect(mockGrant()).toHaveBeenCalledOnce();
    expect(mockGrant()).toHaveBeenCalledWith({
      subscriberId: "sub-1",
      productId: "product-1",
      purchaseId: "purchase-1",
      productIdentifier: "com.example.coins100",
    });
  });

  it("does nothing when purchase is not found", async () => {
    mockFindPurchase().mockResolvedValue(null);

    await maybeCreditConsumablePurchase("sub-1", "purchase-missing");

    expect(mockGrant()).not.toHaveBeenCalled();
  });

  it("does nothing for a non-consumable product", async () => {
    mockFindPurchase().mockResolvedValue({
      id: "purchase-2",
      subscriberId: "sub-1",
      product: {
        id: "product-2",
        identifier: "com.example.pro",
        type: ProductType.SUBSCRIPTION,
        creditAmount: null,
      },
    });

    await maybeCreditConsumablePurchase("sub-1", "purchase-2");

    expect(mockGrant()).not.toHaveBeenCalled();
  });
});

describe("enqueueOutgoingWebhook category filter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("enqueues everything when categories empty", async () => {
    cfg([]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("enqueues a matching category", async () => {
    cfg(["renewal"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("skips a non-matching category", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });

  it("fails open for unmapped event types", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      eventType: "CONSUMPTION_REQUEST",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no webhook url configured", async () => {
    vi.mocked(drizzle.projectRepo.findProjectWebhookConfig).mockResolvedValue({
      url: null,
      eventCategories: [],
    });
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });
});
