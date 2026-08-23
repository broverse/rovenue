import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Funnel runtime cache — Redis failure degrades to a miss (unit)
// =============================================================
//
// The public funnel routes do `readPublishedConfig(slug) ?? loadFromDb()`.
// A Redis *miss* correctly falls through to Postgres, but a Redis *error*
// used to throw before the `??` evaluated, 500-ing every published funnel
// page and session start for the duration of a Redis blip — even though
// the DB fallback sitting right next to it would have served the request.
// Contract pinned here: cache errors (including corrupt payloads) are a
// miss, and cache writes/invalidations never throw.
// =============================================================

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../../lib/redis", () => ({ redis: redisMock }));

import {
  readPublishedConfig,
  writePublishedConfig,
  invalidatePublishedConfig,
} from "./runtime-cache";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runtime-cache Redis failure modes", () => {
  test("read returns null (miss) when Redis errors", async () => {
    redisMock.get.mockRejectedValue(new Error("connection refused"));
    await expect(readPublishedConfig("my-funnel")).resolves.toBeNull();
  });

  test("read returns null (miss) on a corrupt cached payload", async () => {
    redisMock.get.mockResolvedValue("{not json");
    await expect(readPublishedConfig("my-funnel")).resolves.toBeNull();
  });

  test("read still parses a healthy hit", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ pages: [] }));
    await expect(readPublishedConfig("my-funnel")).resolves.toEqual({
      pages: [],
    });
  });

  test("write swallows Redis errors", async () => {
    redisMock.set.mockRejectedValue(new Error("connection refused"));
    await expect(
      writePublishedConfig("my-funnel", { pages: [] }),
    ).resolves.toBeUndefined();
  });

  test("invalidate swallows Redis errors", async () => {
    redisMock.del.mockRejectedValue(new Error("connection refused"));
    await expect(invalidatePublishedConfig("my-funnel")).resolves.toBeUndefined();
  });
});
