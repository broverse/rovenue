import { describe, expect, it, vi } from "vitest";
import { processFanoutMessage } from "./consumer";
import type { RovenueEventEnvelope } from "../integrations/types";

const makeEnvelope = (overrides?: Partial<RovenueEventEnvelope>): RovenueEventEnvelope => ({
  outboxEventId: "ob1",
  projectId: "p1",
  eventType: "revenue.event.recorded",
  occurredAt: new Date().toISOString(),
  ...overrides,
});

describe("processFanoutMessage", () => {
  it("enqueues one job per enabled connection", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const cache = {
      get: vi.fn().mockResolvedValue([
        { id: "c1", projectId: "p1", providerId: "META_CAPI", isEnabled: true },
        { id: "c2", projectId: "p1", providerId: "TIKTOK_EVENTS", isEnabled: true },
      ]),
      invalidate: vi.fn(),
      onInvalidate: vi.fn(),
    };

    await processFanoutMessage(makeEnvelope(), { cache, enqueue });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c1" }),
      "c1:ob1",
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c2" }),
      "c2:ob1",
    );
  });

  it("does not enqueue when no connections returned", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const cache = {
      get: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
      onInvalidate: vi.fn(),
    };

    await processFanoutMessage(makeEnvelope(), { cache, enqueue });

    expect(enqueue).not.toHaveBeenCalled();
  });
});
