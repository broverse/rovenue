import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /dashboard/experiments/:id/stop — winner repoint (P7 task 3)
// =============================================================
//
// Exercises the REAL stop handler against a mocked `@rovenue/db` barrel.
// The mock's `db.transaction` splits every repo write into a per-call
// `pending` buffer that is only merged into the shared `state.committed`
// store once the transaction callback resolves — mirroring real Postgres
// ROLLBACK (same idiom as paywalls.experiments.test.ts).

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));

const assertProjectCapability = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _userId: string, _cap: string) => ({
    id: "m1",
    role: "OWNER",
  })),
);
vi.mock("../../lib/capabilities", () => ({ assertProjectCapability }));

const auditMock = vi.hoisted(() =>
  vi.fn(async (_entry: any, _tx?: any) => undefined),
);
vi.mock("../../lib/audit", () => ({
  audit: auditMock,
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

const purgeProjectCatalogCache = vi.hoisted(() => vi.fn());
vi.mock("../../lib/edge-cache", () => ({ purgeProjectCatalogCache }));

const invalidateExperimentCache = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../services/experiment-engine", () => ({ invalidateExperimentCache }));

const invalidateFlagCache = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../services/flag-engine", () => ({ invalidateFlagCache }));

// -------------------------------------------------------------
// In-memory `@rovenue/db` state.
// -------------------------------------------------------------

type Row = Record<string, any>;

const state = vi.hoisted(() => ({
  committed: {
    experiments: {} as Record<string, any>,
    placements: {} as Record<string, any>,
    featureFlags: {} as Record<string, any>,
  },
  calls: [] as string[],
  nextId: 1,
}));

function freshId(prefix: string): string {
  return `${prefix}_${state.nextId++}`;
}

function storeFor(dbOrTx: any) {
  return dbOrTx && dbOrTx.__pending ? dbOrTx.__pending : state.committed;
}

const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: any) => Promise<any>) => {
    const pending = {
      experiments: { ...state.committed.experiments },
      placements: { ...state.committed.placements },
      featureFlags: { ...state.committed.featureFlags },
    };
    const tx = { __pending: pending };
    const result = await fn(tx); // throws propagate — pending is discarded, never merged
    state.committed = pending;
    return result;
  }),
);

const findExperimentById = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, id: string) => {
    state.calls.push(`experimentRepo.findExperimentById:${id}`);
    return storeFor(dbOrTx).experiments[id] ?? null;
  }),
);

const updateExperiment = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, id: string, patch: any) => {
    state.calls.push(`experimentRepo.updateExperiment:${id}`);
    const store = storeFor(dbOrTx);
    const existing = store.experiments[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    store.experiments[id] = updated;
    return updated;
  }),
);

const listPlacements = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, projectId: string) => {
    state.calls.push("placementRepo.listPlacements");
    const store = storeFor(dbOrTx);
    return Object.values(store.placements).filter((p: any) => p.projectId === projectId);
  }),
);

const updatePlacement = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, _projectId: string, id: string, patch: any) => {
    state.calls.push(`placementRepo.updatePlacement:${id}`);
    const store = storeFor(dbOrTx);
    const existing = store.placements[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    store.placements[id] = updated;
    return updated;
  }),
);

const createFeatureFlag = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, input: any) => {
    state.calls.push(`flagRepo.createFeatureFlag:${input.key}`);
    const store = storeFor(dbOrTx);
    const row = { id: freshId("flag"), ...input };
    store.featureFlags[row.id] = row;
    return row;
  }),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction },
      experimentRepo: {
        ...actual.drizzle.experimentRepo,
        findExperimentById,
        updateExperiment,
      },
      placementRepo: {
        ...actual.drizzle.placementRepo,
        listPlacements,
        updatePlacement,
      },
      dashboardFeatureFlagRepo: {
        ...actual.drizzle.dashboardFeatureFlagRepo,
        createFeatureFlag,
      },
    },
  };
});

const { Hono } = await import("hono");
const { experimentsRoute } = await import("./experiments");
const { errorHandler } = await import("../../middleware/error");

function app() {
  const a = new Hono().route("/dashboard/experiments", experimentsRoute);
  a.onError(errorHandler);
  return a;
}

const PROJECT_ID = "p1";

function seedExperiment(overrides: Partial<Row> & { id: string }): Row {
  const row = {
    projectId: PROJECT_ID,
    key: overrides.id,
    name: "Experiment",
    type: "PAYWALL",
    status: "RUNNING",
    audienceId: "aud1",
    variants: [
      { id: "a", name: "A", value: { paywallId: "pwA" }, weight: 0.5 },
      { id: "b", name: "B", value: { paywallId: "pwB" }, weight: 0.5 },
    ],
    ...overrides,
  };
  state.committed.experiments[row.id] = row;
  return row;
}

function seedPlacement(overrides: Partial<Row> & { id: string; rows: unknown }): Row {
  const row = {
    projectId: PROJECT_ID,
    identifier: overrides.id,
    name: "Placement",
    isActive: true,
    revision: 1,
    ...overrides,
  };
  state.committed.placements[row.id] = row;
  return row;
}

