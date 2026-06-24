// =============================================================
// Public funnel routes — unit tests for W4.3 hardening
//
// No real Postgres, Redis, or external dependency.
// - W4.3a: rate-limit middleware is mounted on POST /funnels/:slug/sessions
// - W4.3b: rate-limit middleware is mounted on POST /funnel-sessions/:id/answers
// - W4.3c: answer payload > 16 KB → 413
// - W4.3d: deeply-nested-but-within-limits answer → accepted (200)
// - W4.3e: answer string > 2000 chars → 400
// - W4.3f: cookie has Secure flag when NODE_ENV=production
// - W4.3g: cookie does NOT have Secure flag when NODE_ENV=test
// =============================================================

// Must come before any imports that read env.
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "redis://localhost:6379";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../middleware/error";

// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the compiled output, so they
// run before any variable declarations. All mock implementations must be
// defined inline in the factory.
// ---------------------------------------------------------------------------

vi.mock("../../lib/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

// Mock the runtime cache so GET /funnels/:slug can return a stub config.
vi.mock("../../services/funnel/runtime-cache", () => ({
  readPublishedConfig: vi.fn().mockResolvedValue(null),
  writePublishedConfig: vi.fn().mockResolvedValue(undefined),
  invalidatePublishedConfig: vi.fn().mockResolvedValue(undefined),
}));

// Mock the outbox so emitFunnelEvent never touches the DB.
vi.mock("../../services/funnel/outbox", () => ({
  emitFunnelEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock custom-domain resolution.
vi.mock("../../services/custom-domains/host-resolver", () => ({
  resolveHost: vi.fn().mockResolvedValue(null),
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      funnels: actual.drizzle.funnels,
      funnelRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "funnel-id",
          projectId: "project-id",
          status: "published",
          currentVersionId: "version-id",
          slug: "test-funnel",
        }),
      },
      funnelVersionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "version-id",
          pagesJson: [{ id: "page-1", elements: [] }],
          themeJson: {},
          settingsJson: {},
        }),
      },
      funnelSessionRepo: {
        insert: vi.fn().mockResolvedValue({ id: "session-id" }),
        findById: vi.fn().mockResolvedValue({
          id: "session-id",
          state: "in_progress",
          funnelId: "funnel-id",
          funnelVersionId: "version-id",
          projectId: "project-id",
          currentPageId: "page-1",
        }),
        setCurrentPage: vi.fn().mockResolvedValue(undefined),
        setState: vi.fn().mockResolvedValue(undefined),
      },
      funnelAnswerRepo: {
        upsert: vi.fn().mockResolvedValue(undefined),
        listBySession: vi.fn().mockResolvedValue([]),
      },
      funnelClaimTokenRepo: {
        findBySession: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue({ id: "token-id" }),
      },
      funnelPurchaseRepo: {
        insert: vi.fn().mockResolvedValue({ id: "purchase-id" }),
      },
    },
  };
});

// Track rate-limit invocations per endpoint name.
type RateLimitCall = { name: string };
const rateLimitCalls: RateLimitCall[] = [];
vi.mock("../../middleware/rate-limit", () => ({
  endpointRateLimit: (opts: { name: string }) =>
    async (_c: unknown, next: () => Promise<void>) => {
      // rateLimitCalls is declared with [] before the hoisted block runs.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      rateLimitCalls.push({ name: opts.name });
      await next();
    },
}));

// ---------------------------------------------------------------------------
// Import the route under test — after all mocks are wired.
// ---------------------------------------------------------------------------
import { readPublishedConfig } from "../../services/funnel/runtime-cache";
import { drizzle } from "@rovenue/db";
import { publicFunnelsRoute } from "./funnels";

const readPublishedConfigMock = readPublishedConfig as ReturnType<typeof vi.fn>;

// Stub published config returned by the cache (avoids DB hit on session create).
const STUB_CONFIG = {
  id: "funnel-id",
  slug: "test-funnel",
  version_id: "version-id",
  pages: [{ id: "page-1", elements: [] }],
  theme: {},
  settings: {},
};

function buildApp() {
  const app = new Hono().route("/public", publicFunnelsRoute);
  app.onError(errorHandler);
  return app;
}

function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// W4.3a/b: rate-limit middleware is mounted on both funnel POSTs
// ---------------------------------------------------------------------------

