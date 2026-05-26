import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// Route test: POST /dashboard/projects/:projectId/billing/upgrade
// =============================================================
// Mirrors the T19 summary route test pattern: mount the billing
// sub-router on a fresh Hono with a fake-user middleware so the
// handler runs without the real dashboard auth stack. We mock the
// upgrade service + project-access guard + feature flag — this
// test covers the route surface (status codes, validator,
// error->HTTP mapping), not the underlying Stripe flow which has
// its own unit test in upgrade-project.test.ts.

const { upgradeProject, isBillingEnabled, assertProjectAccess } = vi.hoisted(
  () => ({
    upgradeProject: vi.fn(),
    isBillingEnabled: vi.fn(() => true),
    assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
  }),
);

vi.mock("../src/services/billing/upgrade-project", () => ({ upgradeProject }));
vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled }));
vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));
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
      c.set("user", { id: "u1" } as never);
      c.set("session", { id: "s1" } as never);
      await next();
    })
    .route("/projects/:projectId/billing", billingSubRouter);
}

describe("POST /dashboard/projects/:projectId/billing/upgrade", () => {
  it("returns clientSecret + publishableKey on success", async () => {
    upgradeProject.mockResolvedValue({
      clientSecret: "seti_cs_xyz",
      publishableKey: "pk_test_xxx",
    });
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycle: "monthly" }),
      },
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.clientSecret).toBe("seti_cs_xyz");
  });

  it("returns 409 when already active", async () => {
    const err = Object.assign(new Error("state=active"), {
      code: "already_active",
    });
    upgradeProject.mockRejectedValue(err);
    const res = await mountAppWithUser().request(
      "/projects/p2/billing/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycle: "monthly" }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when cycle !== monthly (annual deferred to P6)", async () => {
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycle: "annual" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when billing disabled", async () => {
    isBillingEnabled.mockReturnValueOnce(false);
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycle: "monthly" }),
      },
    );
    // Note: when billing is disabled, the route handler short-circuits
    // with 404 — but zValidator runs BEFORE the handler, so the body
    // must still parse. cycle: "monthly" satisfies that.
    expect(res.status).toBe(404);
  });
});