beforeEach(() => {
  state.committed = { experiments: {}, placements: {}, featureFlags: {} };
  state.calls = [];
  state.nextId = 1;
  assertProjectCapability.mockClear();
  auditMock.mockClear();
  purgeProjectCatalogCache.mockClear();
  invalidateExperimentCache.mockClear();
  invalidateFlagCache.mockClear();
  for (const fn of [
    findExperimentById,
    updateExperiment,
    listPlacements,
    updatePlacement,
    createFeatureFlag,
    transaction,
  ]) {
    fn.mockClear();
  }
});

async function stop(id: string, body?: Record<string, unknown>) {
  return app().request(`/dashboard/experiments/${id}/stop`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("POST /dashboard/experiments/:id/stop", () => {
  it("(a) winner repoints only rows targeting this experiment, across placements, one audit per changed placement, purge once", async () => {
    seedExperiment({ id: "exp1" });
    seedPlacement({
      id: "plc1",
      rows: [
        { audienceId: "aud1", target: { type: "experiment", experimentId: "exp1" } },
        { audienceId: null, target: { type: "experiment", experimentId: "exp1" } },
      ],
    });
    seedPlacement({
      id: "plc2",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pwOther" } }],
    });

    const res = await stop("exp1", { winnerVariantId: "a" });

    expect(res.status).toBe(200);

    const plc1 = state.committed.placements.plc1;
    expect(plc1.rows[0].target).toEqual({ type: "paywall", paywallId: "pwA" });
    expect(plc1.rows[1].target).toEqual({ type: "paywall", paywallId: "pwA" });

    const plc2 = state.committed.placements.plc2;
    expect(plc2.rows[0].target).toEqual({ type: "paywall", paywallId: "pwOther" });

    expect(updatePlacement).toHaveBeenCalledTimes(1);
    expect(updatePlacement).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      "plc1",
      expect.objectContaining({ rows: expect.any(Array) }),
    );

    const placementAudits = auditMock.mock.calls.filter(
      ([entry]) => entry.resource === "placement",
    );
    expect(placementAudits).toHaveLength(1);
    expect(placementAudits[0]![0].resourceId).toBe("plc1");

    expect(purgeProjectCatalogCache).toHaveBeenCalledTimes(1);
    expect(purgeProjectCatalogCache).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("(b) stop WITHOUT winner never touches placements", async () => {
    seedExperiment({ id: "exp1" });
    seedPlacement({
      id: "plc1",
      rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp1" } }],
    });

    const res = await stop("exp1");

    expect(res.status).toBe(200);
    expect(updatePlacement).not.toHaveBeenCalled();
    expect(listPlacements).not.toHaveBeenCalled();
    expect(purgeProjectCatalogCache).not.toHaveBeenCalled();
    expect(state.committed.placements.plc1.rows[0].target).toEqual({
      type: "experiment",
      experimentId: "exp1",
    });
  });

  it("(c) non-PAYWALL experiment with winner never repoints", async () => {
    seedExperiment({ id: "exp1", type: "FLAG", variants: [
      { id: "a", name: "A", value: true, weight: 0.5 },
      { id: "b", name: "B", value: false, weight: 0.5 },
    ] });
    seedPlacement({
      id: "plc1",
      rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp1" } }],
    });

    const res = await stop("exp1", { winnerVariantId: "a" });

    expect(res.status).toBe(200);
    expect(updatePlacement).not.toHaveBeenCalled();
    expect(purgeProjectCatalogCache).not.toHaveBeenCalled();
  });

  it("(d) winner variantId not found among variants never repoints, stop still succeeds", async () => {
    seedExperiment({ id: "exp1" });
    seedPlacement({
      id: "plc1",
      rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp1" } }],
    });

    const res = await stop("exp1", { winnerVariantId: "does-not-exist" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.experiment.status).toBe("COMPLETED");
    expect(updatePlacement).not.toHaveBeenCalled();
    expect(purgeProjectCatalogCache).not.toHaveBeenCalled();
  });

  it("(e) existing stop behaviours: status COMPLETED, audit, and promoteToFlag are unchanged", async () => {
    seedExperiment({ id: "exp1", type: "FLAG", variants: [
      { id: "a", name: "A", value: true, weight: 0.5 },
      { id: "b", name: "B", value: false, weight: 0.5 },
    ] });

    const res = await stop("exp1", { winnerVariantId: "a", promoteToFlag: true });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.experiment.status).toBe("COMPLETED");
    expect(json.data.promotedFlag).not.toBeNull();
    expect(createFeatureFlag).toHaveBeenCalledTimes(1);
    expect(invalidateFlagCache).toHaveBeenCalledWith(PROJECT_ID);

    const stoppedAudit = auditMock.mock.calls.find(
      ([entry]) => entry.action === "experiment.stopped",
    );
    expect(stoppedAudit).toBeDefined();
    expect(stoppedAudit![0].after.status).toBe("COMPLETED");

    expect(invalidateExperimentCache).toHaveBeenCalledWith(PROJECT_ID);
  });
});
