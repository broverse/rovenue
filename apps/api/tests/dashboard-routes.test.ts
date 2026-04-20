import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, authMock, flagMock, engineMock } = vi.hoisted(() => {
  const prismaMock = {
    projectMember: { findUnique: vi.fn() },
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
    experimentAssignment: {
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "al_1" })),
      findFirst: vi.fn(async () => null),
    },
    featureFlag: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $executeRaw: vi.fn(async () => 0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: any) => fn(prismaMock)),
  };

  const authMock = {
    auth: {
      api: {
        getSession: vi.fn(),
      },
    },
  };

  const flagMock = {
    evaluateAllFlags: vi.fn(async () => ({})),
    invalidateFlagCache: vi.fn(async () => undefined),
  };

  const engineMock = {
    evaluateExperiments: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    resolveProductGroup: vi.fn(async () => null),
    invalidateExperimentCache: vi.fn(async () => undefined),
    getExperimentResults: vi.fn(async () => ({
      experimentId: "exp_1",
      key: "exp",
      type: "FLAG",
      variants: [],
      srm: { chi2: 0, df: 0, pValue: 1, isMismatch: false, message: "" },
      sampleSize: 100,
    })),
  };

  return { prismaMock, authMock, flagMock, engineMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  MemberRole: {
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    VIEWER: "VIEWER",
  },
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
  Store: {
    APP_STORE: "APP_STORE",
    PLAY_STORE: "PLAY_STORE",
    STRIPE: "STRIPE",
  },
  Environment: { PRODUCTION: "PRODUCTION", SANDBOX: "SANDBOX" },
  PurchaseStatus: {
    TRIAL: "TRIAL",
    ACTIVE: "ACTIVE",
    EXPIRED: "EXPIRED",
    REFUNDED: "REFUNDED",
    REVOKED: "REVOKED",
    PAUSED: "PAUSED",
    GRACE_PERIOD: "GRACE_PERIOD",
  },
  ProductType: {
    SUBSCRIPTION: "SUBSCRIPTION",
    CONSUMABLE: "CONSUMABLE",
    NON_CONSUMABLE: "NON_CONSUMABLE",
  },
  CreditLedgerType: {
    PURCHASE: "PURCHASE",
    SPEND: "SPEND",
    REFUND: "REFUND",
    BONUS: "BONUS",
    EXPIRE: "EXPIRE",
  },
  WebhookEventStatus: {
    RECEIVED: "RECEIVED",
    PROCESSING: "PROCESSING",
    PROCESSED: "PROCESSED",
    FAILED: "FAILED",
  },
  WebhookSource: { APPLE: "APPLE", GOOGLE: "GOOGLE", STRIPE: "STRIPE" },
  OutgoingWebhookStatus: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED" },
  RevenueEventType: {
    INITIAL: "INITIAL",
    RENEWAL: "RENEWAL",
    TRIAL_CONVERSION: "TRIAL_CONVERSION",
    CANCELLATION: "CANCELLATION",
    REFUND: "REFUND",
    REACTIVATION: "REACTIVATION",
    CREDIT_PURCHASE: "CREDIT_PURCHASE",
  },
  Prisma: {
    sql: (s: TemplateStringsArray, ...v: unknown[]) => ({ strings: s, values: v }),
    Decimal: class {
      constructor(public value: number | string) {}
      toString() {
        return String(this.value);
      }
    },
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class extends Error {
      code = "";
    },
  },
}));

vi.mock("../src/lib/auth", () => authMock);
vi.mock("../src/services/flag-engine", () => flagMock);
vi.mock("../src/services/experiment-engine", () => engineMock);

// =============================================================
// Import app after mocks
// =============================================================

import { app } from "../src/app";

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test-session" };
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
});

// =============================================================
// Auth + membership
// =============================================================

describe("dashboard auth", () => {
  it("returns 401 without a session", async () => {
    authMock.auth.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "http://localhost/dashboard/audiences?projectId=proj_a",
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the user is not a project member", async () => {
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "http://localhost/dashboard/audiences?projectId=proj_a",
      { headers: authedHeaders() },
    );
    expect(res.status).toBe(403);
  });
});

