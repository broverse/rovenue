import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// POST /dashboard/projects/:projectId/paywalls/from-app-store (P8
// §6.14): builds and RETURNS a draft tree — creates nothing. Route
// mocking idiom mirrors products.store-catalog.test.ts (auth +
// access mocked at module level, service mocked for determinism).
// =============================================================

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));
vi.mock("../../lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
}));

const fetchAppStoreListing = vi.hoisted(() => vi.fn());
const createPaywall = vi.hoisted(() => vi.fn());
vi.mock("../../services/paywall-ai/app-store-import", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAppStoreListing: (...args: unknown[]) => fetchAppStoreListing(...args),
}));
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      paywallRepo: { ...actual.drizzle.paywallRepo, createPaywall },
    },
  };
});

import { paywallsDashboardRoute } from "./paywalls";
import { errorHandler } from "../../middleware/error";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/paywalls", paywallsDashboardRoute);
}

const LISTING = {
  name: "Super App",
  description: "The best app.",
  iconUrl: "https://is1-ssl.mzstatic.com/icon512.png",
  screenshotUrls: ["https://is1-ssl.mzstatic.com/s1.png"],
  artistName: "Super Corp",
};

beforeEach(() => {
  assertProjectAccess.mockReset().mockResolvedValue(undefined);
  fetchAppStoreListing.mockReset().mockResolvedValue(LISTING);
  createPaywall.mockReset();
});

async function post(url: string) {
  return app().request("/dashboard/projects/p1/paywalls/from-app-store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("POST /paywalls/from-app-store", () => {
  it("returns the built config + metadata and never writes a paywall", async () => {
    const res = await post("https://apps.apple.com/tr/app/super-app/id123");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { config: { root: { type: string } }; metadata: { name: string; iconUrl: string } };
    };
    expect(body.data.config.root.type).toBe("stack");
    expect(body.data.metadata).toEqual({ name: "Super App", iconUrl: LISTING.iconUrl });
    expect(createPaywall).not.toHaveBeenCalled();
  });

  it("400s on an unparseable store URL", async () => {
    const res = await post("https://example.com/whatever");
    expect(res.status).toBe(400);
    expect(fetchAppStoreListing).not.toHaveBeenCalled();
  });

  it("422s with the typed code when the lookup fails", async () => {
    const { AppStoreLookupError } = await vi.importActual<
      typeof import("../../services/paywall-ai/app-store-import")
    >("../../services/paywall-ai/app-store-import");
    fetchAppStoreListing.mockRejectedValue(new AppStoreLookupError("APP_NOT_FOUND"));
    const res = await post("https://apps.apple.com/tr/app/super-app/id123");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    // The typed code must land in error.CODE — a generic HTTPException
    // would bury it in message under HTTP_ERROR (review round 1 finding).
    expect(body.error.code).toBe("APP_NOT_FOUND");
  });

  it("gates on project access before fetching", async () => {
    assertProjectAccess.mockRejectedValue(Object.assign(new Error("no"), { status: 403 }));
    await post("https://apps.apple.com/tr/app/super-app/id123");
    expect(assertProjectAccess).toHaveBeenCalled();
    expect(fetchAppStoreListing).not.toHaveBeenCalled();
  });
});
