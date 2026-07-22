// =============================================================
// GET /v1/placements/:identifier — route-level unit tests
//
// Exercises the HTTP layer (auth, audience-row walk, paywall/
// experiment hydration, locale resolution) against mocked drizzle
// repos — no real Postgres required, mirroring the bootstrap in
// identify-route.integration.test.ts / v1-offerings.test.ts.
// =============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit mock — must be hoisted before any module import (dashboard
// routes bundled into app.ts import it at module scope).
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj) return null;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
      return out;
    },
  ),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

// Stub the experiment engine (pulled in transitively via offerings.ts,
// which is also mounted on the app) so its unrelated module doesn't
// need a live DB/redis for this route's tests.
vi.mock("../src/services/experiment-engine", () => ({
  evaluateExperiments: vi.fn(async () => ({})),
}));

// =============================================================
// Hoisted mocks
// =============================================================

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const apiKey = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };

  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };

  // Some dashboard routes bundled into app.ts destructure
  // `drizzle.schema` at module load time — stub it so import doesn't throw.
  const schema = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => ({ [String(prop)]: {} }),
  });

  const drizzleMock = {
    db: drizzleDb,
    schema,
    placementRepo: {
      findPlacementByIdentifier: vi.fn(async () => null),
    },
    paywallRepo: {
      findPaywallById: vi.fn(async () => null),
      findPaywallsByIds: vi.fn(async () => []),
    },
    audienceRepo: {
      findByIds: vi.fn(async () => []),
    },
    experimentRepo: {
      findByIdInProject: vi.fn(async () => null),
    },
    offeringRepo: {
      findOfferingById: vi.fn(async () => null),
      findProductsByIds: vi.fn(async () => []),
    },
    subscriberRepo: {
      resolveSubscriberByRovenueIdOrLegacy: vi.fn(async () => null),
    },
    lockRepo: {
      advisoryXactLock2: vi.fn(async () => undefined),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async (_db: unknown, keyPublic: string) =>
        apiKey.findUnique({ where: { keyPublic }, include: { project: true } }),
      ),
      findApiKeyById: vi.fn(async (_db: unknown, id: string) =>
        apiKey.findUnique({ where: { id }, include: { project: true } }),
      ),
      updateApiKeyLastUsed: vi.fn(async () => undefined),
    },
    projectRepo: {
      findMembership: vi.fn(async () => null),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    shadowRead: vi.fn(async (primary: () => unknown) => primary()),
  };

  return { dbMock: { apiKey }, drizzleMock };
});

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: drizzleMock,
  };
});

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => true),
    hash: vi.fn(async () => "hashed"),
  },
}));

// =============================================================
// Import app after mocks are wired
// =============================================================

import { app } from "../src/app";

// =============================================================
// Shared auth setup
// =============================================================

const PUBLIC_KEY = "rov_pub_test_key";