// =============================================================
// Audiences — seed + CRUD rules
// =============================================================

describe("dashboard audiences", () => {
  it("seeds the All Users audience on first list", async () => {
    prismaMock.audience.findFirst.mockResolvedValue(null);
    prismaMock.audience.findMany.mockResolvedValue([]);

    await app.request(
      "http://localhost/dashboard/audiences?projectId=proj_a",
      { headers: authedHeaders() },
    );

    expect(prismaMock.audience.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "proj_a",
        name: "All Users",
        rules: {},
        isDefault: true,
      }),
    });
  });

  it("invalidates flag + experiment caches on create", async () => {
    prismaMock.audience.findFirst.mockResolvedValue({ id: "aud_default" });
    prismaMock.audience.create.mockResolvedValue({
      id: "aud_new",
      projectId: "proj_a",
      name: "TR iOS",
      rules: { country: "TR" },
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

    expect(flagMock.invalidateFlagCache).toHaveBeenCalledWith("proj_a");
    expect(engineMock.invalidateExperimentCache).toHaveBeenCalledWith(
      "proj_a",
    );
  });

  it("refuses to delete an audience referenced by an experiment", async () => {
    prismaMock.audience.findUnique.mockResolvedValue({
      id: "aud_tr",
      projectId: "proj_a",
      isDefault: false,
    });
    prismaMock.experiment.findFirst.mockResolvedValue({ id: "exp_1" });

    const res = await app.request(
      "http://localhost/dashboard/audiences/aud_tr",
      { method: "DELETE", headers: authedHeaders() },
    );

    expect(res.status).toBe(409);
    expect(prismaMock.audience.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete the default All Users audience", async () => {
    prismaMock.audience.findUnique.mockResolvedValue({
      id: "aud_all",
      projectId: "proj_a",
      isDefault: true,
    });

    const res = await app.request(
      "http://localhost/dashboard/audiences/aud_all",
      { method: "DELETE", headers: authedHeaders() },
    );

    expect(res.status).toBe(400);
  });
});

// =============================================================
// Experiments — state machine
// =============================================================

describe("dashboard experiments — state machine", () => {
  function experiment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "exp_1",
      projectId: "proj_a",
      name: "Test",
      type: "FLAG",
      key: "test-exp",
      audienceId: "aud_all",
      status: "DRAFT",
      variants: [
        { id: "control", name: "Control", value: false, weight: 0.5 },
        { id: "variant_a", name: "A", value: true, weight: 0.5 },
      ],
      metrics: null,
      mutualExclusionGroup: null,
      startedAt: null,
      completedAt: null,
      winnerVariantId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("start transitions DRAFT → RUNNING", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(experiment());
    prismaMock.experiment.update.mockImplementation(async (args: any) => ({
      ...experiment(),
      ...args.data,
    }));

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1/start",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    const update = prismaMock.experiment.update.mock.calls[0]![0] as {
      data: { status: string; startedAt: Date };
    };
    expect(update.data.status).toBe("RUNNING");
    expect(update.data.startedAt).toBeInstanceOf(Date);
    expect(engineMock.invalidateExperimentCache).toHaveBeenCalledWith("proj_a");
  });

  it("rejects starting a COMPLETED experiment", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "COMPLETED" }),
    );

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1/start",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(400);
  });

  it("pause + resume cycle RUNNING ↔ PAUSED", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "RUNNING" }),
    );
    prismaMock.experiment.update.mockImplementation(async (args: any) => ({
      ...experiment(),
      ...args.data,
    }));

    const pause = await app.request(
      "http://localhost/dashboard/experiments/exp_1/pause",
      { method: "POST", headers: authedHeaders() },
    );
    expect(pause.status).toBe(200);

    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "PAUSED" }),
    );
    const resume = await app.request(
      "http://localhost/dashboard/experiments/exp_1/resume",
      { method: "POST", headers: authedHeaders() },
    );
    expect(resume.status).toBe(200);

    const pauseCall = prismaMock.experiment.update.mock.calls[0]![0] as {
      data: { status: string };
    };
    const resumeCall = prismaMock.experiment.update.mock.calls[1]![0] as {
      data: { status: string };
    };
    expect(pauseCall.data.status).toBe("PAUSED");
    expect(resumeCall.data.status).toBe("RUNNING");
  });

  it("stop transitions RUNNING → COMPLETED with winner", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "RUNNING" }),
    );
    prismaMock.experiment.update.mockImplementation(async (args: any) => ({
      ...experiment(),
      ...args.data,
    }));

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1/stop",
      {
        method: "POST",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ winnerVariantId: "variant_a" }),
      },
    );

    expect(res.status).toBe(200);
    const update = prismaMock.experiment.update.mock.calls[0]![0] as {
      data: {
        status: string;
        completedAt: Date;
        winnerVariantId: string;
      };
    };
    expect(update.data.status).toBe("COMPLETED");
    expect(update.data.winnerVariantId).toBe("variant_a");
  });

  it("stop with promoteToFlag creates a feature flag from the winning variant", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "RUNNING" }),
    );
    prismaMock.experiment.update.mockImplementation(async (args: any) => ({
      ...experiment(),
      ...args.data,
    }));
    prismaMock.featureFlag.create.mockResolvedValue({
      id: "flag_promoted",
      key: "test-exp_winner",
    });

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1/stop",
      {
        method: "POST",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          winnerVariantId: "variant_a",
          promoteToFlag: true,
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(prismaMock.featureFlag.create).toHaveBeenCalled();
    expect(flagMock.invalidateFlagCache).toHaveBeenCalledWith("proj_a");
  });

  it("PATCH on RUNNING experiment accepts weight changes but rejects new variants", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "RUNNING" }),
    );

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1",
      {
        method: "PATCH",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          variants: [
            { id: "control", weight: 0.7 },
            { id: "variant_a", weight: 0.3 },
          ],
        }),
      },
    );

    expect(res.status).toBe(200);
  });

  it("PATCH on RUNNING rejects adding a new variant", async () => {
    prismaMock.experiment.findUnique.mockResolvedValue(
      experiment({ status: "RUNNING" }),
    );

    const res = await app.request(
      "http://localhost/dashboard/experiments/exp_1",
      {
        method: "PATCH",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          variants: [
            { id: "control", weight: 0.4 },
            { id: "variant_a", weight: 0.3 },
            { id: "variant_b", weight: 0.3 },
          ],
        }),
      },
    );

    expect(res.status).toBe(400);
  });
});

