import { describe, expect, it, vi, beforeEach } from "vitest";

// =============================================================
// Dashboard placements — audit-log coverage (P7 deferred item 1)
// =============================================================
//
// The create/update/delete handlers in placements.ts wrote no audit
// entries. Same mocking idiom as products.store-catalog.test.ts /
// products.cache-purge.test.ts: mock auth + capability + edge-cache so
// only routing + the audit() side effect is exercised, and stub the
// placementRepo functions on the real @rovenue/db barrel.

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../lib/capabilities", () => ({
  assertProjectCapability: async () => {},
}));
vi.mock("../../lib/edge-cache", () => ({
  purgeProjectCatalogCache: () => {},
}));

const auditMock = vi.hoisted(() => vi.fn(async (..._args: any[]) => undefined));
vi.mock("../../lib/audit", () => ({
  audit: (...a: any[]) => auditMock(...a),
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

const PROJECT_ID = "p1";
const PLACEMENT_ID = "plc_1";
const PLACEMENT_IDENTIFIER = "onboarding";

function placementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACEMENT_ID,
    projectId: PROJECT_ID,
    identifier: PLACEMENT_IDENTIFIER,
    name: "Onboarding",
    revision: 1,
    rows: [],
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const findPlacementByIdentifier = vi.fn(async (..._a: unknown[]) => null as unknown);
const createPlacement = vi.fn(async (..._a: unknown[]) => placementRow());
const findPlacementById = vi.fn(async (..._a: unknown[]) => placementRow() as unknown);
const updatePlacement = vi.fn(async (..._a: unknown[]) => placementRow({ name: "Updated" }) as unknown);
const deletePlacement = vi.fn(async (..._a: unknown[]) => true);

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      placementRepo: {
        ...actual.drizzle.placementRepo,
        findPlacementByIdentifier: (...a: any[]) => findPlacementByIdentifier(...a),
        createPlacement: (...a: any[]) => createPlacement(...a),
        findPlacementById: (...a: any[]) => findPlacementById(...a),
        updatePlacement: (...a: any[]) => updatePlacement(...a),
        deletePlacement: (...a: any[]) => deletePlacement(...a),
      },
    },
  };
});

import { Hono } from "hono";
import { placementsDashboardRoute } from "./placements";
import { errorHandler } from "../../middleware/error";

function app() {
  const a = new Hono().route(
    "/dashboard/projects/:projectId/placements",
    placementsDashboardRoute,
  );
  a.onError(errorHandler);
  return a;
}

beforeEach(() => {
  auditMock.mockClear();
  findPlacementByIdentifier.mockClear();
  createPlacement.mockClear();
  findPlacementById.mockClear();
  updatePlacement.mockClear();
  deletePlacement.mockClear();
  findPlacementByIdentifier.mockResolvedValue(null);
  findPlacementById.mockResolvedValue(placementRow());
  createPlacement.mockResolvedValue(placementRow());
  updatePlacement.mockResolvedValue(placementRow({ name: "Updated" }));
  deletePlacement.mockResolvedValue(true);
});

describe("POST /dashboard/projects/:projectId/placements", () => {
  it("writes a create audit entry with an identifier + rows snapshot", async () => {
    const res = await app().request(`/dashboard/projects/${PROJECT_ID}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: PLACEMENT_IDENTIFIER, name: "Onboarding" }),
    });

    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        userId: "u1",
        action: "create",
        resource: "placement",
        resourceId: PLACEMENT_ID,
        after: expect.objectContaining({ identifier: PLACEMENT_IDENTIFIER, rows: [] }),
      }),
    );
  });
});

describe("PATCH /dashboard/projects/:projectId/placements/:id", () => {
  it("writes an update audit entry with before/after snapshots", async () => {
    const res = await app().request(
      `/dashboard/projects/${PROJECT_ID}/placements/${PLACEMENT_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      },
    );

    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        userId: "u1",
        action: "update",
        resource: "placement",
        resourceId: PLACEMENT_ID,
        before: expect.objectContaining({ identifier: PLACEMENT_IDENTIFIER, rows: [] }),
        after: expect.objectContaining({ identifier: PLACEMENT_IDENTIFIER }),
      }),
    );
  });
});

describe("DELETE /dashboard/projects/:projectId/placements/:id", () => {
  it("writes a delete audit entry with the pre-delete snapshot", async () => {
    const res = await app().request(
      `/dashboard/projects/${PROJECT_ID}/placements/${PLACEMENT_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        userId: "u1",
        action: "delete",
        resource: "placement",
        resourceId: PLACEMENT_ID,
        before: expect.objectContaining({ identifier: PLACEMENT_IDENTIFIER, rows: [] }),
      }),
    );
  });

  it("does not audit when the placement does not exist", async () => {
    findPlacementById.mockResolvedValueOnce(null);
    const res = await app().request(
      `/dashboard/projects/${PROJECT_ID}/placements/plc_missing`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
