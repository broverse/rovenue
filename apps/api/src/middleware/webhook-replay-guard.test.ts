// =============================================================
// webhookReplayGuard middleware — unit tests (W3.2 metric assertion)
// =============================================================
//
// Tests that the replay guard increments webhookReplayGuardFailOpenTotal
// when redis.set throws and then calls next() (fail-open behaviour must
// be preserved — only observability is added).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registry, webhookReplayGuardFailOpenTotal } from "../lib/metrics";

// Mock redis before the subject is imported so the module receives the stub.
vi.mock("../lib/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

// env is frozen at import — provide the one field the guard reads.
vi.mock("../lib/env", () => ({
  env: {
    WEBHOOK_REPLAY_TOLERANCE_SECONDS: 300,
  },
}));

describe("webhookReplayGuard — fail-open metric (W3.2)", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  async function buildApp(source: "apple" | "google" | "stripe" = "apple") {
    const { webhookReplayGuard } = await import("./webhook-replay-guard");
    const app = new Hono();

    // Pre-populate the context variables that verifyX normally sets.
    app.use("*", async (c, next) => {
      c.set("webhookEventId", "test-event-id");
      c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
      await next();
    });

    app.post(
      "/webhook",
      webhookReplayGuard({ source }),
      (c) => c.json({ data: { ok: true } }),
    );
    return app;
  }

  it("increments webhookReplayGuardFailOpenTotal and calls next() when redis throws", async () => {
    const { redis } = await import("../lib/redis");
    (redis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const app = await buildApp("apple");
    const res = await app.request("/webhook", { method: "POST" });

    // Guard must fail open — handler still runs
    expect(res.status).toBe(200);

    // Metric must be incremented
    const metric = await webhookReplayGuardFailOpenTotal.get();
    const sample = metric.values.find((v) => v.labels.source === "apple");
    expect(sample?.value).toBe(1);
  });

  it("does NOT increment the counter when redis succeeds (new key)", async () => {
    const { redis } = await import("../lib/redis");
    // "OK" means the key was set (not a duplicate)
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

    const app = await buildApp("google");
    const res = await app.request("/webhook", { method: "POST" });

    expect(res.status).toBe(200);

    const metric = await webhookReplayGuardFailOpenTotal.get();
    // No sample at all, or a zero-value sample
    const sample = metric.values.find((v) => v.labels.source === "google");
    expect(sample?.value ?? 0).toBe(0);
  });

  it("returns 200 duplicate response when redis returns null (seen key)", async () => {
    const { redis } = await import("../lib/redis");
    // null means NX condition failed — key already existed
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const app = await buildApp("stripe");
    const res = await app.request("/webhook", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("duplicate");

    // No fail-open counter increment
    const metric = await webhookReplayGuardFailOpenTotal.get();
    const sample = metric.values.find((v) => v.labels.source === "stripe");
    expect(sample?.value ?? 0).toBe(0);
  });
});