// =============================================================
// Feature flags
// =============================================================

describe("dashboard feature flags", () => {
  it("create invalidates the flag cache", async () => {
    prismaMock.featureFlag.create.mockResolvedValue({
      id: "flag_1",
      projectId: "proj_a",
      key: "new_paywall",
      type: "BOOLEAN",
      defaultValue: false,
      rules: [],
      isEnabled: true,
    });

    await app.request("http://localhost/dashboard/feature-flags", {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj_a",
        key: "new_paywall",
        type: "BOOLEAN",
        defaultValue: false,
      }),
    });

    expect(flagMock.invalidateFlagCache).toHaveBeenCalledWith("proj_a");
  });

  it("toggle flips isEnabled and invalidates cache", async () => {
    prismaMock.featureFlag.findUnique.mockResolvedValue({
      id: "flag_1",
      projectId: "proj_a",
      isEnabled: true,
    });
    prismaMock.featureFlag.update.mockImplementation(async (args: any) => ({
      id: "flag_1",
      projectId: "proj_a",
      isEnabled: args.data.isEnabled,
    }));

    const res = await app.request(
      "http://localhost/dashboard/feature-flags/flag_1/toggle",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { flag: { isEnabled: boolean } } };
    expect(body.data.flag.isEnabled).toBe(false);
    expect(flagMock.invalidateFlagCache).toHaveBeenCalledWith("proj_a");
  });
});
