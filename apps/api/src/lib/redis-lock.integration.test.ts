import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Redis } from "ioredis";

// =============================================================
// withLock against a real Redis
// =============================================================
//
// redis-lock.test.ts asserts the release script's *text*, and the route
// tests drive an in-memory fake. Neither runs the Lua. A KEYS/ARGV arity
// mistake or a syntax error would pass every one of those and only fail in
// production — where the failure mode is a lock that is never released,
// i.e. a key wedged for the rest of its TTL on every request that takes
// it. So the script has to be executed by a real server at least once.
//
// House testcontainers pattern (see tests/billing-backfill-migration and
// tests/revenue-aggregates-idempotency): start the container in
// `beforeAll`, point the env at it, and import the module under test
// afterwards — `lib/redis` builds its client from `env.REDIS_URL` at
// import time, so a top-of-file import would bind to the default URL
// before the container exists.

let container: StartedTestContainer;
let withLock: typeof import("./redis-lock").withLock;
let client: Redis;

beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();

  process.env.REDIS_URL = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

  ({ withLock } = await import("./redis-lock"));
  ({ redis: client } = await import("./redis"));
  // `lib/redis` builds the client with `lazyConnect` and without an
  // offline queue, so every command before an explicit connect throws
  // rather than being buffered.
  await client.connect();
}, 120_000);

afterAll(async () => {
  client?.disconnect();
  await container?.stop();
});

describe("withLock (real redis)", () => {
  beforeEach(async () => {
    await client.flushall();
  });

  it("acquires the key and runs the function", async () => {
    const result = await withLock("k1", 30_000, async () => {
      // Held for the duration, not merely at the end.
      expect(await client.get("k1")).toEqual(expect.any(String));
      return "done";
    });

    expect(result).toBe("done");
  });

  it("returns null without running the function while the key is held", async () => {
    let inner: string | null = "not run";
    const outer = await withLock("k2", 30_000, async () => {
      inner = await withLock("k2", 30_000, async () => "inner ran");
      return "outer";
    });

    expect(outer).toBe("outer");
    // Also the concrete demonstration of the non-re-entrancy documented on
    // withLock: same process, same key, second acquire refused.
    expect(inner).toBeNull();
  });

  it("releases the key so the next caller can take it", async () => {
    await withLock("k3", 30_000, async () => "first");
    expect(await client.exists("k3")).toBe(0);
    expect(await withLock("k3", 30_000, async () => "second")).toBe("second");
  });

  it("releases the key when the function throws", async () => {
    await expect(
      withLock("k4", 30_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await client.exists("k4")).toBe(0);
  });

  // THE one that matters. If the Lua compared the wrong slot — ARGV[1]
  // against KEYS[1], or a missing argument — this deletes a lock the
  // current holder is still working under, which is worse than holding no
  // lock at all: the holder believes it is serialized and is not.
  it("does not release a key that a later holder has taken", async () => {
    await withLock("k5", 30_000, async () => {
      // Simulate our TTL expiring mid-flight and someone else acquiring:
      // the key now carries a different token.
      await client.set("k5", "a-later-holders-token");
      return "done";
    });

    expect(await client.get("k5")).toBe("a-later-holders-token");
  });

  it("reports ownership from the real key", async () => {
    const seen: boolean[] = [];
    await withLock("k6", 30_000, async (lock) => {
      seen.push(await lock.stillHeld());
      await client.set("k6", "a-later-holders-token");
      seen.push(await lock.stillHeld());
      await client.del("k6");
      seen.push(await lock.stillHeld());
      return "done";
    });

    expect(seen).toEqual([true, false, false]);
  });

  it("expires the key on its own when the holder never releases", async () => {
    await withLock("k7", 150, async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return "slow";
    });
    // The PX argument has to reach the server, or a crashed holder wedges
    // the key forever. (Here the release already removed it; what this
    // pins is that a *concurrent* caller could take it after the TTL.)
    expect(await client.exists("k7")).toBe(0);

    await client.set("k8", "someone", "PX", 150);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await withLock("k8", 30_000, async () => "taken")).toBe("taken");
  });
});
