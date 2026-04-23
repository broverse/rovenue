import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/services/event-bus";
import { drizzle } from "@rovenue/db";

vi.mock("@rovenue/db", async (actual) => {
  const real = await actual<typeof import("@rovenue/db")>();
  return {
    ...real,
    drizzle: {
      ...real.drizzle,
      outboxRepo: { insert: vi.fn() },
    },
  };
});

describe("eventBus.publishExposure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an EXPOSURE outbox row with the expected shape", async () => {
    const tx = {} as Parameters<typeof eventBus.publishExposure>[0];
    await eventBus.publishExposure(tx, {
      experimentId: "exp_123",
      variantId: "var_treatment",
      projectId: "prj_abc",
      subscriberId: "sub_xyz",
      platform: "ios",
      country: "US",
      exposedAt: new Date("2026-04-24T10:00:00Z"),
    });
    expect(drizzle.outboxRepo.insert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(drizzle.outboxRepo.insert).mock.calls[0];
    expect(call[1]).toMatchObject({
      aggregateType: "EXPOSURE",
      aggregateId: "exp_123",
      eventType: "experiment.exposure.recorded",
      payload: expect.objectContaining({
        experimentId: "exp_123",
        variantId: "var_treatment",
      }),
    });
  });
});
