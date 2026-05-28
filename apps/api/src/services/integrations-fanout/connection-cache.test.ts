import { describe, expect, it, vi } from "vitest";
import { createConnectionCache } from "./connection-cache";

describe("createConnectionCache", () => {
  it("returns cached value within TTL", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 1000, loader });
    expect(await cache.get("p1")).toEqual([{ id: "c1" }]);
    expect(await cache.get("p1")).toEqual([{ id: "c1" }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates on emit", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 60_000, loader });
    await cache.get("p1");
    cache.invalidate("p1");
    await cache.get("p1");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("expires by TTL", async () => {
    vi.useFakeTimers();
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 100, loader });
    await cache.get("p1");
    vi.advanceTimersByTime(150);
    await cache.get("p1");
    expect(loader).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
