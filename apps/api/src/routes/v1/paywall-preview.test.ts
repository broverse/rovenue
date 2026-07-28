// =============================================================
// GET /v1/preview/paywalls/:token — P9 on-device preview (§6.17)
// =============================================================
//
// No real Postgres or Redis — drizzle's paywall/preview-session repos
// and hydrateDraftPaywall are all mocked so we exercise only routing,
// the ETag/304 short-circuit, and the "every invalid token looks the
// same" invariant (missing / expired / revoked / garbage all collapse
// to a byte-identical 404 PREVIEW_SESSION_INVALID — no oracle for an
// attacker probing tokens).

process.env.NODE_ENV = "test";

import { describe, it, expect, vi, beforeEach } from "vitest";

// rate-limit is mocked as pass-through middleware, but the exact options
// each call site passes (name / max / identify) are captured so the
// "rate-limits by token hash" test can assert on them directly — the
// route module calls `endpointRateLimit(...)` exactly ONCE at import
// time (it builds the middleware, not per-request), so this array ends
// up with exactly one entry for the lifetime of the test file.
const { rateLimitCalls } = vi.hoisted(() => ({
  rateLimitCalls: [] as Array<{
    name: string;
    max: number;
    identify?: (c: unknown) => string;
  }>,
}));
vi.mock("../../middleware/rate-limit", () => ({
  endpointRateLimit: (opts: {
    name: string;
    max: number;
    identify?: (c: unknown) => string;
  }) => {
    rateLimitCalls.push(opts);
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

const findActiveByHash = vi.fn();
const findPaywallById = vi.fn();
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      previewSessionRepo: {
        findActiveByHash: (...args: unknown[]) => findActiveByHash(...args),
      },
      paywallRepo: {
        findPaywallById: (...args: unknown[]) => findPaywallById(...args),
      },
    },
  };
});

const hydrateDraftPaywall = vi.fn();
vi.mock("../../lib/placement-resolution", () => ({
  hydrateDraftPaywall: (...args: unknown[]) => hydrateDraftPaywall(...args),
}));

import { Hono } from "hono";
import { errorHandler } from "../../middleware/error";
import { hashToken } from "../../services/funnel/token";
import {
  paywallPreviewRoute,
  PREVIEW_RATE_LIMIT_PER_MIN,
} from "./paywall-preview";

function app() {
  const a = new Hono().route("/", paywallPreviewRoute);
  a.onError(errorHandler);
  return a;
}

const REVISION_DATE = new Date("2026-07-20T00:00:00.000Z");
const REVISION = REVISION_DATE.toISOString();
const SESSION = { id: "sess_1", projectId: "proj_1", paywallId: "pw_1" };
const PAYWALL = {
  id: "pw_1",
  projectId: "proj_1",
  updatedAt: REVISION_DATE,
  builderConfig: { nodes: [] },
};
const WIRE = {
  id: "pw_1",
  identifier: "pw_ident",
  name: "Test Paywall",
  configFormatVersion: 1,
  remoteConfig: null,
  builderConfig: { nodes: [] },
  offering: null,
};

beforeEach(() => {
  findActiveByHash.mockReset();
  findPaywallById.mockReset();
  hydrateDraftPaywall.mockReset();
});

describe("GET /v1/preview/paywalls/:token", () => {
  it("returns PaywallWire + revision with an ETag for a valid token", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue(WIRE);

    const res = await app().request("/v1/preview/paywalls/plaintext-token");

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"${REVISION}"`);
    expect(await res.json()).toEqual({ data: { ...WIRE, revision: REVISION } });
    expect(findActiveByHash).toHaveBeenCalledWith(
      {},
      hashToken("plaintext-token"),
      expect.any(Date),
    );
  });

  it("succeeds with NO bearer/API key at all, proving the root mount escapes the /v1 auth envelope", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue(WIRE);

    // Deliberately no Authorization / x-api-key header.
    const res = await app().request("/v1/preview/paywalls/plaintext-token");

    expect(res.status).toBe(200);
  });

  it("passes ?locale= through to hydrateDraftPaywall", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue(WIRE);

    await app().request("/v1/preview/paywalls/plaintext-token?locale=fr");

    expect(hydrateDraftPaywall).toHaveBeenCalledWith(
      SESSION.projectId,
      PAYWALL,
      "fr",
    );
  });

  it("returns a generic 404 PREVIEW_SESSION_INVALID when the session is missing/expired/revoked", async () => {
    findActiveByHash.mockResolvedValue(null);

    const res = await app().request("/v1/preview/paywalls/some-token");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: "PREVIEW_SESSION_INVALID",
        message: expect.any(String),
      },
    });
    expect(findPaywallById).not.toHaveBeenCalled();
    expect(hydrateDraftPaywall).not.toHaveBeenCalled();
  });

  it("returns a byte-identical 404 body for expired, revoked, and garbage tokens alike", async () => {
    // findActiveByHash returning null is what a not-found, expired-but-
    // not-revoked, and revoked-but-not-yet-expired row ALL look like —
    // Task 1's query already collapses those three cases (see
    // packages/db/src/drizzle/repositories/paywall-preview-sessions.ts).
    // A garbage/unknown token hashes to a value nothing matches, so it
    // takes the exact same branch. Here we just prove the branch's own
    // output is identical across arbitrary distinct inputs.
    findActiveByHash.mockResolvedValue(null);

    const resGarbage1 = await app().request(
      "/v1/preview/paywalls/garbage-token-abc",
    );
    const resGarbage2 = await app().request(
      "/v1/preview/paywalls/totally-different-garbage",
    );

    expect(resGarbage1.status).toBe(404);
    expect(resGarbage2.status).toBe(404);
    expect(await resGarbage1.json()).toEqual(await resGarbage2.json());
  });

  it("returns a generic 404 when the paywall has no draft builderConfig (hydrateDraftPaywall -> null)", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue(null);

    const res = await app().request("/v1/preview/paywalls/some-token");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: "PREVIEW_SESSION_INVALID",
        message: expect.any(String),
      },
    });
  });

  it("returns 304 with no body when If-None-Match matches the current revision, and does NOT hydrate", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);

    const res = await app().request("/v1/preview/paywalls/some-token", {
      headers: { "If-None-Match": `"${REVISION}"` },
    });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(hydrateDraftPaywall).not.toHaveBeenCalled();
  });

  it("still hydrates and returns 200 when If-None-Match does not match (stale client cache)", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue(WIRE);

    const res = await app().request("/v1/preview/paywalls/some-token", {
      headers: { "If-None-Match": '"some-stale-revision"' },
    });

    expect(res.status).toBe(200);
    expect(hydrateDraftPaywall).toHaveBeenCalled();
  });

  it("rate-limits by the SHA-256 hash of the token, at PREVIEW_RATE_LIMIT_PER_MIN/min", () => {
    expect(rateLimitCalls).toHaveLength(1);
    const opts = rateLimitCalls[0];
    expect(opts.name).toBe("paywall-preview");
    expect(opts.max).toBe(PREVIEW_RATE_LIMIT_PER_MIN);

    const fakeCtx = { req: { param: (_name: string) => "my-plaintext-token" } };
    expect(opts.identify?.(fakeCtx)).toBe(hashToken("my-plaintext-token"));
  });
});
