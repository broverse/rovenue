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
const redisGet = vi.hoisted(() => vi.fn());

vi.mock("./redis", () => ({
  redis: { set: redisSet, eval: redisEval, get: redisGet },
}));

const { withLock, LockUnavailableError } = await import("./redis-lock");

describe("withLock", () => {
  beforeEach(() => {
    redisSet.mockReset().mockResolvedValue("OK");
    redisEval.mockReset().mockResolvedValue(1);
    redisGet.mockReset().mockResolvedValue(null);
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

  // "Nobody could take the lock" and "somebody else has it" are different
  // answers to the client: the first is a retryable dependency outage, the
  // second is contention. Collapsing them into `null` would present a
  // Redis outage as a 409 and hide it.
  it("throws LockUnavailableError when the acquire itself fails", async () => {
    redisSet.mockRejectedValue(new Error("ECONNREFUSED"));
    const fn = vi.fn(async () => "done");

    await expect(withLock("k", 30_000, fn)).rejects.toBeInstanceOf(
      LockUnavailableError,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(redisEval).not.toHaveBeenCalled();
  });
});

// =============================================================
// The ownership fence
// =============================================================
//
// A TTL is a deadline, not a guarantee. Work that outruns it keeps
// running while another request holds the key — both believing they are
// serialized. stillHeld() is how the holder finds that out before it
// commits anything, so it must be exact about the token and must fail
// closed.

describe("withLock — stillHeld", () => {
  beforeEach(() => {
    redisSet.mockReset().mockResolvedValue("OK");
    redisEval.mockReset().mockResolvedValue(1);
    redisGet.mockReset().mockResolvedValue(null);
  });

  it("is true while the key still carries our own token", async () => {
    let held: boolean | undefined;
    await withLock("k", 30_000, async (lock) => {
      redisGet.mockResolvedValue(redisSet.mock.calls[0][1]);
      held = await lock.stillHeld();
      return "done";
    });

    expect(redisGet).toHaveBeenCalledWith("k");
    expect(held).toBe(true);
  });

  it("is false once the key holds someone else's token", async () => {
    redisGet.mockResolvedValue("a-later-holders-token");
    let held: boolean | undefined;
    await withLock("k", 30_000, async (lock) => {
      held = await lock.stillHeld();
      return "done";
    });

    expect(held).toBe(false);
  });

  it("is false when the key expired and is simply gone", async () => {
    redisGet.mockResolvedValue(null);
    let held: boolean | undefined;
    await withLock("k", 30_000, async (lock) => {
      held = await lock.stillHeld();
      return "done";
    });

    expect(held).toBe(false);
  });

  // Fails closed: callers gate destructive work on this answer, and doing
  // that work unserialized is the failure the lock exists to prevent.
  it("is false when redis cannot answer", async () => {
    redisGet.mockRejectedValue(new Error("redis down"));
    let held: boolean | undefined;
    await withLock("k", 30_000, async (lock) => {
      held = await lock.stillHeld();
      return "done";
    });

    expect(held).toBe(false);
  });
});
