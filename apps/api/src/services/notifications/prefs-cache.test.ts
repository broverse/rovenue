import { LRUCache } from "lru-cache";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyInvalidation,
  createPrefsCache,
  PREFS_CACHE_CHANNEL,
  publishInvalidation,
} from "./prefs-cache";

describe("applyInvalidation", () => {
  function buildCache() {
    return {
      userPrefs: new LRUCache<string, object>({ max: 10, ttl: 60_000 }),
      projectDefaults: new LRUCache<string, object>({ max: 10, ttl: 60_000 }),
      projectMembers: new LRUCache<string, object>({ max: 10, ttl: 60_000 }),
    };
  }

  it("drops a userPrefs key", () => {
    const cache = buildCache();
    cache.userPrefs.set("user-1", { email: true });
    applyInvalidation(cache, { kind: "userPrefs", key: "user-1" });
    expect(cache.userPrefs.get("user-1")).toBeUndefined();
  });

  it("drops a projectDefaults key", () => {
    const cache = buildCache();
    cache.projectDefaults.set("proj-1", { foo: true });
    applyInvalidation(cache, { kind: "projectDefaults", key: "proj-1" });
    expect(cache.projectDefaults.get("proj-1")).toBeUndefined();
  });

  it("drops every projectMembers composite key under a projectId prefix", () => {
    const cache = buildCache();
    cache.projectMembers.set("proj-1:OWNER", ["user-1"]);
    cache.projectMembers.set("proj-1:OWNER,ADMIN", ["user-1", "user-2"]);
    cache.projectMembers.set("proj-2:OWNER", ["user-3"]);

    applyInvalidation(cache, { kind: "projectMembers", key: "proj-1" });

    expect(cache.projectMembers.get("proj-1:OWNER")).toBeUndefined();
    expect(cache.projectMembers.get("proj-1:OWNER,ADMIN")).toBeUndefined();
    // proj-2 untouched.
    expect(cache.projectMembers.get("proj-2:OWNER")).toEqual(["user-3"]);
  });

  it("leaves the cache alone when the invalidated key is unknown", () => {
    const cache = buildCache();
    cache.userPrefs.set("user-1", { email: true });
    applyInvalidation(cache, { kind: "userPrefs", key: "user-2" });
    expect(cache.userPrefs.get("user-1")).toEqual({ email: true });
  });
});

// =============================================================
// End-to-end pub/sub roundtrip
// =============================================================
//
// Uses a real Redis on REDIS_URL (default redis://localhost:6379).
// If the connection fails, the test is skipped — local dev that
// hasn't started the redis container shouldn't fail CI-style runs.

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("publishInvalidation roundtrip", () => {
  let publisher: Redis;
  let cache: ReturnType<typeof createPrefsCache> | null = null;
  let available = false;

  beforeAll(async () => {
    publisher = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    try {
      await publisher.connect();
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(async () => {
    if (cache) await cache.close();
    try {
      publisher.disconnect();
    } catch {
      // ignore
    }
  });

  it("drops a cached entry when a publisher fires an invalidation", async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn("redis unavailable — skipping pubsub roundtrip");
      return;
    }

    cache = createPrefsCache(publisher, { max: 10, ttlMs: 60_000 });
    cache.userPrefs.set("user-pub", { email: true });

    // Give SUBSCRIBE a moment to settle before publishing. Re-trying
    // the publish inside the waitFor below also masks any short-lived
    // race on the subscriber side.
    await new Promise((r) => setTimeout(r, 200));

    await waitFor(async () => {
      // Re-publish on each tick in case the first publish raced the
      // subscriber binding. Cheap and deterministic.
      await publishInvalidation(publisher, "userPrefs", "user-pub");
      await new Promise((r) => setTimeout(r, 50));
      return cache!.userPrefs.get("user-pub") === undefined;
    }, 5_000);

    expect(cache.userPrefs.get("user-pub")).toBeUndefined();
  }, 15_000);
});

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}
