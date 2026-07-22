import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// withLock
// =============================================================
//
// The two things that make a lock worse than no lock at all:
// releasing one you no longer hold (the next holder loses its
// exclusivity while still believing it is serialized), and not
// releasing one you do hold (every later request for that key is wedged
// for the rest of the TTL). Both are pinned below.

const redisSet = vi.hoisted(() => vi.fn());
const redisEval = vi.hoisted(() => vi.fn());

vi.mock("./redis", () => ({ redis: { set: redisSet, eval: redisEval } }));

const { withLock } = await import("./redis-lock");

describe("withLock", () => {
  beforeEach(() => {
    redisSet.mockReset().mockResolvedValue("OK");
    redisEval.mockReset().mockResolvedValue(1);
  });

  it("acquires with SET NX PX and runs the function", async () => {
    const result = await withLock("k", 30_000, async () => "done");

    expect(result).toBe("done");
    const [key, token, px, ttl, nx] = redisSet.mock.calls[0];
    expect(key).toBe("k");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // NX is what makes this a lock rather than a last-writer-wins
    // overwrite; PX is what stops a crashed holder wedging the key.
    expect([px, ttl, nx]).toEqual(["PX", 30_000, "NX"]);
  });

  it("returns null without running the function when the key is held", async () => {
    redisSet.mockResolvedValue(null);
    const fn = vi.fn(async () => "done");

    expect(await withLock("k", 30_000, fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    // Critically it must NOT release: the token belongs to the current
    // holder, and deleting it would hand the key to a third request while
    // the holder is still working.
    expect(redisEval).not.toHaveBeenCalled();
  });

  it("releases with the same token it acquired with", async () => {
    await withLock("k", 30_000, async () => "done");

    const token = redisSet.mock.calls[0][1];
    const [script, numKeys, key, arg] = redisEval.mock.calls[0];
    expect(numKeys).toBe(1);
    expect(key).toBe("k");
    expect(arg).toBe(token);
    // The compare and the delete have to be one server-side step.
    expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(script).toContain('redis.call("del", KEYS[1])');
  });

  it("uses a fresh token per call", async () => {
    await withLock("k", 30_000, async () => "a");
    await withLock("k", 30_000, async () => "b");

    expect(redisSet.mock.calls[0][1]).not.toBe(redisSet.mock.calls[1][1]);
  });

  it("releases when the function throws, and rethrows", async () => {
    await expect(
      withLock("k", 30_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Skipping this would hold the key for the full TTL after any error.
    expect(redisEval).toHaveBeenCalledTimes(1);
    expect(redisEval.mock.calls[0][3]).toBe(redisSet.mock.calls[0][1]);
  });

  it("does not fail the call when the release itself fails", async () => {
    redisEval.mockRejectedValue(new Error("redis down"));
    // The key still expires on its own, so a failed release costs one TTL
    // of contention — it must not cost the caller its result.
    expect(await withLock("k", 30_000, async () => "done")).toBe("done");
  });
});
