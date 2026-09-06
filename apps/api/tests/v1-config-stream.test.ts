import { beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================
// SSE /v1/config/stream integration test
// =============================================================
//
// Covers audit CS1: the stream now requires a subscriberId and emits the
// same evaluated `{ flags, experiments }` config as /v1/config, then listens
// on the invalidation channel that the flag/experiment cache paths publish to.

const { mockSubscriber } = vi.hoisted(() => ({
  mockSubscriber: {
    subscribe: vi.fn(async () => undefined),
    on: vi.fn(),
    unsubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockSubscriber),
}));

vi.mock("../src/services/subscriber-config", () => ({
  evaluateSubscriberConfig: vi.fn(async () => ({
    flags: { feature_x: true },
    experiments: [],
    // Internal resolved row id — must never leak onto the SSE wire.
    subscriberId: "sub_internal_row_id",
  })),
}));

vi.mock("../src/middleware/api-key-auth", () => ({
  apiKeyAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("project", {
        id: "proj_test",
        name: "Test",
        slug: "test",
        keyKind: "public",
        apiKeyId: "key_1",
      });
      await next();
    },
}));

import { Hono } from "hono";
import { configStreamRoute } from "../src/routes/v1/config-stream";

let app: Hono;
beforeAll(() => {
  app = new Hono().route("/", configStreamRoute);
});

describe("GET /v1/config/stream", () => {
  it("requires a subscriberId", async () => {
    const res = await app.request("/v1/config/stream", { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("sends an initial evaluated config frame", async () => {
    const controller = new AbortController();
    const res = await app.request("/v1/config/stream?subscriberId=user1", {
      method: "GET",
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: initial");
    expect(text).toContain('"projectId":"proj_test"');
    expect(text).toContain('"flags"');
    expect(text).toContain('"experiments"');
    // The evaluation result's internal resolved-row id must never leak onto
    // the public SDK wire — only { flags, experiments, projectId } may ship.
    expect(text).not.toContain("subscriberId");
    expect(text).not.toContain("sub_internal_row_id");

    controller.abort();
    await reader.cancel();
  });

  it("subscribes to the invalidation channel", async () => {
    // Hono's `.request()` overload set resolves to `Response |
    // Promise<Response>` at this call site, and only the Promise variant
    // has `.catch` — `Promise.resolve(...)` normalizes either into a real
    // Promise without changing what's awaited.
    await Promise.resolve(
      app.request("/v1/config/stream?subscriberId=user1", { method: "GET" }),
    ).catch(() => undefined);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      "rovenue:experiments:invalidate",
    );
  });

  it("pushes an invalidate frame shaped exactly like the initial frame", async () => {
    // Guards against the two SSE payloads (initial / invalidate) being
    // separately-written object literals in config-stream.ts that can
    // silently diverge: this exercises the invalidate frame the same way
    // the "sends an initial evaluated config frame" test exercises the
    // initial one, including the subscriberId-leak check.
    // Because mockSubscriber is one shared object across every connection in
    // this file, the "on" call this NEW connection registers can land
    // anywhere in its call history relative to earlier (including still-open,
    // never-aborted) connections' registrations. Record the baseline first
    // and identify our own call by index, not by "the most recent one" —
    // registration also isn't guaranteed to have happened by the time the
    // client-side reader observes the initial frame, so poll briefly for it.
    const priorOnCallCount = mockSubscriber.on.mock.calls.length;

    const controller = new AbortController();
    const res = await app.request("/v1/config/stream?subscriberId=user1", {
      method: "GET",
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // Drain the initial frame first so it can't be mistaken for the push.
    await reader.read();

    // This connection also registers an "error" listener (via
    // attachRedisErrorLogger) before its "message" listener, so scan for
    // the first "message" call at or after the baseline rather than
    // assuming a fixed offset.
    let onMessage: ((channel: string, payload: string) => void) | undefined;
    for (let attempt = 0; attempt < 50 && !onMessage; attempt++) {
      const call = mockSubscriber.on.mock.calls
        .slice(priorOnCallCount)
        .find(([event]) => event === "message");
      if (call) {
        onMessage = call[1] as typeof onMessage;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(onMessage).toBeTypeOf("function");

    // Feed it a project-wide invalidation — the same shape every
    // config-CRUD publisher sends.
    onMessage!(
      "rovenue:experiments:invalidate",
      JSON.stringify({ projectId: "proj_test" }),
    );

    // No fake timers: config-stream.ts's coalesce delay is a real
    // setTimeout, and awaiting the next chunk blocks until it actually
    // fires and writes — same idiom the rest of this file uses (real
    // timers throughout; nothing here is faked).
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    // Positive: the frame actually arrived and is shaped like /v1/config's
    // response. A test that only checked absence of subscriberId would
    // also pass if the invalidate frame were silently never emitted.
    expect(text).toContain("event: invalidate");
    expect(text).toContain('"projectId":"proj_test"');
    expect(text).toContain('"flags"');
    expect(text).toContain('"experiments"');
    // Negative: the internal resolved-row id must not leak onto this
    // frame either — this is the separately-written literal from the
    // initial frame, so it needs its own assertion.
    expect(text).not.toContain("subscriberId");
    expect(text).not.toContain("sub_internal_row_id");

    controller.abort();
    await reader.cancel();
  });
});
