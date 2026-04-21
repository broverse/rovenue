import { beforeEach, describe, expect, it, vi } from "vitest";
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => {
    if (!obj) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
    return out;
  }),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, drizzleMock, authMock } = vi.hoisted(() => {
  // Audit chain writer needs $transaction + $executeRaw + auditLog.findFirst
  // on the tx client. We wire all of them onto the same mock object and
  // reuse it as both top-level prisma and the tx parameter passed to the
  // $transaction callback — that's enough for the dashboard routes under
  // test here, which never care about isolation boundaries.
  const prismaMock: Record<string, unknown> = {
    projectMember: { findUnique: vi.fn() },
    auditLog: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "al_1" })),
    },
    audience: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    experiment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    experimentAssignment: { count: vi.fn(async () => 0) },
    featureFlag: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prismaMock),
    ),
  };

  const authMock = {
    auth: {
      api: {
        getSession: vi.fn(),
      },
    },
  };

  // Shadow reader short-circuits to the primary caller; Drizzle
  // parity is unit-tested in packages/db/src/drizzle/shadow.test.ts.
  const drizzleMock = {
    db: {} as unknown,
    auditLogRepo: {
      listAuditLogs: vi.fn(async () => []),
      countAuditLogs: vi.fn(async () => 0),
      findAuditLogById: vi.fn(async () => null),
    },
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => []),
      findAudiencesByProject: vi.fn(async () => []),
    },
    subscriberRepo: {
      findSubscriberAttributes: vi.fn(async () => null),
      findSubscriberByAppUserId: vi.fn(async () => null),
      listSubscribers: vi.fn(async () => []),
    },
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        prismaMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    audienceRepo: {
      findDefaultAudience: vi.fn(async () => null),
      listAudiences: vi.fn(async () => []),
      findAudienceById: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.audience.findUnique({ where: { id } }),
      ),
      findAudienceInProject: vi.fn(async (_db, _projectId, id) =>
        prismaMock.audience.findFirst({ where: { id } }),
      ),
      createAudience: vi.fn(
        async (_db: unknown, input: Record<string, unknown>) =>
          prismaMock.audience.create({ data: input }),
      ),
      updateAudience: vi.fn(
        async (_db: unknown, id: string, patch: Record<string, unknown>) =>
          prismaMock.audience.update({ where: { id }, data: patch }),
      ),
      deleteAudience: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.audience.delete({ where: { id } }),
      ),
    },
    dashboardFeatureFlagRepo: {
      listFeatureFlags: vi.fn(async () => []),
      findFeatureFlagById: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.featureFlag.findUnique({ where: { id } }),
      ),
    },
    experimentRepo: {
      findRunningExperimentsByProject: vi.fn(async () => []),
      findExperimentsByProject: vi.fn(async () => []),
      findExperimentById: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.experiment.findUnique({ where: { id } }),
      ),
      findFirstExperimentByAudience: vi.fn(async () => null),
      createExperiment: vi.fn(
        async (_db: unknown, input: Record<string, unknown>) =>
          prismaMock.experiment.create({ data: input }),
      ),
      updateExperiment: vi.fn(
        async (_db: unknown, id: string, patch: Record<string, unknown>) =>
          prismaMock.experiment.update({ where: { id }, data: patch }),
      ),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };

  return { prismaMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
  FeatureFlagType: {
    BOOLEAN: "BOOLEAN",
    STRING: "STRING",
    NUMBER: "NUMBER",
    JSON: "JSON",
  },
  ExperimentStatus: {
    DRAFT: "DRAFT",
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETED",
  },
  Store: { APP_STORE: "APP_STORE", PLAY_STORE: "PLAY_STORE", STRIPE: "STRIPE" },
  Environment: { PRODUCTION: "PRODUCTION", SANDBOX: "SANDBOX" },
  PurchaseStatus: {
    TRIAL: "TRIAL", ACTIVE: "ACTIVE", EXPIRED: "EXPIRED",
    REFUNDED: "REFUNDED", REVOKED: "REVOKED", PAUSED: "PAUSED",
    GRACE_PERIOD: "GRACE_PERIOD",
  },
  ProductType: { SUBSCRIPTION: "SUBSCRIPTION", CONSUMABLE: "CONSUMABLE", NON_CONSUMABLE: "NON_CONSUMABLE" },
  CreditLedgerType: { PURCHASE: "PURCHASE", SPEND: "SPEND", REFUND: "REFUND", BONUS: "BONUS", EXPIRE: "EXPIRE" },
  WebhookEventStatus: { RECEIVED: "RECEIVED", PROCESSING: "PROCESSING", PROCESSED: "PROCESSED", FAILED: "FAILED" },
  WebhookSource: { APPLE: "APPLE", GOOGLE: "GOOGLE", STRIPE: "STRIPE" },
  OutgoingWebhookStatus: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED" },
  RevenueEventType: {
    INITIAL: "INITIAL", RENEWAL: "RENEWAL", TRIAL_CONVERSION: "TRIAL_CONVERSION",
    CANCELLATION: "CANCELLATION", REFUND: "REFUND", REACTIVATION: "REACTIVATION",
    CREDIT_PURCHASE: "CREDIT_PURCHASE",
  },
  Prisma: {
    sql: (s: TemplateStringsArray, ...v: unknown[]) => ({ strings: s, values: v }),
    Decimal: class { constructor(public value: number | string) {} toString() { return String(this.value); } },
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class extends Error { code = ""; },
  },
}));

