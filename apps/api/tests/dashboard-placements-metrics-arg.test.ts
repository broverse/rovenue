import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /dashboard/projects/:projectId/placements/:id/metrics —
// identifier-vs-DB-id seam test
// =============================================================
//
// ClickHouse paywall rows key on the placement's BUSINESS identifier
// (the SDK's presentedContext carries placement.identifier), while the
// dashboard route is addressed by the DB id. This test pins the seam:
// the route must pass placement.identifier — not the route param's DB
// id — into computePlacementMetrics, otherwise the metrics card
// matches zero ClickHouse rows forever.
//
// Mounts the inner route with a light middleware shim for `user`
// (mirrors v1-experiments-expose.test.ts) so we bypass the dashboard
// auth chain.

const computePlacementMetricsMock = vi.hoisted(() =>
  vi.fn(async () => ({
    views: 0,
    uniqueViews: 0,
    purchases: 0,
    conversionRate: null,
  })),
);

vi.mock("../src/services/placement-metrics", () => ({
  computePlacementMetrics: computePlacementMetricsMock,
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/capabilities", () => ({
  assertProjectCapability: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: vi.fn(async () => undefined),
}));

vi.mock("@rovenue/db", () => ({
  MemberRole: { CUSTOMER_SUPPORT: "CUSTOMER_SUPPORT" },
  drizzle: {
    db: {} as unknown,
    placementRepo: {
      findPlacementById: vi.fn(async (_db: unknown, _projectId: string, id: string) => ({
        id,
        projectId: "proj_test",
        identifier: "onboarding_end",
        name: "Onboarding end",
        revision: 3,
        rows: [],
        isActive: true,
      })),
    },
  },
}));

import { Hono } from "hono";
import { placementsDashboardRoute } from "../src/routes/dashboard/placements";

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, { id: "user_test" } as never);
    await next();
  });
  app.route("/dashboard/projects/:projectId/placements", placementsDashboardRoute);
  return app;
}

describe("GET /placements/:id/metrics identifier seam", () => {
  beforeEach(() => {
    computePlacementMetricsMock.mockClear();
  });

  it("passes placement.identifier (not the DB id) to computePlacementMetrics", async () => {
    const app = buildApp();
    const res = await app.request(
      "/dashboard/projects/proj_test/placements/plc_dbid_123/metrics",
    );
    expect(res.status).toBe(200);
    expect(computePlacementMetricsMock).toHaveBeenCalledTimes(1);
    expect(computePlacementMetricsMock).toHaveBeenCalledWith(
      "onboarding_end",
      "proj_test",
    );
  });
});
