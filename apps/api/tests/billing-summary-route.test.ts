import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// Route test: GET /dashboard/projects/:projectId/billing
// =============================================================
// We mount the billing sub-router on a fresh Hono instance and
// inject a fake user via middleware so the handler runs without
// the real dashboard auth stack. The summary service +
// project-access guard are mocked — this test is about the route
// surface (status codes, response shape, feature flag), not the
// underlying assembly which has its own unit test.

const { buildBillingSummary } = vi.hoisted(() => ({
  buildBillingSummary: vi.fn(),
}));
vi.mock("../src/services/billing/billing-summary", () => ({
  buildBillingSummary,
}));

vi.mock("../src/lib/billing-flags", () => ({
  isBillingEnabled: vi.fn(() => true),
}));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
}));

// `db` is passed through to the mocked service so any value works.
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@rovenue/db");
  return {
    ...actual,
    db: {},
  };
});

import { billingSubRouter } from "../src/routes/dashboard/billing";
import { isBillingEnabled } from "../src/lib/billing-flags";

function mountAppWithUser() {
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "u1", email: "test@example.com" } as never);
      c.set("session", { id: "s1" } as never);
      await next();
    })
    .route("/projects/:projectId/billing", billingSubRouter);
  return app;
}

describe("GET /dashboard/projects/:projectId/billing", () => {
  it("returns the summary inside { data }", async () => {
    buildBillingSummary.mockResolvedValue({
      state: "free",
      tier: "free",
      cycle: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      hasStripeCustomer: false,
    });
    const app = mountAppWithUser();
    const res = await app.request("/projects/p1/billing");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.state).toBe("free");
    expect(body.data.hasStripeCustomer).toBe(false);
  });

  it("returns 404 when billing is disabled", async () => {
    (isBillingEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const app = mountAppWithUser();
    const res = await app.request("/projects/p1/billing");
    expect(res.status).toBe(404);
  });
});
