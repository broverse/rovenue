import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByRovenueId, upsert } = vi.hoisted(() => ({
  resolveByRovenueId: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: {
      resolveSubscriberByRovenueId: resolveByRovenueId,
      upsertSubscriber: upsert,
    },
  },
}));

import { resolveOrCreateSubscriber } from "./resolve-or-create-subscriber";

describe("resolveOrCreateSubscriber", () => {
  beforeEach(() => {
    resolveByRovenueId.mockReset();
    upsert.mockReset();
  });

  it("returns the existing subscriber without creating", async () => {
    resolveByRovenueId.mockResolvedValue({ id: "s1", rovenueId: "r1" });
    const sub = await resolveOrCreateSubscriber("p1", "r1");
    expect(sub).toEqual({ id: "s1", rovenueId: "r1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("creates a minimal anonymous subscriber when none exists", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "s2", rovenueId: "r2" });
    const sub = await resolveOrCreateSubscriber("p1", "r2");
    expect(sub).toEqual({ id: "s2", rovenueId: "r2" });
    expect(upsert).toHaveBeenCalledWith({}, {
      projectId: "p1",
      rovenueId: "r2",
      createAttributes: {},
    });
  });
});
