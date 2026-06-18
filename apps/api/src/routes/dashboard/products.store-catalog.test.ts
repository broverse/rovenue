import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock auth + service so we exercise only routing + envelope mapping.
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../lib/project-access", () => ({ assertProjectAccess: async () => {} }));

const getStoreCatalog = vi.fn();
vi.mock("../../services/store-catalog", async () => {
  const actual = await vi.importActual<any>("../../services/store-catalog");
  return { ...actual, getStoreCatalog: (...a: any[]) => getStoreCatalog(...a) };
});

import { Hono } from "hono";
import { productsDashboardRoute } from "./products";
import { StoreCatalogError } from "../../services/store-catalog";

function app() {
  return new Hono().route("/dashboard/projects/:projectId/products", productsDashboardRoute);
}

beforeEach(() => getStoreCatalog.mockReset());

describe("GET /store-catalog", () => {
  it("returns items in the data envelope", async () => {
    getStoreCatalog.mockResolvedValue([
      { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly", alreadyImported: false },
    ]);
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=ios");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { items: [{ storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly", alreadyImported: false }] },
    });
  });

  it("maps StoreCatalogError to the error envelope", async () => {
    getStoreCatalog.mockRejectedValueOnce(
      new StoreCatalogError("STORE_NOT_CONFIGURED", "nope", 400),
    );
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=android");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "STORE_NOT_CONFIGURED", message: "nope" } });
  });

  it("rejects store=web", async () => {
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=web");
    expect(res.status).toBe(400);
  });
});
