import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle, ProductType } from "@rovenue/db";
import {
  __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook,
  __test_maybeCreditConsumablePurchase as maybeCreditConsumablePurchase,
  __test_runPostProcessing as runPostProcessing,
  WEBHOOK_JOB_ATTEMPTS,
  WEBHOOK_JOB_BACKOFF_INITIAL_MS,
  webhookRetrySpanMs,
} from "./webhook-processor";

vi.mock("./purchase-credits", () => ({
  grantPurchaseCurrencies: vi.fn().mockResolvedValue(undefined),
}));
import { grantPurchaseCurrencies } from "./purchase-credits";

vi.mock("./access-engine", () => ({
  syncAccess: vi.fn().mockResolvedValue(undefined),
}));
import { syncAccess } from "./access-engine";

vi.mock("@rovenue/db", async (orig) => {
  const actual = await orig<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      // The bridge wraps the v1 write in `drizzle.db.transaction(...)`.
      // The mocked repos below don't care what `tx` shape they receive,
      // so a bare passthrough that just invokes the callback is enough.
      db: {
        transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) =>
          cb({}),
        ),
      },
      projectRepo: { findProjectWebhookConfig: vi.fn() },
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
const outboxInsertSpy = () => vi.mocked(drizzle.outboxRepo.insert);

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
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("enqueues a matching category", async () => {
    cfg(["renewal"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("skips a non-matching category", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });

  it("bridges onto the outbox (SUBSCRIPTION) even when the v1 category filter drops the event", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
    expect(outboxInsertSpy()).toHaveBeenCalledTimes(1);
    expect(outboxInsertSpy()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateType: "SUBSCRIPTION",
        aggregateId: "s1",
        eventType: "DID_RENEW",
        payload: expect.objectContaining({ projectId: "p1" }),
      }),
    );
  });

  it("bridges onto the outbox even when no v1 webhookUrl is configured", async () => {
    vi.mocked(drizzle.projectRepo.findProjectWebhookConfig).mockResolvedValue({
      url: null,
      eventCategories: [],
    });
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
    expect(outboxInsertSpy()).toHaveBeenCalledTimes(1);
  });

  it("fails open for unmapped event types", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_test",
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
      webhookEventId: "whe_test",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });
});

// =============================================================
// enqueueOutgoingWebhook — idempotency on job retry (Task 7)
// =============================================================
//
// A BullMQ retry re-runs the whole post-processing block, so a second
// enqueue for the SAME inbound webhook event must be a no-op. Purchase
// events were already deduped on (project, subscriber, eventType,
// purchaseId); purchase-less events dedupe on the inbound
// webhookEventId stamped into the outgoing payload.
describe("enqueueOutgoingWebhook idempotency", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("stamps the inbound webhookEventId into the outgoing payload", async () => {
    cfg([]);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_stamp",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
    const input = enqueueSpy().mock.calls[0]?.[1] as {
      payload: { webhookEventId?: string };
    };
    expect(input.payload.webhookEventId).toBe("whe_stamp");
  });

  it("skips a purchase-less event already enqueued for this inbound webhook event", async () => {
    cfg([]);
    // mockResolvedValueOnce — this mock's persistent module-scope default
    // (null) must survive for later tests/describe blocks that don't
    // override it.
    vi.mocked(
      drizzle.outgoingWebhookRepo.findOutgoingByWebhookEvent,
    ).mockResolvedValueOnce({ id: "ow_existing" } as never);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_dup",
      eventType: "DID_RENEW",
    });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });

  // The SUBSCRIPTION outbox bridge is inserted unconditionally on
  // webhookUrl/category, but must still be deduped on retry — otherwise
  // a BullMQ retry inserts a fresh outbox_events row (fresh id) every
  // attempt, breaking runPostProcessing's idempotency invariant.
  it("does not re-bridge a purchase event onto the outbox when already bridged", async () => {
    cfg([]);
    vi.mocked(drizzle.outboxRepo.findByPurchaseAndType).mockResolvedValueOnce({
      id: "oe_existing",
    } as never);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      purchaseId: "pur_dup",
      webhookEventId: "whe_dup_purchase",
      eventType: "DID_RENEW",
    });
    expect(outboxInsertSpy()).not.toHaveBeenCalled();
    // v1 write is unaffected by the outbox dedupe check.
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("does not re-bridge a purchase-less event onto the outbox when already bridged", async () => {
    cfg([]);
    vi.mocked(
      drizzle.outboxRepo.findByWebhookEventAndType,
    ).mockResolvedValueOnce({
      id: "oe_existing",
    } as never);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_dup_no_purchase",
      eventType: "DID_RENEW",
    });
    expect(outboxInsertSpy()).not.toHaveBeenCalled();
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("bridges onto the outbox exactly once even when the v1 write is independently deduped", async () => {
    cfg([]);
    vi.mocked(
      drizzle.outgoingWebhookRepo.findOutgoingByWebhookEvent,
    ).mockResolvedValueOnce({ id: "ow_existing" } as never);
    await enqueueOutgoingWebhook({
      projectId: "p1",
      subscriberId: "s1",
      webhookEventId: "whe_dup_v1_only",
      eventType: "DID_RENEW",
    });
    // v1 dedupe and outbox dedupe are independent checks: the outbox
    // bridge still fires on the first call even though v1 is skipped.
    expect(enqueueSpy()).not.toHaveBeenCalled();
    expect(outboxInsertSpy()).toHaveBeenCalledTimes(1);
  });
});

