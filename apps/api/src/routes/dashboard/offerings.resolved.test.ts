import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock auth + access so we exercise only routing + envelope mapping.
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));

const assertProjectAccess = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../lib/project-access", () => ({
  assertProjectAccess: (...a: any[]) => assertProjectAccess(...a),
}));

const resolveOfferingPrices = vi.fn();
vi.mock("../../services/offering-price-resolver", async () => {
  const actual = await vi.importActual<any>(
    "../../services/offering-price-resolver",
  );
  return {
    ...actual,
    resolveOfferingPrices: (...a: any[]) => resolveOfferingPrices(...a),
  };
});

import { Hono } from "hono";
import { MemberRole } from "@rovenue/db";
import { offeringsDashboardRoute } from "./offerings";
import { errorHandler } from "../../middleware/error";

function app() {
  const a = new Hono().route(
    "/dashboard/projects/:projectId/offerings",
    offeringsDashboardRoute,
  );
  a.onError(errorHandler);
  return a;
}

beforeEach(() => {
  assertProjectAccess.mockClear();
  resolveOfferingPrices.mockReset();
});

describe("GET /:id/resolved", () => {
  it("returns the resolved prices envelope on success", async () => {
    const resolved = {
      offeringId: "off_1",
      packages: [
        {
          packageIdentifier: "$rov_monthly",
          productId: "prod_1",
          displayName: "Monthly",
          metadataPeriod: "P1M",
          stores: { apple: { status: "ok", priceMicros: 9990000, currency: "USD" } },
        },
      ],
      fetchedAt: "2026-07-27T00:00:00.000Z",
    };
    resolveOfferingPrices.mockResolvedValue(resolved);

    const res = await app().request(
      "/dashboard/projects/p1/offerings/off_1/resolved",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: resolved });
    expect(resolveOfferingPrices).toHaveBeenCalledWith("p1", "off_1");
  });

  it("returns 404 when the resolver returns null", async () => {
    resolveOfferingPrices.mockResolvedValue(null);

    const res = await app().request(
      "/dashboard/projects/p1/offerings/off_missing/resolved",
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Offering not found" },
    });
  });

  it("asserts project access with CUSTOMER_SUPPORT", async () => {
    resolveOfferingPrices.mockResolvedValue({
      offeringId: "off_1",
      packages: [],
      fetchedAt: "2026-07-27T00:00:00.000Z",
    });

    await app().request("/dashboard/projects/p1/offerings/off_1/resolved");

    expect(assertProjectAccess).toHaveBeenCalledWith(
      "p1",
      "u1",
      MemberRole.CUSTOMER_SUPPORT,
    );
  });
});
