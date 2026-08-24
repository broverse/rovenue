import { describe, expect, it, vi } from "vitest";
import {
  createSubscriberIdentityCache,
  SUBSCRIBER_IDENTITY_CACHE_TTL_MS,
  type SubscriberIdentity,
} from "./subscriber-identity-cache";

const IDENTITY: SubscriberIdentity = {
  appUserId: "user_1",
  attributes: { $email: "a@b.com" },
};

describe("createSubscriberIdentityCache", () => {
  it("exports the 60s TTL constant", () => {
    expect(SUBSCRIBER_IDENTITY_CACHE_TTL_MS).toBe(60_000);
  });

  it("calls the loader once per id and caches the result within the TTL", async () => {
    const loader = vi.fn().mockResolvedValue(IDENTITY);
    const cache = createSubscriberIdentityCache({ ttlMs: 60_000, loader });

    const first = await cache.get("sub_1");
    const second = await cache.get("sub_1");

    expect(first).toEqual(IDENTITY);
    expect(second).toEqual(IDENTITY);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("sub_1");
  });

  it("re-invokes the loader after the entry expires", async () => {
    let now = 0;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const loader = vi.fn().mockResolvedValue(IDENTITY);
      const cache = createSubscriberIdentityCache({ ttlMs: 1_000, loader });

      await cache.get("sub_1");
      now += 1_001;
      await cache.get("sub_1");

      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.spyOn(Date, "now").mockImplementation(realNow);
    }
  });

  it("caches a loader-miss (null) result without re-invoking the loader", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    const cache = createSubscriberIdentityCache({ ttlMs: 60_000, loader });

    const first = await cache.get("missing");
    const second = await cache.get("missing");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("caches distinct subscriber ids independently", async () => {
    const loader = vi.fn().mockImplementation(async (id: string) => ({
      appUserId: id,
      attributes: {},
    }));
    const cache = createSubscriberIdentityCache({ ttlMs: 60_000, loader });

    const a = await cache.get("sub_a");
    const b = await cache.get("sub_b");

    expect(a?.appUserId).toBe("sub_a");
    expect(b?.appUserId).toBe("sub_b");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
