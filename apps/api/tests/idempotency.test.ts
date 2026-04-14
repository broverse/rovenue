import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// In-memory redis mock (hoisted so vi.mock can see it)
// =============================================================

const { redisStore, redisMock, setRedisMode } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let mode: "ok" | "fail-get" | "fail-set" | "fail-all" = "ok";

  const redisMock = {
    get: vi.fn(async (key: string) => {
      if (mode === "fail-get" || mode === "fail-all") {
        throw new Error("redis get down");
      }
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(
      async (key: string, value: string, _mode: string, ttlSec: number) => {
        if (mode === "fail-set" || mode === "fail-all") {
          throw new Error("redis set down");
        }
        store.set(key, {
          value,
          expiresAt: Date.now() + ttlSec * 1000,
        });
        return "OK";
      },
    ),
  };

  return {
    redisStore: store,
    redisMock,
    setRedisMode: (next: "ok" | "fail-get" | "fail-set" | "fail-all") => {
      mode = next;
    },
  };
});

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

// =============================================================
// System under test
// =============================================================

import { idempotency } from "../src/middleware/idempotency";

type ProjectStub = { id: string; name: string; slug: string };

function buildApp(
  projectId = "proj_a",
): { app: Hono; getCallCount: () => number; resetCallCount: () => void } {
  const state = { callCount: 0 };

  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("project", { id: projectId, name: "t", slug: "t" } as unknown as ProjectStub as never);
    await next();
  });

  app.use("*", idempotency);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: String(err) }, 500);
  });

  app.post("/work", async (c) => {
    state.callCount += 1;
    const body = (await c.req.json()) as { x: number };
    return c.json({ ok: true, count: state.callCount, echo: body });
  });

  return {
    app,
    getCallCount: () => state.callCount,
    resetCallCount: () => {
      state.callCount = 0;
    },
  };
}

function jsonBody(body: unknown, key?: string): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  return { method: "POST", headers, body: JSON.stringify(body) };
}

beforeEach(() => {
  redisStore.clear();
  redisMock.get.mockClear();
  redisMock.set.mockClear();
  setRedisMode("ok");
});

// =============================================================
// Tests
// =============================================================

describe("idempotency middleware", () => {
  test("without Idempotency-Key header: handler runs, nothing cached", async () => {
    const { app, getCallCount } = buildApp();

    const res = await app.request("/work", jsonBody({ x: 1 }));

    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  test("first request with a key: handler runs and response is cached", async () => {
    const { app, getCallCount } = buildApp();

    const res = await app.request("/work", jsonBody({ x: 1 }, "idem-1"));

    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
    expect(redisMock.set).toHaveBeenCalledOnce();
    const [key] = redisMock.set.mock.calls[0]!;
    expect(key).toBe("idempotency:proj_a:idem-1");
  });

  test("duplicate request with same key + body: handler not re-run, cached response replayed", async () => {
    const { app, getCallCount } = buildApp();

    const first = await app.request("/work", jsonBody({ x: 1 }, "idem-2"));
    const firstBody = (await first.json()) as Record<string, unknown>;

    const second = await app.request("/work", jsonBody({ x: 1 }, "idem-2"));
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(second.status).toBe(200);
    expect(getCallCount()).toBe(1);
    expect(secondBody).toEqual(firstBody);
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });

  test("same key with different body: returns 422", async () => {
    const { app, getCallCount } = buildApp();

    const first = await app.request("/work", jsonBody({ x: 1 }, "idem-3"));
    expect(first.status).toBe(200);

    const second = await app.request("/work", jsonBody({ x: 2 }, "idem-3"));

    expect(second.status).toBe(422);
    expect(getCallCount()).toBe(1);
  });

  test("different projects: same idempotency key doesn't collide", async () => {
    const a = buildApp("proj_a");
    const b = buildApp("proj_b");

    await a.app.request("/work", jsonBody({ x: 1 }, "shared-key"));
    const second = await b.app.request("/work", jsonBody({ x: 1 }, "shared-key"));

    expect(second.status).toBe(200);
    expect(b.getCallCount()).toBe(1);
    expect(second.headers.get("idempotent-replay")).toBeNull();
  });

  test("redis down on GET: fails open, handler runs normally", async () => {
    const { app, getCallCount } = buildApp();

    setRedisMode("fail-get");
    const res = await app.request("/work", jsonBody({ x: 1 }, "idem-5"));

    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
  });

  test("redis down on SET: fails open, handler runs normally, response returned", async () => {
    const { app, getCallCount } = buildApp();

    setRedisMode("fail-set");
    const res = await app.request("/work", jsonBody({ x: 1 }, "idem-6"));

    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("cache TTL is 24 hours (86400 seconds)", async () => {
    const { app } = buildApp();

    await app.request("/work", jsonBody({ x: 1 }, "idem-7"));

    const [, , , ttl] = redisMock.set.mock.calls[0]!;
    expect(ttl).toBe(86_400);
  });

  test("non-2xx responses are not cached", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set(
        "project",
        { id: "proj_a", name: "t", slug: "t" } as unknown as never,
      );
      await next();
    });
    app.use("*", idempotency);
    app.post("/fail", (c) => c.json({ error: "boom" }, 500));

    await app.request("/fail", jsonBody({ x: 1 }, "idem-8"));

    expect(redisMock.set).not.toHaveBeenCalled();
  });
});
