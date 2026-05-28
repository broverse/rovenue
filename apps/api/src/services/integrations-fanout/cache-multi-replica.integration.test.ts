import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createConnectionCache } from "./connection-cache";

describe("ConnectionCache — multi-replica TTL contract", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a sibling replica that did not receive the PATCH still picks up the change within 60s via TTL", async () => {
    const loadCalls: string[] = [];
    const cache = createConnectionCache({
      ttlMs: 60_000,
      loader: async (projectId) => { loadCalls.push(projectId); return []; },
    });

    // Replica A served the PATCH and called cache.invalidate("p1").
    // Replica B did NOT receive the in-process invalidate — simulate by only calling get():
    await cache.get("p1"); // loads
    await cache.get("p1"); // cached
    expect(loadCalls).toHaveLength(1);

    // Advance 59.999s — still cached on Replica B
    vi.advanceTimersByTime(59_999);
    await cache.get("p1");
    expect(loadCalls).toHaveLength(1);

    // Advance past 60s — Replica B reloads
    vi.advanceTimersByTime(2);
    await cache.get("p1");
    expect(loadCalls).toHaveLength(2);
  });
});
