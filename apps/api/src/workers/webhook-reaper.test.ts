// =============================================================
// webhook-reaper worker — unit tests (FW2.2 counter assertion)
// =============================================================
//
// Tests that runWebhookReaper() increments webhookEventsReclaimedTotal
// by the number of rows reclaimed, and does NOT increment when zero
// rows are reclaimed.
//
// The DB and BullMQ machinery are mocked so no containers are needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registry, webhookEventsReclaimedTotal } from "../lib/metrics";

// ---------------------------------------------------------------------------
// Mock @rovenue/db so reclaimStaleWebhookEvents never touches Postgres.
// ---------------------------------------------------------------------------
const reclaimMock = vi.fn<(a: unknown, b: unknown) => Promise<number>>();

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

describe("runWebhookReaper — counter (FW2.2)", () => {
  beforeEach(() => {
    registry.resetMetrics();
    reclaimMock.mockReset();
  });

  it("increments webhookEventsReclaimedTotal by the reclaimed count", async () => {
    reclaimMock.mockResolvedValueOnce(2);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date());

    expect(result.reclaimed).toBe(2);

    const metric = await webhookEventsReclaimedTotal.get();
    // No labelNames on this counter — values[0] is the unlabelled sample
    expect(metric.values[0]?.value).toBe(2);
  });

  it("does NOT increment the counter when reclaimed is 0", async () => {
    reclaimMock.mockResolvedValueOnce(0);

    const { runWebhookReaper } = await import("./webhook-reaper");
    const result = await runWebhookReaper(new Date());

    expect(result.reclaimed).toBe(0);

    const metric = await webhookEventsReclaimedTotal.get();
    // Counter must remain at zero (no sample, or sample with value 0)
    expect(metric.values[0]?.value ?? 0).toBe(0);
  });
});
