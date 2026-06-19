import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// Route test: GET /dashboard/projects/:projectId/billing/usage
// =============================================================
// We mount the billing sub-router on a fresh Hono instance and
// inject a fake user via middleware so the handler runs without
// the real dashboard auth stack. The usage service +
// project-access guard are mocked — this test is about the route
// surface (status codes, response shape, feature flag), not the
// underlying computation which has its own unit test.

const { buildUsageReport, isBillingEnabled, assertProjectAccess } = vi.hoisted(
  () => ({
    buildUsageReport: vi.fn(),
    isBillingEnabled: vi.fn(() => true),
    assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
  }),
);

vi.mock("../src/services/billing/usage", () => ({ buildUsageReport }));
vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled }));
vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));

// `db` is passed through to the mocked service so any value works.
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    db: {},
  };
});

import { billingSubRouter } from "../src/routes/dashboard/billing";

function mountAppWithUser() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "u1", email: "test@example.com" } as never);
      c.set("session", { id: "s1" } as never);
      await next();
    })
    .route("/projects/:projectId/billing", billingSubRouter);
}

describe("GET /dashboard/projects/:projectId/billing/usage", () => {
  it("returns 200 with the usage report inside { data }", async () => {
    buildUsageReport.mockResolvedValue({
      tier: "pro",
      cycle: "monthly",
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
      meters: [
        {
          key: "mtr",
          current: 1234,
          limit: 50000,
          cap: "soft",
          unit: "usd",
          available: true,
        },
        {
          key: "events",
          current: 500,
          limit: 100000,
          cap: "hard",
          unit: "count",
          available: true,
        },
        {
          key: "sql_queries",
          current: 10,
          limit: 1000,
          cap: "hard",
          unit: "count",
          available: true,
        },
      ],
    });
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/usage",
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.tier).toBe("pro");
    expect(body.data.meters).toHaveLength(3);
    expect(body.data.meters[0].key).toBe("mtr");
    expect(body.data.meters[0].current).toBe(1234);
    expect(body.data.periodStart).toBe("2026-05-01T00:00:00.000Z");
  });

  it("returns 404 when billing is disabled", async () => {
    isBillingEnabled.mockReturnValueOnce(false);
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/usage",
    );
    expect(res.status).toBe(404);
  });
});