vi.mock("../src/lib/auth", () => authMock);

vi.mock("../src/services/flag-engine", () => ({
  evaluateAllFlags: vi.fn(async () => ({})),
  invalidateFlagCache: vi.fn(async () => undefined),
}));

vi.mock("../src/services/experiment-engine", () => ({
  evaluateExperiments: vi.fn(async () => ({})),
  recordEvent: vi.fn(async () => undefined),
  resolveProductGroup: vi.fn(async () => null),
  invalidateExperimentCache: vi.fn(async () => undefined),
  getExperimentResults: vi.fn(async () => ({})),
}));

import { app } from "../src/app";

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test" };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.api.getSession.mockResolvedValue({
    user: { id: "user_1" },
    session: { id: "sess_1" },
  });
  prismaMock.projectMember.findUnique.mockResolvedValue({
    id: "pm_1",
    role: "OWNER",
  });
  prismaMock.auditLog.create.mockResolvedValue({ id: "al_1" });
});

// =============================================================
// Audit DB write on mutation
// =============================================================

describe("audit DB write", () => {
  it("writes an audit log row with before/after on audience create", async () => {
    prismaMock.audience.findFirst.mockResolvedValue({ id: "aud_default" });
    prismaMock.audience.create.mockResolvedValue({
      id: "aud_new",
      projectId: "proj_a",
      name: "TR iOS",
    });

    await app.request("http://localhost/dashboard/audiences", {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj_a",
        name: "TR iOS",
        rules: { country: "TR" },
      }),
    });

    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_a",
        userId: "user_1",
        action: "create",
        resource: "audience",
        resourceId: "aud_new",
        after: expect.objectContaining({ name: "TR iOS" }),
      }),
    );
  });

  it("writes before/after on feature flag toggle", async () => {
    prismaMock.featureFlag.findUnique.mockResolvedValue({
      id: "flag_1",
      projectId: "proj_a",
      key: "feat",
      type: "BOOLEAN",
      isEnabled: true,
    });
    prismaMock.featureFlag.update.mockResolvedValue({
      id: "flag_1",
      projectId: "proj_a",
      isEnabled: false,
    });

    await app.request(
      "http://localhost/dashboard/feature-flags/flag_1/toggle",
      { method: "POST", headers: authedHeaders() },
    );

    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "toggle",
        resource: "feature_flag",
        before: expect.objectContaining({ isEnabled: true }),
        after: expect.objectContaining({ isEnabled: false }),
      }),
    );
  });

  it("writes experiment.started action on start", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue({
      id: "exp_1",
      projectId: "proj_a",
      status: "DRAFT",
      variants: [
        { id: "control", weight: 0.5 },
        { id: "v", weight: 0.5 },
      ],
    });
    prismaMock.experiment.update.mockResolvedValue({
      id: "exp_1",
      status: "RUNNING",
    });

    await app.request(
      "http://localhost/dashboard/experiments/exp_1/start",
      { method: "POST", headers: authedHeaders() },
    );

    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "experiment.started",
        resource: "experiment",
        before: { status: "DRAFT" },
        after: { status: "RUNNING" },
      }),
    );
  });
});

// =============================================================
// GET /dashboard/audit-logs — query endpoint
// =============================================================

describe("GET /dashboard/audit-logs", () => {
  it("returns paginated audit logs for a project", async () => {
    const logs = [
      {
        id: "al_1",
        projectId: "proj_a",
        userId: "user_1",
        action: "create",
        resource: "audience",
        resourceId: "aud_1",
        before: null,
        after: { name: "TR iOS" },
        ipAddress: "1.2.3.4",
        userAgent: "test",
        prevHash: null,
        rowHash: "hash_1",
        createdAt: new Date(),
        user: { id: "user_1", name: "Test", email: "t@t.com", image: null },
      },
    ];
    // Phase 5: dashboard audit reads are Drizzle-only.
    drizzleMock.auditLogRepo.listAuditLogs.mockResolvedValue(logs);
    drizzleMock.auditLogRepo.countAuditLogs.mockResolvedValue(1);

    const res = await app.request(
      "http://localhost/dashboard/audit-logs?projectId=proj_a",
      { headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { logs: unknown[]; pagination: { total: number; hasMore: boolean } };
    };
    expect(body.data.logs).toHaveLength(1);
    expect(body.data.pagination.total).toBe(1);
    expect(body.data.pagination.hasMore).toBe(false);
  });

  it("passes filter params to the repository", async () => {
    drizzleMock.auditLogRepo.listAuditLogs.mockResolvedValue([]);
    drizzleMock.auditLogRepo.countAuditLogs.mockResolvedValue(0);

    await app.request(
      "http://localhost/dashboard/audit-logs?projectId=proj_a&action=create&resource=experiment&limit=10&offset=5",
      { headers: authedHeaders() },
    );

    const call = drizzleMock.auditLogRepo.listAuditLogs.mock.calls[0]![1] as {
      projectId: string;
      action?: string;
      resource?: string;
      limit: number;
      offset: number;
    };
    expect(call.projectId).toBe("proj_a");
    expect(call.action).toBe("create");
    expect(call.resource).toBe("experiment");
    expect(call.limit).toBe(10);
    expect(call.offset).toBe(5);
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await app.request(
      "http://localhost/dashboard/audit-logs",
      { headers: authedHeaders() },
    );
    expect(res.status).toBe(400);
  });
});
