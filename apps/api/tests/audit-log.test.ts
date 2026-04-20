import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, authMock } = vi.hoisted(() => {
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

  return { prismaMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
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

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "proj_a",
        userId: "user_1",
        action: "create",
        resource: "audience",
        resourceId: "aud_new",
        after: expect.objectContaining({ name: "TR iOS" }),
      }),
    });
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

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "toggle",
        resource: "feature_flag",
        before: expect.objectContaining({ isEnabled: true }),
        after: expect.objectContaining({ isEnabled: false }),
      }),
    });
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

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "experiment.started",
        resource: "experiment",
        before: { status: "DRAFT" },
        after: { status: "RUNNING" },
      }),
    });
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
        createdAt: new Date(),
        user: { id: "user_1", name: "Test", email: "t@t.com", image: null },
      },
    ];
    prismaMock.auditLog.findMany.mockResolvedValue(logs);
    prismaMock.auditLog.count.mockResolvedValue(1);

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

  it("passes filter params to the query", async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(0);

    await app.request(
      "http://localhost/dashboard/audit-logs?projectId=proj_a&action=create&resource=experiment&limit=10&offset=5",
      { headers: authedHeaders() },
    );

    const call = prismaMock.auditLog.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      take: number;
      skip: number;
    };
    expect(call.where.projectId).toBe("proj_a");
    expect(call.where.action).toBe("create");
    expect(call.where.resource).toBe("experiment");
    expect(call.take).toBe(10);
    expect(call.skip).toBe(5);
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await app.request(
      "http://localhost/dashboard/audit-logs",
      { headers: authedHeaders() },
    );
    expect(res.status).toBe(400);
  });
});
