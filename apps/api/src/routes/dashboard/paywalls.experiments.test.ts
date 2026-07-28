import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /dashboard/projects/:projectId/paywalls/:id/experiments (§6.19)
// =============================================================
//
// Exercises the REAL createExperimentValidated/findOrCreateEveryoneAudience
// (Task 1) against a mocked `@rovenue/db` barrel. The mock's
// `db.transaction` splits every repo write into a per-call `pending`
// buffer that is only merged into the shared `state.committed` store once
// the transaction callback resolves — mirroring real Postgres ROLLBACK. A
// separate `state.calls` log records every repo invocation unconditionally
// (even ones whose writes get discarded), which is what lets test (d)
// prove the experiment insert was attempted AND rolled back, rather than
// merely asserting the response code.

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../lib/project-access", () => ({ assertProjectAccess: async () => {} }));

const assertProjectCapability = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _userId: string, _cap: string) => ({
    id: "m1",
    role: "OWNER",
  })),
);
vi.mock("../../lib/capabilities", () => ({ assertProjectCapability }));

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../lib/audit", () => ({
  audit: auditMock,
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

const purgeProjectCatalogCache = vi.hoisted(() => vi.fn());
vi.mock("../../lib/edge-cache", () => ({ purgeProjectCatalogCache }));

const invalidateExperimentCache = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../services/experiment-engine", () => ({ invalidateExperimentCache }));

// -------------------------------------------------------------
// In-memory `@rovenue/db` state — a single hoisted container so every
// mocked repo fn (also hoisted, so vi.mock's factory can see them) closes
// over the SAME mutable object rather than racing module-eval order.
// -------------------------------------------------------------

type Row = Record<string, any>;
interface Store {
  paywalls: Record<string, Row>;
  experiments: Record<string, Row>;
  placements: Record<string, Row>;
  audiences: Record<string, Row>;
}

const state = vi.hoisted(() => ({
  committed: {
    paywalls: {} as Record<string, any>,
    experiments: {} as Record<string, any>,
    placements: {} as Record<string, any>,
    audiences: {} as Record<string, any>,
  },
  calls: [] as string[],
  nextId: 1,
}));

function freshId(prefix: string): string {
  return `${prefix}_${state.nextId++}`;
}

function storeFor(dbOrTx: any): Store {
  return dbOrTx && dbOrTx.__pending ? dbOrTx.__pending : state.committed;
}

const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: any) => Promise<any>) => {
    const pending = {
      paywalls: { ...state.committed.paywalls },
      experiments: { ...state.committed.experiments },
      placements: { ...state.committed.placements },
      audiences: { ...state.committed.audiences },
    };
    const tx = { __pending: pending };
    const result = await fn(tx); // throws propagate — pending is discarded, never merged
    state.committed = pending;
    return result;
  }),
);

const findPaywallById = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, _projectId: string, id: string) => {
    state.calls.push(`paywallRepo.findPaywallById:${id}`);
    return storeFor(dbOrTx).paywalls[id] ?? null;
  }),
);
const findPaywallByIdentifier = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, projectId: string, identifier: string) => {
    state.calls.push(`paywallRepo.findPaywallByIdentifier:${identifier}`);
    const store = storeFor(dbOrTx);
    return (
      Object.values(store.paywalls).find(
        (p) => p.projectId === projectId && p.identifier === identifier,
      ) ?? null
    );
  }),
);
const findPaywallsByIds = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, _projectId: string, ids: string[]) => {
    state.calls.push(`paywallRepo.findPaywallsByIds:${ids.join(",")}`);
    const store = storeFor(dbOrTx);
    return ids.map((id) => store.paywalls[id]).filter(Boolean);
  }),
);
const createPaywall = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, input: any) => {
    state.calls.push(`paywallRepo.createPaywall:${input.identifier}`);
    const store = storeFor(dbOrTx);
    const row = {
      id: freshId("pw"),
      isActive: true,
      status: "draft",
      publishedVersionId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    };
    store.paywalls[row.id] = row;
    return row;
  }),
);

const findPlacementById = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, _projectId: string, id: string) => {
    state.calls.push(`placementRepo.findPlacementById:${id}`);
    return storeFor(dbOrTx).placements[id] ?? null;
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

const findAudienceInProject = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, projectId: string, id: string) => {
    state.calls.push(`audienceRepo.findAudienceInProject:${id}`);
    const store = storeFor(dbOrTx);
    const row = store.audiences[id];
    return row && row.projectId === projectId ? row : null;
  }),
);
const findDefaultAudience = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, projectId: string) => {
    state.calls.push("audienceRepo.findDefaultAudience");
    const store = storeFor(dbOrTx);
    return (
      Object.values(store.audiences).find((a) => a.projectId === projectId && a.isDefault) ??
      null
    );
  }),
);
const findMatchAllAudiences = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: any, _projectId: string) => {
    state.calls.push("audienceRepo.findMatchAllAudiences");
    return [];
  }),
);
const createAudience = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, input: any) => {
    state.calls.push("audienceRepo.createAudience");
    const store = storeFor(dbOrTx);
    const row = { id: freshId("aud"), ...input };
    store.audiences[row.id] = row;
    return row;
  }),
);