// =============================================================
// runPostProcessing — failures must PROPAGATE (Task 7)
// =============================================================
//
// Before the durability fix each side effect was swallowed into a
// log.warn, the job completed, the row was already PROCESSED, and any
// redelivery hit the `duplicate` gate — a failed webhook-only
// consumable credit grant was lost permanently. Now a side-effect
// failure throws so the handler marks the row FAILED (re-claimable)
// and BullMQ retries; all three effects are idempotent on re-run.
describe("runPostProcessing durability", () => {
  const args = {
    projectId: "p1",
    subscriberId: "s1",
    purchaseId: "pur_1",
    eventType: "DID_RENEW",
    webhookEventId: "whe_pp",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncAccess).mockResolvedValue(undefined);
    mockFindPurchase().mockResolvedValue(null);
    cfg([]);
  });

  it("rethrows when syncAccess fails", async () => {
    vi.mocked(syncAccess).mockRejectedValue(new Error("access engine down"));
    await expect(runPostProcessing(args)).rejects.toThrow("access engine down");
  });

  it("rethrows when the consumable credit grant fails", async () => {
    mockFindPurchase().mockResolvedValue({
      id: "pur_1",
      subscriberId: "s1",
      product: {
        id: "product-1",
        identifier: "com.example.coins100",
        type: ProductType.CONSUMABLE,
      },
    });
    mockGrant().mockRejectedValue(new Error("ledger down"));
    await expect(runPostProcessing(args)).rejects.toThrow("ledger down");
  });

  it("rethrows when the outgoing webhook enqueue fails", async () => {
    vi.mocked(
      drizzle.projectRepo.findProjectWebhookConfig,
    ).mockRejectedValue(new Error("config read down"));
    await expect(runPostProcessing(args)).rejects.toThrow("config read down");
  });

  it("resolves when all three side effects succeed", async () => {
    await expect(runPostProcessing(args)).resolves.toBeUndefined();
    expect(vi.mocked(syncAccess)).toHaveBeenCalledWith("s1");
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
    expect(outboxInsertSpy()).toHaveBeenCalledTimes(1);
  });
});

// =============================================================
// Retry span vs claim lease invariant (Task 7)
// =============================================================
//
// A worker that dies mid-claim leaves the row PROCESSING with a live
// lease; retries inside the lease see "in_progress" and throw. At
// least one BullMQ retry MUST land after the lease expires, or every
// attempt burns on the stale claim and the event strands until the
// reaper. Invariant: total retry span > WEBHOOK_CLAIM_LEASE_MS.
describe("retry span exceeds the claim lease", () => {
  it("total BullMQ backoff span is longer than WEBHOOK_CLAIM_LEASE_MS", () => {
    expect(
      webhookRetrySpanMs(WEBHOOK_JOB_ATTEMPTS, WEBHOOK_JOB_BACKOFF_INITIAL_MS),
    ).toBeGreaterThan(drizzle.webhookEventRepo.WEBHOOK_CLAIM_LEASE_MS);
  });
});
