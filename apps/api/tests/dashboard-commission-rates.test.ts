import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// PUT/DELETE /dashboard/projects/:projectId/commission-rates/:store
// =============================================================
//
// The commission rate is the most consequential number in the proceeds
// feature: every "estimated at X%" figure in the project is derived from
// it, and it is a config write, not an append — a change overwrites the
// old value with no history anywhere else. So the audit chain is the ONLY
// record of who moved it and from what. Without it, "every proceeds figure
// shifted overnight" is unanswerable.
//
// Precedent: routes/dashboard/refund-shield/settings.ts, the closest
// analogue (a small per-project config PUT), audits — as do ~17 other
// dashboard mutation routes. This route also runs the write and the audit
// in ONE transaction (audit() takes a caller tx precisely for this), which
// refund-shield cannot do because it is on the non-tx getDb() path.
//
// Route-level mocks mirror charts-series.test.ts: mount the inner route
// with a `user` shim, mock the auth/capability gates and the repository.

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/lib/audit", () => ({
  audit: auditMock,
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const assertProjectCapabilityMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../src/lib/capabilities", () => ({
  assertProjectCapability: assertProjectCapabilityMock,
}));

const getCommissionRateMock = vi.hoisted(() => vi.fn());
const upsertCommissionRateMock = vi.hoisted(() => vi.fn());
const deleteCommissionRateMock = vi.hoisted(() => vi.fn(async () => undefined));
const listCommissionRatesMock = vi.hoisted(() => vi.fn(async () => []));

// The tx handed to the callback — the route passes it to BOTH the repo
// write and audit(), which is the property these tests pin.
const TX = { __tx: true };

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(TX),
      },
      commissionRateRepo: {
        getCommissionRate: getCommissionRateMock,
        listCommissionRates: listCommissionRatesMock,
        upsertCommissionRate: upsertCommissionRateMock,
        deleteCommissionRate: deleteCommissionRateMock,
      },
    },
  };
});

import { Hono } from "hono";
import { commissionRatesRoute } from "../src/routes/dashboard/commission-rates";

const PROJECT = "proj_1";

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, { id: "user_test" } as never);
    await next();
  });
  app.route("/dashboard/projects/:projectId/commission-rates", commissionRatesRoute);
  return app;
}

function put(store: string, rate: number) {
  return buildApp().request(
    `/dashboard/projects/${PROJECT}/commission-rates/${store}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rate }),
    },
  );
}

function del(store: string) {
  return buildApp().request(
    `/dashboard/projects/${PROJECT}/commission-rates/${store}`,
    { method: "DELETE" },
  );
}

describe("commission-rates audit trail", () => {
  beforeEach(() => {
    auditMock.mockClear();
    getCommissionRateMock.mockReset();
    upsertCommissionRateMock.mockReset();
    deleteCommissionRateMock.mockClear();
    assertProjectCapabilityMock.mockClear();
  });

  it("records the rate change from what to what on PUT", async () => {
    getCommissionRateMock.mockResolvedValue({
      projectId: PROJECT,
      store: "APP_STORE",
      rate: "0.1500",
    });
    upsertCommissionRateMock.mockResolvedValue({
      projectId: PROJECT,
      store: "APP_STORE",
      rate: "0.3000",
    });

    const res = await put("APP_STORE", 0.3);
    expect(res.status).toBe(200);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [entry, tx] = auditMock.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(entry).toMatchObject({
      projectId: PROJECT,
      userId: "user_test",
      action: "commission_rate.updated",
      resource: "commission_rate",
      resourceId: "APP_STORE",
      before: { store: "APP_STORE", rate: 0.15 },
      after: { store: "APP_STORE", rate: 0.3 },
    });
    // Same transaction as the write: a rolled-back rate change must not
    // leave an audit row claiming it happened.
    expect(tx).toBe(TX);
    expect(upsertCommissionRateMock.mock.calls[0]?.[0]).toBe(TX);
  });

  it("records a first-time configuration as a null before, never as 0%", async () => {
    getCommissionRateMock.mockResolvedValue(null);
    upsertCommissionRateMock.mockResolvedValue({
      projectId: PROJECT,
      store: "PLAY_STORE",
      rate: "0.1500",
    });

    await put("PLAY_STORE", 0.15);

    const [entry] = auditMock.mock.calls[0] as [Record<string, unknown>];
    expect(entry.before).toEqual({ store: "PLAY_STORE", rate: null });
    expect(entry.after).toEqual({ store: "PLAY_STORE", rate: 0.15 });
  });

  it("records what the rate was on DELETE", async () => {
    getCommissionRateMock.mockResolvedValue({
      projectId: PROJECT,
      store: "STRIPE",
      rate: "0.0290",
    });

    const res = await del("STRIPE");
    expect(res.status).toBe(200);

    const [entry, tx] = auditMock.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(entry).toMatchObject({
      action: "commission_rate.deleted",
      resource: "commission_rate",
      resourceId: "STRIPE",
      before: { store: "STRIPE", rate: 0.029 },
      after: null,
    });
    expect(tx).toBe(TX);
    expect(deleteCommissionRateMock.mock.calls[0]?.[0]).toBe(TX);
  });

  it("writes no audit row for a DELETE that removed nothing", async () => {
    getCommissionRateMock.mockResolvedValue(null);

    const res = await del("STRIPE");

    expect(res.status).toBe(200);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