const findExperimentByKey = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, projectId: string, key: string) => {
    state.calls.push(`experimentRepo.findExperimentByKey:${key}`);
    const store = storeFor(dbOrTx);
    return (
      Object.values(store.experiments).find((e) => e.projectId === projectId && e.key === key) ??
      null
    );
  }),
);
const createExperiment = vi.hoisted(() =>
  vi.fn(async (dbOrTx: any, input: any) => {
    state.calls.push(`experimentRepo.createExperiment:${input.key}`);
    const store = storeFor(dbOrTx);
    const row = { id: freshId("exp"), createdAt: new Date(), updatedAt: new Date(), ...input };
    store.experiments[row.id] = row;
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
      paywallRepo: {
        ...actual.drizzle.paywallRepo,
        findPaywallById,
        findPaywallByIdentifier,
        findPaywallsByIds,
        createPaywall,
      },
      placementRepo: {
        ...actual.drizzle.placementRepo,
        findPlacementById,
        updatePlacement,
      },
      audienceRepo: {
        ...actual.drizzle.audienceRepo,
        findAudienceInProject,
        findDefaultAudience,
        findMatchAllAudiences,
        createAudience,
      },
      experimentRepo: {
        ...actual.drizzle.experimentRepo, // keep the real generateExperimentKey
        findExperimentByKey,
        createExperiment,
      },
    },
  };
});

const { Hono } = await import("hono");
const { paywallsDashboardRoute } = await import("./paywalls");
const { errorHandler } = await import("../../middleware/error");

function app() {
  const a = new Hono().route("/dashboard/projects/:projectId/paywalls", paywallsDashboardRoute);
  a.onError(errorHandler);
  return a;
}

const PROJECT_ID = "p1";

function seedPaywall(overrides: Partial<Row> & { id: string }): Row {
  const row = {
    projectId: PROJECT_ID,
    identifier: overrides.id,
    name: "Paywall",
    offeringId: "off1",
    remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    builderConfig: { root: { type: "stack", children: [] } },
    configFormatVersion: 2,
    isActive: true,
    status: "published",
    publishedVersionId: null,
    metadata: {},
    ...overrides,
  };
  state.committed.paywalls[row.id] = row;
  return row;
}

function seedAudience(overrides: Partial<Row> & { id: string }): Row {
  const row = { projectId: PROJECT_ID, name: "Everyone", rules: {}, isDefault: false, ...overrides };
  state.committed.audiences[row.id] = row;
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
  state.committed = { paywalls: {}, experiments: {}, placements: {}, audiences: {} };
  state.calls = [];
  state.nextId = 1;
  assertProjectCapability.mockClear();
  auditMock.mockClear();
  purgeProjectCatalogCache.mockClear();
  invalidateExperimentCache.mockClear();
  for (const fn of [
    findPaywallById,
    findPaywallByIdentifier,
    findPaywallsByIds,
    createPaywall,
    findPlacementById,
    updatePlacement,
    findAudienceInProject,
    findDefaultAudience,
    findMatchAllAudiences,
    createAudience,
    findExperimentByKey,
    createExperiment,
    transaction,
  ]) {
    fn.mockClear();
  }

  seedPaywall({ id: "pwA", name: "Paywall A" });
  seedAudience({ id: "aud1", name: "Everyone", isDefault: true });
});

