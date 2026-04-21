import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// In-memory Redis mock implementing the subset used by the
// sliding-window rate limiter: multi/pipeline with
// zremrangebyscore, zadd, zcard, zrange, pexpire.
// =============================================================

const { redisMock, setRedisDown, __store } = vi.hoisted(() => {
  const store = new Map<string, Array<{ score: number; member: string }>>();
  let down = false;

  function getSet(key: string) {
    let list = store.get(key);
    if (!list) {
      list = [];
      store.set(key, list);
    }
    return list;
  }

  function multi() {
    const ops: Array<() => unknown> = [];
    const pipeline = {
      zremrangebyscore(key: string, min: number, max: number) {
        ops.push(() => {
          const list = getSet(key);
          const before = list.length;
          const kept = list.filter((e) => e.score < min || e.score > max);
          store.set(key, kept);
          return before - kept.length;
        });
        return pipeline;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => {
          const list = getSet(key);
          list.push({ score, member });
          list.sort((a, b) => a.score - b.score);
          return 1;
        });
        return pipeline;
      },
      zcard(key: string) {
        ops.push(() => getSet(key).length);
        return pipeline;
      },
      zrange(
        key: string,
        start: number,
        stop: number,
        withScores?: string,
      ) {
        ops.push(() => {
          const list = getSet(key);
          const slice = list.slice(start, stop === -1 ? undefined : stop + 1);
          if (withScores?.toUpperCase() === "WITHSCORES") {
            return slice.flatMap((e) => [e.member, String(e.score)]);
          }
          return slice.map((e) => e.member);
        });
        return pipeline;
      },
      pexpire(_key: string, _ttl: number) {
        ops.push(() => 1);
        return pipeline;
      },
      async exec() {
        if (down) throw new Error("redis down");
        return ops.map((fn) => [null, fn()]);
      },
    };
    return pipeline;
  }

  return {
    redisMock: { multi },
    setRedisDown: (v: boolean) => {
      down = v;
    },
    __store: store,
  };
});

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

// =============================================================
// System under test
// =============================================================

import { dashboardUserRateLimit, rateLimit } from "../src/middleware/rate-limit";

function buildApp(middlewareArgs: {
  windowMs: number;
  max: number;
  identify?: (c: any) => string;
  keyPrefix?: string;
}): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const res = err.getResponse();
      return res;
    }
    return c.json({ error: String(err) }, 500);
  });
  app.use("*", rateLimit(middlewareArgs));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  __store.clear();
  setRedisDown(false);
  vi.restoreAllMocks();
});

// =============================================================
// Tests
// =============================================================

describe("rateLimit middleware", () => {
  test("first request passes with X-RateLimit-* headers set", async () => {
    const app = buildApp({ windowMs: 60_000, max: 10 });

    const res = await app.request("/", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
    const reset = res.headers.get("X-RateLimit-Reset");
    expect(reset).not.toBeNull();
    expect(Number(reset)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("remaining decreases monotonically within the window", async () => {
    const app = buildApp({ windowMs: 60_000, max: 5 });
    const init = { headers: { "x-forwarded-for": "1.1.1.1" } };

    const r1 = await app.request("/", init);
    const r2 = await app.request("/", init);
    const r3 = await app.request("/", init);

    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("3");
    expect(r3.headers.get("X-RateLimit-Remaining")).toBe("2");
  });

  test("returns 429 + Retry-After once the cap is exceeded", async () => {
    const app = buildApp({ windowMs: 60_000, max: 2 });
    const init = { headers: { "x-forwarded-for": "9.9.9.9" } };

    await app.request("/", init);
    await app.request("/", init);
    const res = await app.request("/", init);

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("different IPs have independent counters", async () => {
    const app = buildApp({ windowMs: 60_000, max: 2 });

    await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } });
    await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const overflow1 = await app.request("/", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });

    const other = await app.request("/", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });

    expect(overflow1.status).toBe(429);
    expect(other.status).toBe(200);
  });

  test("identify callback overrides the default IP-based key", async () => {
    const app = buildApp({
      windowMs: 60_000,
      max: 1,
      identify: (c) => c.req.header("x-api-key") ?? "anon",
    });

    // Same IP, different API keys → separate buckets.
    const headers = { "x-forwarded-for": "1.1.1.1" };
    const a1 = await app.request("/", {
      headers: { ...headers, "x-api-key": "key-a" },
    });
    const a2 = await app.request("/", {
      headers: { ...headers, "x-api-key": "key-a" },
    });
    const b1 = await app.request("/", {
      headers: { ...headers, "x-api-key": "key-b" },
    });

    expect(a1.status).toBe(200);
    expect(a2.status).toBe(429);
    expect(b1.status).toBe(200);
  });

  test("fails open when Redis is unreachable", async () => {
    const app = buildApp({ windowMs: 60_000, max: 1 });

    setRedisDown(true);

    // Would normally have been blocked after the first request.
    const r1 = await app.request("/", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const r2 = await app.request("/", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("x-forwarded-for's first hop is used as the client IP", async () => {
    const app = buildApp({ windowMs: 60_000, max: 1 });

    const r1 = await app.request("/", {
      headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.1, 127.0.0.1" },
    });
    const r2 = await app.request("/", {
      headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.1, 127.0.0.1" },
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  test("dashboardUserRateLimit scopes by user id", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        const uid = c.req.header("x-test-user") ?? "anon";
        c.set("user", { id: uid } as never);
        await next();
      })
      .use("*", dashboardUserRateLimit())
      .get("/", (c) => c.json({ ok: true }));

    // Burn user-A quota (300/min)
    for (let i = 0; i < 300; i++) {
      const r = await app.request("/", { headers: { "x-test-user": "user-a" } });
      expect(r.status).toBe(200);
    }
    const over = await app.request("/", { headers: { "x-test-user": "user-a" } });
    expect(over.status).toBe(429);

    // user-b untouched
    const other = await app.request("/", { headers: { "x-test-user": "user-b" } });
    expect(other.status).toBe(200);
  });
});
