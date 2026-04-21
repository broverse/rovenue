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
import {
  __resetInsurance,
  insuranceConsume,
} from "../src/middleware/insurance-rate-limit";

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
  __resetInsurance();
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

  test("insurance limiter caps requests when redis is down", async () => {
    setRedisDown(true);

    const app = new Hono()
      .use("*", rateLimit({ windowMs: 60_000, max: 100, keyPrefix: "rl:test" }))
      .get("/", (c) => c.json({ ok: true }));

    // Insurance cap is 50/min/key. With Redis dead, the 51st request
    // hits the insurance 429.
    for (let i = 0; i < 50; i++) {
      const r = await app.request("/");
      expect(r.status).toBe(200);
    }
    const capped = await app.request("/");
    expect(capped.status).toBe(429);
  });

  test("insurance limiter sweeps stale buckets past threshold", () => {
    __resetInsurance();
    const originalNow = Date.now;
    try {
      // Seed 10_001 distinct keys at t=0 — past the sweep threshold.
      let t = 1_000_000;
      Date.now = () => t;
      for (let i = 0; i < 10_001; i++) {
        insuranceConsume(`k_${i}`);
      }

      // Jump forward past the window — these buckets are now stale.
      t = 1_000_000 + 120_000;
      // Single consume triggers the sweep because size >= threshold.
      insuranceConsume("trigger");

      // Probe a few seeded keys: they should be gone (fresh bucket
      // returns true because it's a first-ever call for the key).
      expect(insuranceConsume("k_0")).toBe(true);
      expect(insuranceConsume("k_5000")).toBe(true);
    } finally {
      Date.now = originalNow;
      __resetInsurance();
    }
  });
});