describe("POST /paywalls/:id/experiments", () => {
  it("(a) duplicate happy path: creates paywall B, DRAFT 50/50 experiment, repoints the placement row", async () => {
    seedPlacement({
      id: "plc1",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pwA" } }],
    });

    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Price test",
        variantB: { kind: "duplicate", name: "Paywall A Copy" },
        audienceId: "aud1",
        placement: { placementId: "plc1", rowIndex: 0 },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.data.createdPaywallId).toBe("string");

    const experiment = json.data.experiment;
    expect(experiment.status).toBe("DRAFT");
    expect(experiment.type).toBe("PAYWALL");
    expect(experiment.variants).toEqual([
      { id: "a", name: "Paywall A", value: { paywallId: "pwA" }, weight: 0.5 },
      {
        id: "b",
        name: "Paywall A Copy",
        value: { paywallId: json.data.createdPaywallId },
        weight: 0.5,
      },
    ]);

    // Variant B is a real committed row: draft, unpublished, config copied from A.
    const createdB = state.committed.paywalls[json.data.createdPaywallId];
    expect(createdB).toBeDefined();
    expect(createdB.status).toBe("draft");
    expect(createdB.publishedVersionId).toBeNull();
    expect(createdB.offeringId).toBe("off1");
    expect(createdB.builderConfig).toEqual({ root: { type: "stack", children: [] } });

    // Placement row 0 now targets the experiment, not paywall A.
    const placement = state.committed.placements.plc1;
    expect(placement.rows[0].target).toEqual({ type: "experiment", experimentId: experiment.id });

    expect(invalidateExperimentCache).toHaveBeenCalledWith("p1");
    expect(purgeProjectCatalogCache).toHaveBeenCalledWith("p1");
  });

  it("(b) existing-kind happy path: createdPaywallId is null, no placement repoint", async () => {
    seedPaywall({ id: "pwB", name: "Paywall B" });

    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Existing test",
        variantB: { kind: "existing", paywallId: "pwB" },
        audienceId: "aud1",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.createdPaywallId).toBeNull();
    expect(json.data.experiment.variants).toEqual([
      { id: "a", name: "Paywall A", value: { paywallId: "pwA" }, weight: 0.5 },
      { id: "b", name: "Paywall B", value: { paywallId: "pwB" }, weight: 0.5 },
    ]);
    expect(createPaywall).not.toHaveBeenCalled();
    expect(purgeProjectCatalogCache).not.toHaveBeenCalled();
    expect(invalidateExperimentCache).toHaveBeenCalledWith("p1");
  });

  it("(c) variantB.paywallId === id rejects with 400", async () => {
    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Self reference",
        variantB: { kind: "existing", paywallId: "pwA" },
        audienceId: "aud1",
      }),
    });

    expect(res.status).toBe(400);
    expect(Object.keys(state.committed.experiments)).toHaveLength(0);
  });

  it("(d) placement row target mismatch 409s AND rolls back the experiment insert", async () => {
    // Row 0 targets a DIFFERENT paywall than A — stale by the time this
    // request lands (e.g. someone else repointed it first).
    seedPlacement({
      id: "plc1",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pwOther" } }],
    });

    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Price test",
        variantB: { kind: "duplicate", name: "Paywall A Copy" },
        audienceId: "aud1",
        placement: { placementId: "plc1", rowIndex: 0 },
      }),
    });

    expect(res.status).toBe(409);

    // The insert was attempted (step 4 runs before the placement check in
    // step 5) — proven via the append-only `state.calls` log...
    expect(state.calls.some((c) => c.startsWith("experimentRepo.createExperiment:"))).toBe(true);
    expect(state.calls.some((c) => c.startsWith("paywallRepo.createPaywall:"))).toBe(true);

    // ...but NONE of it landed in the committed store: the whole handler
    // ran in one drizzle.db.transaction(), so the throw in step 5 rolled
    // the buffer back before it was ever merged.
    expect(Object.keys(state.committed.experiments)).toHaveLength(0);
    expect(Object.keys(state.committed.paywalls)).toEqual(["pwA"]);
    expect(state.committed.placements.plc1.rows[0].target).toEqual({
      type: "paywall",
      paywallId: "pwOther",
    });

    // Post-commit side effects never fire for a rolled-back transaction.
    expect(invalidateExperimentCache).not.toHaveBeenCalled();
    expect(purgeProjectCatalogCache).not.toHaveBeenCalled();
  });

  it("(e) identifier collision: the -2 suffix is used", async () => {
    seedPaywall({ id: "pwTaken", identifier: "paywall-a-copy", name: "Someone else" });

    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Price test",
        variantB: { kind: "duplicate", name: "Paywall A Copy" },
        audienceId: "aud1",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    const createdB = state.committed.paywalls[json.data.createdPaywallId];
    expect(createdB.identifier).toBe("paywall-a-copy-2");
  });

  it("(f) no audienceId: findOrCreateEveryoneAudience is consulted", async () => {
    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "No audience given",
        variantB: { kind: "duplicate", name: "Paywall A Copy 2" },
      }),
    });

    expect(res.status).toBe(200);
    expect(findDefaultAudience).toHaveBeenCalled();
    const json = await res.json();
    // The seeded default audience (aud1, isDefault: true) is the one resolved.
    expect(json.data.experiment.audienceId).toBe("aud1");
  });

  it("(g) capability gate is checked for experiments:write", async () => {
    await app().request("/dashboard/projects/p1/paywalls/pwA/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Cap check",
        variantB: { kind: "duplicate", name: "Cap check copy" },
        audienceId: "aud1",
      }),
    });

    expect(assertProjectCapability).toHaveBeenCalledWith("p1", "u1", "experiments:write");
  });
});
