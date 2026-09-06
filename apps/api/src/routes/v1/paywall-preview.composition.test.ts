// =============================================================
// Composition-level regression test for the app.ts mount ORDER.
// =============================================================
//
// Fix-round-1: a prior version of app.ts mounted `.route("/v1", v1Route)`
// BEFORE `.route("/", paywallPreviewRoute)`. Hono composes middleware
// across sub-apps in REGISTRATION order, not by mount-path
// specificity — v1Route's `.use("*", apiKeyAuth("any"))` becomes a
// `/v1/*` wildcard in the parent router, and because it was
// registered before this route's exact `/v1/preview/paywalls/:token`
// path, it 401'd every preview request before the handler ever ran.
// Verified empirically against the installed hono version: mounting
// order genuinely changes behavior here, it isn't just a style
// preference.
//
// `paywall-preview.test.ts` builds `new Hono().route("/", paywallPreviewRoute)`
// in isolation and could NOT catch this — it never composites v1Route,
// so the wildcard auth was never in the picture. This file mirrors
// app.ts's actual registration order (paywallPreviewRoute, THEN
// v1Route) using the real `v1Route` and real `apiKeyAuth`, so it would
// have failed against the buggy ordering and passes against the fix.

process.env.NODE_ENV = "test";

import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { v1Route } from "../../routes";
import { paywallPreviewRoute } from "./paywall-preview";

// Mirrors app.ts's real registration order EXACTLY: paywallPreviewRoute
// is registered before v1Route (see the comment at that mount site in
// apps/api/src/app.ts).
function composedApp() {
  const a = new Hono().route("/", paywallPreviewRoute).route("/v1", v1Route);
  a.onError(errorHandler);
  return a;
}

const SESSION = { id: "sess_1", projectId: "proj_1", paywallId: "pw_1" };
const PAYWALL = {
  id: "pw_1",
  projectId: "proj_1",
  updatedAt: new Date("2026-07-20T00:00:00.000Z"),
  builderConfig: { nodes: [] },
};

beforeEach(() => {
  findActiveByHash.mockReset();
  findPaywallById.mockReset();
  hydrateDraftPaywall.mockReset();
});

describe("app.ts mount order: paywallPreviewRoute composed with v1Route", () => {
  it("GET /v1/preview/paywalls/:token succeeds with NO bearer key when composed in app.ts's real order", async () => {
    findActiveByHash.mockResolvedValue(SESSION);
    findPaywallById.mockResolvedValue(PAYWALL);
    hydrateDraftPaywall.mockResolvedValue({ id: "pw_1" });

    const res = await composedApp().request(
      "/v1/preview/paywalls/plaintext-token",
    );

    expect(res.status).toBe(200);
  });

  it("an ordinary /v1/* endpoint still 401s with no bearer key in the SAME composed app (proves the wildcard auth still guards everything else)", async () => {
    const res = await composedApp().request("/v1/config");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      // As of Task 5 (2026-09-06), the missing-Bearer branch in
      // api-key-auth.ts sets a typed `cause`, so this is the specific
      // BEARER_REQUIRED code rather than the generic UNAUTHORIZED
      // fallback — the wildcard `/v1/*` auth still runs, it just now
      // reports a more precise code for this failure mode.
      error: { code: "BEARER_REQUIRED", message: "Bearer token required" },
    });
  });
});
