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

// `validateFunnelGraph` runs BEFORE the gate and rejects any funnel with
// no paywall page (MISSING_PAYWALL, unconditional). That makes the gate's
// own `pages.some(p => p.type === "paywall")` branch unreachable through
// the real validator — so one test overrides the result to reach it.
// Default is null, meaning "use the real validator"; setting a value is
// how a test forces graph validation to pass.
const validateOverride = vi.hoisted(() => ({
  value: null as { ok: boolean; issues?: unknown[]; warnings: unknown[] } | null,
}));
vi.mock("../src/services/funnel/branching-validator", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/services/funnel/branching-validator")
    >();
  return {
    ...actual,
    validateFunnelGraph: (pages: Parameters<typeof actual.validateFunnelGraph>[0]) =>
      validateOverride.value ?? actual.validateFunnelGraph(pages),
  };
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
    validateOverride.value = null;
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

  it("rejects a paywall-free funnel at graph validation, before the gate", async () => {
    // NOTE: this does NOT prove the gate's internal ordering. Graph
    // validation rejects MISSING_PAYWALL one step earlier, so execution
    // never reaches the gate at all — chargesEnabled would be uncalled
    // even if the gate looked it up unconditionally. The ordering is
    // pinned by the next test instead. What this pins is that the two
    // checks stay in this order relative to each other.
    findFunnelById.mockResolvedValue(funnel(noPaywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("FUNNEL_VALIDATION");
    expect(chargesEnabled).not.toHaveBeenCalled();
  });

  it("skips the capability lookup when the funnel has no paywall page", async () => {
    // Forces graph validation to pass on a paywall-free funnel, which the
    // real validator never allows (MISSING_PAYWALL). That is the only way
    // to reach the gate's own `pages.some(p => p.type === "paywall")`
    // branch, so this is what actually pins the ordering the plan calls
    // load-bearing: a funnel with nothing to charge for must not cost a
    // database round trip.
    validateOverride.value = { ok: true, warnings: [] };
    findFunnelById.mockResolvedValue(funnel(noPaywallPages));
    chargesEnabled.mockResolvedValue(false);

    const res = await publish();

    expect(res.status).toBe(200);
    expect(chargesEnabled).not.toHaveBeenCalled();
    expect(insertVersion).toHaveBeenCalled();
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
