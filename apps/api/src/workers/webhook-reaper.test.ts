// =============================================================
// webhook-reaper worker — unit tests
// =============================================================
//
// Covers:
//  - FW2.2: runWebhookReaper() increments webhookEventsReclaimedTotal
//    by the number of rows reclaimed (and not when zero).
//  - Task 7 durability: each reclaimed row is re-enqueued as a webhook
//    processing job rebuilt from the stored payload, with a
//    deterministic jobId (`webhook-replay:{eventId}:{retryCount}`) so a
//    double-reap can't double-enqueue but a re-reap after another
//    failure cycle CAN enqueue again; rows past MAX_REAPER_REQUEUES
//    stay FAILED and are never re-enqueued.
//
// The DB and BullMQ machinery are mocked so no containers are needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registry, webhookEventsReclaimedTotal } from "../lib/metrics";

// ---------------------------------------------------------------------------
// Mock @rovenue/db so reclaimStaleWebhookEvents never touches Postgres.
// It now returns the reclaimed ROWS (not a count) so the reaper can
// re-enqueue them.
// ---------------------------------------------------------------------------
const reclaimMock = vi.fn<(a: unknown, b: unknown) => Promise<unknown[]>>();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    webhookEventRepo: {
      reclaimStaleWebhookEvents: reclaimMock,
    },
  },
}));

// env is read at import time — provide the single field the reaper reads
// (REDIS_URL is only used by the BullMQ wiring, not by runWebhookReaper itself).
vi.mock("../lib/env", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    NODE_ENV: "test",
  },
}));

interface ReclaimedRowStub {
  id: string;
  projectId: string;
  source: string;
  eventType: string;
  retryCount: number;
  payload: unknown;
}

function staleRow(overrides: Partial<ReclaimedRowStub> = {}): ReclaimedRowStub {
  return {
    id: "whe_stale_1",
    projectId: "prj_1",
    source: "STRIPE",
    eventType: "invoice.paid",
    retryCount: 1,
    payload: { id: "evt_1", type: "invoice.paid" },
    ...overrides,
  };
}

const enqueueReplay = vi.fn(async () => undefined);

describe("runWebhookReaper — counter (FW2.2)", () => {
  beforeEach(() => {
    registry.resetMetrics();
    reclaimMock.mockReset();
    enqueueReplay.mockClear();
  });

  it("increments webhookEventsReclaimedTotal by the reclaimed count", async () => {
    reclaimMock.mockResolvedValueOnce([
      staleRow({ id: "whe_a", payload: {} }),
      staleRow({ id: "whe_b", payload: {} }),
    ]);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.reclaimed).toBe(2);

    const metric = await webhookEventsReclaimedTotal.get();
    // No labelNames on this counter — values[0] is the unlabelled sample
    expect(metric.values[0]?.value).toBe(2);
  });

  it("does NOT increment the counter when reclaimed is 0", async () => {
    reclaimMock.mockResolvedValueOnce([]);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.reclaimed).toBe(0);

    const metric = await webhookEventsReclaimedTotal.get();
    // Counter must remain at zero (no sample, or sample with value 0)
    expect(metric.values[0]?.value ?? 0).toBe(0);
  });
});

describe("runWebhookReaper — re-enqueue (Task 7)", () => {
  beforeEach(() => {
    registry.resetMetrics();
    reclaimMock.mockReset();
    enqueueReplay.mockClear();
  });

  it("re-enqueues a stale STRIPE row from the stored event with a deterministic jobId", async () => {
    reclaimMock.mockResolvedValueOnce([staleRow()]);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.requeued).toBe(1);
    expect(enqueueReplay).toHaveBeenCalledTimes(1);
    expect(enqueueReplay).toHaveBeenCalledWith(
      {
        source: "STRIPE",
        projectId: "prj_1",
        event: { id: "evt_1", type: "invoice.paid" },
      },
      { jobId: "webhook-replay:whe_stale_1:1" },
    );
  });

  it("re-enqueues APPLE from the stored signedPayload and GOOGLE from the stored pushBody", async () => {
    const pushBody = {
      message: { messageId: "m1", data: "e30=" },
      subscription: "projects/p/subscriptions/s",
    };
    reclaimMock.mockResolvedValueOnce([
      staleRow({
        id: "whe_apple",
        source: "APPLE",
        payload: { signedPayload: "jws.payload.sig", notification: {} },
      }),
      staleRow({
        id: "whe_google",
        source: "GOOGLE",
        retryCount: 3,
        payload: { pushBody, notification: {} },
      }),
    ]);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.requeued).toBe(2);
    expect(enqueueReplay).toHaveBeenNthCalledWith(
      1,
      { source: "APPLE", projectId: "prj_1", signedPayload: "jws.payload.sig" },
      { jobId: "webhook-replay:whe_apple:1" },
    );
    expect(enqueueReplay).toHaveBeenNthCalledWith(
      2,
      { source: "GOOGLE", projectId: "prj_1", pushBody },
      { jobId: "webhook-replay:whe_google:3" },
    );
  });

  it("leaves a row past MAX_REAPER_REQUEUES FAILED without re-enqueueing", async () => {
    const { MAX_REAPER_REQUEUES, runWebhookReaper } = await import(
      "./webhook-reaper"
    );
    reclaimMock.mockResolvedValueOnce([
      staleRow({ retryCount: MAX_REAPER_REQUEUES + 1 }),
    ]);

    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.reclaimed).toBe(1);
    expect(result.requeued).toBe(0);
    expect(enqueueReplay).not.toHaveBeenCalled();
  });

  it("skips rows whose stored payload cannot rebuild a job (legacy shape / unknown source)", async () => {
    reclaimMock.mockResolvedValueOnce([
      // Legacy APPLE row: payload is the bare decoded notification,
      // no signedPayload to re-verify from.
      staleRow({ id: "whe_legacy", source: "APPLE", payload: {} }),
      // Billing rows are processed by the billing pipeline, not the
      // store webhook queue — never replayed from here.
      staleRow({ id: "whe_billing", source: "STRIPE_BILLING" }),
    ]);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date(), enqueueReplay);

    expect(result.reclaimed).toBe(2);
    expect(result.requeued).toBe(0);
    expect(enqueueReplay).not.toHaveBeenCalled();
  });
});
