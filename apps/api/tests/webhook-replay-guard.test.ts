import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { redisMock, __store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    redisMock: {
      async set(
        key: string,
        value: string,
        mode: string,
        seconds: number,
        nx: string,
      ) {
        if (mode !== "EX" || nx !== "NX") {
          throw new Error("unexpected args");
        }
        if (store.has(key)) return null;
        store.set(key, value);
        ttl.set(key, seconds);
        return "OK";
      },
    },
    __store: store,
  };
});

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

import { webhookReplayGuard } from "../src/middleware/webhook-replay-guard";

describe("webhookReplayGuard", () => {
  beforeEach(() => {
    __store.clear();
  });

  afterEach(() => {
    vi.doUnmock("../src/lib/redis");
    vi.resetModules();
  });

  test("rejects when context missing webhookEventId or timestamp", async () => {
    const app = new Hono()
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(500);
  });

  test("accepts a fresh event", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-1");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("rejects a replayed event with 200 + replayed body", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-2");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const first = await app.request("/", { method: "POST" });
    expect(first.status).toBe(200);
    const second = await app.request("/", { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      data: { status: "duplicate", source: "apple" },
    });
  });

  test("rejects a stale timestamp outside tolerance", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-3");
        c.set(
          "webhookEventTimestamp",
          Math.floor(Date.now() / 1000) - 3600,
        );
        await next();
      })
      .post(
        "/",
        webhookReplayGuard({ source: "apple", toleranceSeconds: 300 }),
        (c) => c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("fails open when redis throws on SET NX", async () => {
    const throwingRedis = {
      async set() {
        throw new Error("redis down");
      },
    };
    vi.resetModules();
    vi.doMock("../src/lib/redis", () => ({ redis: throwingRedis }));
    const { webhookReplayGuard: wrg } = await import(
      "../src/middleware/webhook-replay-guard"
    );
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-4");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", wrg({ source: "apple" }), (c) => c.json({ ok: true }));
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
