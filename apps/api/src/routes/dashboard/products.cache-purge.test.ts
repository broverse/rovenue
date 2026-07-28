import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock auth + capability check so we exercise only routing + the
// cache-purge side effect (P6 deferred item 4: resolved-price cache
// busting on catalog mutations).
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../lib/capabilities", () => ({
  assertProjectCapability: async () => {},
}));

const purgeResolvedPriceCache = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../services/offering-price-resolver", async () => {
  const actual = await vi.importActual<any>("../../services/offering-price-resolver");
  return {
    ...actual,
    purgeResolvedPriceCache: (...a: any[]) => purgeResolvedPriceCache(...a),
  };
});

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_1",
    identifier: "pro_monthly",
    type: "SUBSCRIPTION",
    displayName: "Pro Monthly",
    storeIds: {},
    accessIds: [],
    isActive: true,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    androidBasePlanId: null,
    androidOfferId: null,
    ...overrides,
  };
}

const findProductById = vi.fn(async (..._a: unknown[]) => productRow());
const updateProduct = vi.fn(async (..._a: unknown[]) => productRow({ displayName: "Pro Monthly Updated" }));
const listProductGrants = vi.fn(async (..._a: unknown[]) => [] as Array<{ currencyId: string; amount: number }>);

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      productRepo: {
        ...actual.drizzle.productRepo,
        findProductById: (...a: any[]) => findProductById(...a),
        updateProduct: (...a: any[]) => updateProduct(...a),
      },
      productCurrencyGrantRepo: {
        ...actual.drizzle.productCurrencyGrantRepo,
        listProductGrants: (...a: any[]) => listProductGrants(...a),
      },
    },
  };
});

import { Hono } from "hono";
import { productsDashboardRoute } from "./products";
import { errorHandler } from "../../middleware/error";

function app() {
  const a = new Hono().route("/dashboard/projects/:projectId/products", productsDashboardRoute);
  a.onError(errorHandler);
  return a;
}

beforeEach(() => {
  purgeResolvedPriceCache.mockClear();
  findProductById.mockClear();
  updateProduct.mockClear();
  listProductGrants.mockClear();
});

describe("PATCH /:id — resolved-price cache busting", () => {
  it("fires purgeResolvedPriceCache for the project on a successful update", async () => {
    const res = await app().request("/dashboard/projects/p1/products/prod_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Pro Monthly Updated" }),
    });

    expect(res.status).toBe(200);
    expect(purgeResolvedPriceCache).toHaveBeenCalledWith("p1");
  });
});