function withAuth(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PUBLIC_KEY}`);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

const apiKeyRecord = {
  id: "apikey_1",
  projectId: "proj_test",
  label: "test",
  keyPublic: PUBLIC_KEY,
  keySecretHash: "hashed",
  environment: "PRODUCTION",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: { id: "proj_test", name: "Test Project", slug: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.apiKey.findUnique.mockResolvedValue(apiKeyRecord);
});

// =============================================================
// Fixtures
// =============================================================

function makePlacement(overrides: Record<string, unknown> = {}) {
  return {
    id: "plc_1",
    projectId: "proj_test",
    identifier: "onboarding",
    name: "Onboarding",
    revision: 1,
    rows: [],
    isActive: true,
    ...overrides,
  };
}

function makePaywall(overrides: Record<string, unknown> = {}) {
  return {
    id: "pw_1",
    projectId: "proj_test",
    identifier: "pw_default",
    name: "Default Paywall",
    offeringId: "off_1",
    remoteConfig: {},
    configFormatVersion: 1,
    builderConfig: null,
    isActive: true,
    metadata: {},
    ...overrides,
  };
}

function makeOffering(overrides: Record<string, unknown> = {}) {
  return {
    id: "off_1",
    identifier: "default",
    isDefault: true,
    packages: [],
    metadata: {},
    ...overrides,
  };
}

// =============================================================
// GET /v1/placements/:identifier
// =============================================================

describe("GET /v1/placements/:identifier", () => {
  it("anonymous caller matches the all-users row (audienceId: null)", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pw_1" } }],
      }) as any,
    );
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockResolvedValue(
      makePaywall() as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.placement).toEqual({ identifier: "onboarding", revision: 1 });
    expect(body.data.paywall.identifier).toBe("pw_default");
    expect(body.data.experiment).toBeNull();
  });

  it("attribute-matched audience row wins over the later all-users row", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [
          { audienceId: "aud_pro", target: { type: "paywall", paywallId: "pw_pro" } },
          { audienceId: null, target: { type: "paywall", paywallId: "pw_default" } },
        ],
      }) as any,
    );
    vi.mocked(drizzleMock.audienceRepo.findByIds).mockResolvedValue([
      { id: "aud_pro", rules: { plan: "pro" } },
    ] as any);
    vi.mocked(drizzleMock.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy).mockResolvedValue(
      { id: "sub_1", attributes: { plan: "pro" } } as any,
    );
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockImplementation(
      async (_db, _projectId, id) =>
        (id === "pw_pro" ? makePaywall({ id: "pw_pro", identifier: "pw_pro" }) : null) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(
      withAuth("/v1/placements/onboarding?subscriberId=rov_x"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall.identifier).toBe("pw_pro");
  });

  it("target:none short-circuits to an empty paywall/experiment envelope", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "none" } }],
      }) as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.placement).toEqual({ identifier: "onboarding", revision: 1 });
    expect(body.data.paywall).toBeNull();
    expect(body.data.experiment).toBeNull();
  });

  it("falls through to the next row when the targeted paywall is dangling/inactive", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [
          { audienceId: "aud_all", target: { type: "paywall", paywallId: "pw_missing" } },
          { audienceId: null, target: { type: "paywall", paywallId: "pw_fallback" } },
        ],
      }) as any,
    );
    vi.mocked(drizzleMock.audienceRepo.findByIds).mockResolvedValue([
      { id: "aud_all", rules: {} },
    ] as any);
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockImplementation(
      async (_db, _projectId, id) =>
        (id === "pw_fallback"
          ? makePaywall({ id: "pw_fallback", identifier: "pw_fallback" })
          : null) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall.identifier).toBe("pw_fallback");
  });

  it("returns a RUNNING PAYWALL experiment's hydrated variants with weights", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
      }) as any,
    );
    vi.mocked(drizzleMock.experimentRepo.findByIdInProject).mockResolvedValue({
      id: "exp_1",
      key: "exp_key_1",
      type: "PAYWALL",
      status: "RUNNING",
      variants: [
        { id: "var_a", weight: 50, value: { paywallId: "pw_a" } },
        { id: "var_b", weight: 50, value: { paywallId: "pw_b" } },
      ],
    } as any);
    // The route batches variant paywall lookups (findPaywallsByIds), not
    // per-variant findPaywallById.
    vi.mocked(drizzleMock.paywallRepo.findPaywallsByIds).mockImplementation(
      async (_db, _projectId, ids) =>
        (ids as string[]).map((id) => makePaywall({ id, identifier: id })) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall).toBeNull();
    expect(body.data.experiment.id).toBe("exp_1");
    expect(body.data.experiment.key).toBe("exp_key_1");
    expect(body.data.experiment.variants).toHaveLength(2);
    expect(body.data.experiment.variants.map((v: any) => v.weight)).toEqual([50, 50]);
    expect(body.data.experiment.variants[0].paywall.identifier).toBe("pw_a");
  });

  it("skips a DRAFT experiment row and falls through to the next row", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [
          { audienceId: "aud_all", target: { type: "experiment", experimentId: "exp_draft" } },
          { audienceId: null, target: { type: "paywall", paywallId: "pw_fallback" } },
        ],
      }) as any,
    );
    vi.mocked(drizzleMock.audienceRepo.findByIds).mockResolvedValue([
      { id: "aud_all", rules: {} },
    ] as any);
    vi.mocked(drizzleMock.experimentRepo.findByIdInProject).mockResolvedValue({
      id: "exp_draft",
      key: "exp_key_draft",
      type: "PAYWALL",
      status: "DRAFT",
      variants: [{ id: "var_a", weight: 100, value: { paywallId: "pw_a" } }],
    } as any);
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockImplementation(
      async (_db, _projectId, id) =>
        (id === "pw_fallback"
          ? makePaywall({ id: "pw_fallback", identifier: "pw_fallback" })
          : null) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.experiment).toBeNull();
    expect(body.data.paywall.identifier).toBe("pw_fallback");
  });

  it("returns the empty envelope with 200 for an unknown placement identifier", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(null);

    const res = await app.request(withAuth("/v1/placements/does-not-exist"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ placement: null, paywall: null, experiment: null });
  });

  it("returns the empty envelope with 200 for an inactive placement", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({ isActive: false }) as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ placement: null, paywall: null, experiment: null });
  });

  it("includes builderConfig verbatim + configFormatVersion when the paywall has one", async () => {
    const builderConfig = {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: { title: "Go Pro" } },
      root: { type: "stack", id: "root", axis: "v", children: [] },
    };
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pw_1" } }],
      }) as any,
    );
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockResolvedValue(
      makePaywall({ builderConfig, configFormatVersion: 2 }) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall.builderConfig).toEqual(builderConfig);
    expect(body.data.paywall.configFormatVersion).toBe(2);
  });

  it("omits builderConfig when the paywall's builderConfig is null", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pw_1" } }],
      }) as any,
    );
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockResolvedValue(
      makePaywall() as any, // builderConfig: null, configFormatVersion: 1 by default
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(withAuth("/v1/placements/onboarding"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall.configFormatVersion).toBe(1);
    expect("builderConfig" in body.data.paywall).toBe(false);
  });

  it("falls back to remoteConfig.defaultLocale when the requested locale is absent", async () => {
    vi.mocked(drizzleMock.placementRepo.findPlacementByIdentifier).mockResolvedValue(
      makePlacement({
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pw_1" } }],
      }) as any,
    );
    vi.mocked(drizzleMock.paywallRepo.findPaywallById).mockResolvedValue(
      makePaywall({
        remoteConfig: {
          defaultLocale: "en",
          locales: {
            en: { title: "Hello" },
            tr: { title: "Merhaba" },
          },
        },
      }) as any,
    );
    vi.mocked(drizzleMock.offeringRepo.findOfferingById).mockResolvedValue(
      makeOffering() as any,
    );

    const res = await app.request(
      withAuth("/v1/placements/onboarding?locale=fr"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paywall.remoteConfig).toEqual({
      locale: "en",
      data: { title: "Hello" },
    });
  });
});
