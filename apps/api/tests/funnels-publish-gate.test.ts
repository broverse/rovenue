import { beforeEach, describe, expect, it, vi } from "vitest";

const chargesEnabled = vi.hoisted(() => vi.fn());
const findFunnelById = vi.hoisted(() => vi.fn());
const nextVersionNo = vi.hoisted(() => vi.fn(async () => 1));
const insertVersion = vi.hoisted(() => vi.fn(async () => ({ id: "ver_1", versionNo: 1 })));
const setCurrentVersion = vi.hoisted(() => vi.fn());
const auditFn = vi.hoisted(() => vi.fn(async () => undefined));

// Redis is not running in this environment. The success path calls
// invalidatePublishedConfig(slug) -> redis.del after the transaction
// commits, so an unmocked client would reject and turn a 200 into a
// 500 that has nothing to do with the gate under test.
vi.mock("../src/lib/redis", () => ({
  redis: { del: vi.fn(async () => 1) },
}));

// The route calls audit() with the (stubbed) transaction handle from
// the @rovenue/db mock below, which has no query-builder surface;
// the real audit() would explode on tx.execute. Stub it the same way
// stripe-connect-routes.test.ts does, and keep extractRequestContext
// real since it only reads headers off the Hono context.
vi.mock("../src/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit")>();
  return { ...actual, audit: auditFn };
});

vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return { ...actual, chargesEnabled };
});

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      // usageLockGuard runs on every /projects/:projectId/* dashboard
      // route and calls this with the (stubbed) drizzle.db above, which
      // has no query-builder surface. Stub it out so this suite exercises
      // the publish gate, not the usage-lock guard.
      projectRepo: {
        ...actual.drizzle.projectRepo,
        findProjectById: vi.fn(async () => null),
      },
      funnelRepo: { findById: findFunnelById, setCurrentVersion },
      funnelVersionRepo: { nextVersionNo, insert: insertVersion },
    },
  };
});

const paywallPages = [
  { id: "p1", type: "info", title: "Hi" },
  { id: "p2", type: "paywall", headline: "Unlock" },
  { id: "p3", type: "success", headline: "Done" },
];
const noPaywallPages = [
  { id: "p1", type: "info", title: "Hi" },
  { id: "p3", type: "success", headline: "Done" },
];

function funnel(pages: unknown[]) {
  return {
    id: "fnl_1",
    projectId: "proj_1",
    slug: "onboarding",
    draftPagesJson: pages,
    draftThemeJson: {},
    draftSettingsJson: {},
  };
}

const publishPath = "/dashboard/projects/proj_1/funnels/fnl_1/publish";

async function publish() {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  return createApp().request(publishPath, { method: "POST" });
}

describe("funnel publish paywall gate", () => {
  beforeEach(() => {
    chargesEnabled.mockReset();
    findFunnelById.mockReset();
    insertVersion.mockClear();
    auditFn.mockClear();
  });

  it("rejects with STRIPE_NOT_CONNECTED when the project cannot take charges", async () => {
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("STRIPE_NOT_CONNECTED");
    expect(insertVersion).not.toHaveBeenCalled();
  });

  it("publishes a paywall funnel when charges are enabled", async () => {
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(true);
    const res = await publish();
    expect(res.status).toBe(200);
    expect(insertVersion).toHaveBeenCalled();
  });

  it("never asks chargesEnabled for a funnel with no paywall page", async () => {
    // `validateFunnelGraph` (pre-existing, out of scope for this gate)
    // already requires every publishable funnel to contain a paywall
    // page — MISSING_PAYWALL — so a paywall-free draft 400s at graph
    // validation, one step before this gate ever runs. That still
    // proves what matters here: `pages.some(p => p.type === "paywall")`
    // is checked before any capability lookup, so a funnel with
    // nothing to charge for never triggers a chargesEnabled db round
    // trip. It is NOT a 200 — see branching-validator.test.ts for the
    // MISSING_PAYWALL contract this route rejects earlier on.
    findFunnelById.mockResolvedValue(funnel(noPaywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("FUNNEL_VALIDATION");
    expect(chargesEnabled).not.toHaveBeenCalled();
  });

  it("applies the gate outside production too", async () => {
    // The old placeholder only ran when NODE_ENV === "production", which
    // let unpublishable funnels through everywhere else.
    expect(process.env.NODE_ENV).not.toBe("production");
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
  });
});
