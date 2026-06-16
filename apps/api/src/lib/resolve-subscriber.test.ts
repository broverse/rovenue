import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const { resolveByRovenueId } = vi.hoisted(() => ({ resolveByRovenueId: vi.fn() }));
vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: { resolveSubscriberByRovenueId: resolveByRovenueId },
  },
}));

import { resolveSubscriber } from "./resolve-subscriber";

describe("resolveSubscriber (explicit/secret-key family)", () => {
  beforeEach(() => resolveByRovenueId.mockReset());

  it("throws a 404 HTTPException with a clear message for an unknown user", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    await expect(resolveSubscriber("p1", "ghost")).rejects.toMatchObject({ status: 404 });
    try {
      await resolveSubscriber("p1", "ghost");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).message).toBe("Subscriber ghost not found");
    }
  });

  it("returns the subscriber when found (no creation)", async () => {
    resolveByRovenueId.mockResolvedValue({ id: "s1", rovenueId: "ghost" });
    const sub = await resolveSubscriber("p1", "ghost");
    expect(sub).toEqual({ id: "s1", rovenueId: "ghost" });
  });
});
