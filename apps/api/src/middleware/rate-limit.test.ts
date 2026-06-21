// =============================================================
// FW2.1 — endpointRateLimit returns 429 past the limit
//
// Exercises the real rateLimit() logic (sliding-window sorted set
// pipeline) via a mocked Redis client so the test is self-contained
// and never touches a live Redis instance.
//
// Request sequence:
//   req 1 → count 1 → 1 ≤ max(2) → 200
//   req 2 → count 2 → 2 ≤ max(2) → 200
//   req 3 → count 3 → 3 > max(2) → 429 + Retry-After header
// =============================================================

// Must precede any env-reading imports (lib/env.ts reads at module init).
process.env.REDIS_URL ??= "redis://localhost:6380";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// vi.mock factories are hoisted. The counter is captured in module scope
// so the mock factory (which runs before declarations) still sees it.
// ---------------------------------------------------------------------------

// Per-key hit counter — reset in beforeEach.
const hitCounters: Record<string, number> = {};

vi.mock("../lib/redis", () => {
  // Build a fake pipeline that returns what the rate-limit middleware reads:
  //   result[2][1] = zcard  (the current count after adding this request)
  //   result[3][1] = zrange WITHSCORES → oldest entry array [member, score]
  function makePipeline(key: string) {
    return {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zrange: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockImplementation(() => {
        // Increment the hit counter for this key.
        hitCounters[key] = (hitCounters[key] ?? 0) + 1;
        const count = hitCounters[key];
        const now = Date.now();
        // Simulate a sorted-set where all entries were added "now".
        // result[3] = zrange result: [null, [member, score_as_string]]
        return Promise.resolve([
          [null, 0],               // zremrangebyscore
          [null, 1],               // zadd (added 1 element)
          [null, count],           // zcard → current count
          [null, [`${now}`, String(now)]], // zrange WITHSCORES → oldest
          [null, 1],               // pexpire
        ]);
      }),
    };
  }

  return {
    redis: {
      multi: vi.fn().mockImplementation(function () {
        // We need the key at exec() time. The pipeline methods are chained
        // before exec() runs, so we capture the key from zremrangebyscore's
        // first call argument.
        let capturedKey = "__unknown__";
        const pipeline = {
          zremrangebyscore: vi.fn().mockImplementation((k: string) => {
            capturedKey = k;
            return pipeline;
          }),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          zrange: vi.fn().mockReturnThis(),
          pexpire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockImplementation(() => {
            hitCounters[capturedKey] = (hitCounters[capturedKey] ?? 0) + 1;
            const count = hitCounters[capturedKey];
            const now = Date.now();
            return Promise.resolve([
              [null, 0],
              [null, 1],
              [null, count],
              [null, [`${now}`, String(now)]],
              [null, 1],
            ]);
          }),
        };
        return pipeline;
      }),
    },
  };
});

// Mock logger to suppress noise.
vi.mock("../lib/logger", () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import the middleware under test AFTER mocks are declared.
// ---------------------------------------------------------------------------
import { endpointRateLimit } from "./rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(limitName: string) {
  const app = new Hono();
  app.use(
    "/ping",
    endpointRateLimit({
      name: limitName,
      max: 2,
      windowMs: 60_000,
      // Fixed identifier so every test request lands in the same bucket.
      identify: () => "test-client",
    }),
  );
  app.get("/ping", (c) => c.json({ ok: true }, 200));
  return app;
}

function ping(app: Hono) {
  return app.request("/ping", { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("endpointRateLimit", () => {
  // Use a unique limit name per test run to isolate the hit counter.
  let limitName: string;

  beforeEach(() => {
    // Reset hit counters so each test starts clean.
    for (const k of Object.keys(hitCounters)) {
      delete hitCounters[k];
    }
    limitName = `test-429-${Date.now()}`;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 for requests within the limit and 429 for the request that exceeds it", async () => {
    const app = buildApp(limitName);

    // Request 1 — count=1, 1 ≤ max(2) → 200
    const r1 = await ping(app);
    expect(r1.status, "request 1 should be 200").toBe(200);

    // Request 2 — count=2, 2 ≤ max(2) → 200
    const r2 = await ping(app);
    expect(r2.status, "request 2 should be 200").toBe(200);

    // Request 3 — count=3, 3 > max(2) → 429
    const r3 = await ping(app);
    expect(r3.status, "request 3 should be 429").toBe(429);

    // 429 must carry a Retry-After header.
    const retryAfter = r3.headers.get("Retry-After");
    expect(retryAfter, "429 should include Retry-After header").not.toBeNull();
    expect(
      Number(retryAfter),
      "Retry-After must be a positive integer",
    ).toBeGreaterThan(0);
  });

  it("429 response body contains RATE_LIMITED error code", async () => {
    const app = buildApp(limitName);
    await ping(app); // 1
    await ping(app); // 2
    const r3 = await ping(app); // 3 → 429
    const body = await r3.json();
    expect(body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});
