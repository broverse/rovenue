import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle } from "@rovenue/db";
import { __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook } from "./webhook-processor";

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