describe("W4.3a/b: rate-limit middleware is mounted on funnel POSTs", () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
    readPublishedConfigMock.mockResolvedValue(STUB_CONFIG);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("invokes funnel:session rate limit on POST /funnels/:slug/sessions", async () => {
    const app = buildApp();
    await post(app, "/public/funnels/test-funnel/sessions", {});
    expect(rateLimitCalls.some((c) => c.name === "funnel:session")).toBe(true);
  });

  it("invokes funnel:answer rate limit on POST /funnel-sessions/:id/answers", async () => {
    const app = buildApp();
    await post(app, "/public/funnel-sessions/session-id/answers", {
      page_id: "page-1",
      question_id: "q1",
      answer: "hello",
    });
    expect(rateLimitCalls.some((c) => c.name === "funnel:answer")).toBe(true);
  });

  it("invokes funnel:advance rate limit on POST /funnel-sessions/:id/advance", async () => {
    const app = buildApp();
    await post(app, "/public/funnel-sessions/session-id/advance", {
      from_page_id: "page-1",
    });
    expect(rateLimitCalls.some((c) => c.name === "funnel:advance")).toBe(true);
  });

  it("invokes funnel:state rate limit on GET /funnel-sessions/:id/state", async () => {
    const app = buildApp();
    await app.request("/public/funnel-sessions/session-id/state");
    expect(rateLimitCalls.some((c) => c.name === "funnel:state")).toBe(true);
  });

  it("invokes funnel:claim-token rate limit on POST /funnel-sessions/:id/claim-token", async () => {
    const app = buildApp();
    await post(app, "/public/funnel-sessions/session-id/claim-token", {});
    expect(rateLimitCalls.some((c) => c.name === "funnel:claim-token")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W4.3c: answer payload > 16 KB → 413
// ---------------------------------------------------------------------------

describe("W4.3c: 16 KB hard cap on answer payload", () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
    readPublishedConfigMock.mockResolvedValue(STUB_CONFIG);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("returns 413 when serialized answer exceeds 16 384 bytes", async () => {
    const app = buildApp();
    // Build a nested structure that passes individual schema limits but exceeds
    // 16 KB total. Each string is exactly 2000 chars (the max allowed) and the
    // array has 10 elements — 10 × 2000 = 20 000 chars of content alone.
    const bigString = "a".repeat(2000);
    const oversized = Array.from({ length: 10 }, () => bigString);
    const res = await post(app, "/public/funnel-sessions/session-id/answers", {
      page_id: "page-1",
      question_id: "q1",
      answer: oversized,
    });
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// W4.3d: deeply-nested-but-within-limits answer is accepted
// ---------------------------------------------------------------------------

describe("W4.3d: nested answer within limits is accepted", () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
    readPublishedConfigMock.mockResolvedValue(STUB_CONFIG);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("accepts a nested answer within depth + size limits", async () => {
    const app = buildApp();
    // Nested object 3 levels deep, all keys <= 100 chars, values <= 2000 chars.
    const answer = {
      level1: {
        level2: {
          value: "hello",
          items: ["a", "b", "c"],
        },
      },
      score: 42,
      active: true,
      nothing: null,
    };
    const res = await post(app, "/public/funnel-sessions/session-id/answers", {
      page_id: "page-1",
      question_id: "q1",
      answer,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W4.3e: answer string > 2000 chars → 400 (schema violation)
// ---------------------------------------------------------------------------

describe("W4.3e: answer string > 2000 chars fails schema validation", () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
    readPublishedConfigMock.mockResolvedValue(STUB_CONFIG);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("returns 400 when answer is a string exceeding 2000 characters", async () => {
    const app = buildApp();
    const tooLong = "y".repeat(2001);
    const res = await post(app, "/public/funnel-sessions/session-id/answers", {
      page_id: "page-1",
      question_id: "q1",
      answer: tooLong,
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// W4.3f/g: cookie Secure flag matches NODE_ENV
// ---------------------------------------------------------------------------

describe("W4.3f/g: rv_funnel_sid cookie Secure flag", () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
    readPublishedConfigMock.mockResolvedValue(STUB_CONFIG);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("does NOT set Secure on cookie when NODE_ENV=test", async () => {
    // NODE_ENV is already "test" (set at the top of this file).
    const app = buildApp();
    const res = await post(app, "/public/funnels/test-funnel/sessions", {});
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    // Should NOT contain '; Secure' (case-insensitive).
    expect(setCookieHeader.toLowerCase()).not.toContain("secure");
  });

  it("sets Secure on cookie when NODE_ENV=production", async () => {
    // Temporarily override the env value by re-importing with production env.
    // We do this by directly monkeypatching the env module's export.
    // Simpler approach: mutate process.env and reimport via dynamic import.
    const { env } = await import("../../lib/env");
    // The env object is frozen after parse, so we cast and override for the test.
    const originalNodeEnv = (env as Record<string, unknown>).NODE_ENV;
    (env as Record<string, unknown>).NODE_ENV = "production";

    try {
      const app = buildApp();
      const res = await post(app, "/public/funnels/test-funnel/sessions", {});
      const setCookieHeader = res.headers.get("set-cookie") ?? "";
      expect(setCookieHeader.toLowerCase()).toContain("secure");
    } finally {
      (env as Record<string, unknown>).NODE_ENV = originalNodeEnv;
    }
  });
});
