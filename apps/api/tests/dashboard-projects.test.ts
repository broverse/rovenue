import { beforeEach, describe, expect, test, vi } from "vitest";
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

const { dbMock, drizzleMock, authMock } = vi.hoisted(() => {
  const dbMock = {
    projectMember: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    project: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    audience: { create: vi.fn() },
    apiKey: { create: vi.fn(), findMany: vi.fn(async () => []) },
    subscriber: { count: vi.fn(async () => 0) },
    experiment: { count: vi.fn(async () => 0) },
    featureFlag: { count: vi.fn(async () => 0) },
    auditLog: {
      create: vi.fn(async () => ({ id: "al_1" })),
      findFirst: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(dbMock)),
  };
  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };
  const drizzleMock = {
    db: drizzleDb,
    // Creating a project now also opens a free billing subscription
    // (src/services/billing/create-free-subscription.ts). Without this the
    // handler died inside its transaction with "Cannot read properties of
    // undefined (reading 'createFreeBillingSubscription')" and answered 500.
    billingSubscriptionRepo: {
      createFreeBillingSubscription: vi.fn(async () => ({
        id: "bsub_1",
        tier: "free",
      })),
    },
    projectRepo: {
      findMembership: vi.fn(async (_db, projectId, userId) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async (_db: unknown, id: string) =>
        dbMock.project.findUnique({ where: { id } }),
      ),
      findProjectCredentials: vi.fn(async () => null),
      findMembershipsForUser: vi.fn(async (_db: unknown, userId: string) => {
        const rows = await dbMock.projectMember.findMany({
          where: { userId },
          include: { project: true },
          orderBy: { createdAt: "desc" },
        });
        // The drizzle repo returns rows with `project` inlined.
        return Array.isArray(rows) ? rows : [];
      }),
      listProjectMembers: vi.fn(async () => []),
      countProjectOwners: vi.fn(async () => 0),
      // --- writes — delegate to the dbMock spies.
      createProject: vi.fn(
        async (
          _tx: unknown,
          input: { name: string; slug: string; settings: unknown },
        ) => dbMock.project.create({ data: input }),
      ),
      updateProject: vi.fn(
        async (
          _tx: unknown,
          id: string,
          patch: Record<string, unknown>,
        ) =>
          dbMock.project.update({
            where: { id },
            data: patch,
          }),
      ),
      updateProjectWebhookSecret: vi.fn(
        async (_tx: unknown, id: string, webhookSecret: string) =>
          dbMock.project.update({
            where: { id },
            data: { webhookSecret },
          }),
      ),
      deleteProject: vi.fn(
        async (_tx: unknown, id: string) =>
          dbMock.project.delete({ where: { id } }),
      ),
      createProjectMember: vi.fn(
        async (
          _tx: unknown,
          input: { projectId: string; userId: string; role: string },
        ) => dbMock.projectMember.create({ data: input }),
      ),
    },
    audienceRepo: {
      createAudience: vi.fn(
        async (_tx: unknown, input: Record<string, unknown>) =>
          dbMock.audience.create({ data: input }),
      ),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async () => null),
      findApiKeyById: vi.fn(async () => null),
      listActiveApiKeys: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.apiKey.findMany({ where: { projectId, revokedAt: null } }),
      ),
      createApiKey: vi.fn(
        async (_tx: unknown, input: Record<string, unknown>) =>
          dbMock.apiKey.create({ data: input }),
      ),
    },
    subscriberRepo: {
      countActiveSubscribers: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.subscriber.count({ where: { projectId, deletedAt: null } }),
      ),
    },
    experimentRepo: {
      countExperiments: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.experiment.count({ where: { projectId } }),
      ),
    },
    dashboardFeatureFlagRepo: {
      countFeatureFlags: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.featureFlag.count({ where: { projectId } }),
      ),
      listFeatureFlags: vi.fn(async () => []),
      findFeatureFlagById: vi.fn(async () => null),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { dbMock, drizzleMock, authMock };
});

// What is under test is the database, not the package around it. This mock
// used to replace @rovenue/db wholesale, which meant every unrelated export
// the import graph happens to touch had to be re-listed here by hand — and a
// missing one is not a test failure but a COLLECTION failure, so the file
// reports "no tests" and blames a TypeError in someone else's module.
// `drizzle.schema` is the sharpest case: src/lib/audit.ts does
// `const { auditLogs } = drizzle.schema` at module scope, so the file could
// not be loaded at all. Starting from the real module and overriding only
// what talks to a database keeps that failure mode from coming back.
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    default: dbMock,
    drizzle: { ...drizzleMock, schema: actual.drizzle.schema },
    // MemberRole is NOT stubbed: VIEWER was dropped from the enum, and
    // keeping it alive here let these tests assert a permission model the
    // product no longer has. The real enum arrives via `...actual`.
    FeatureFlagType: { BOOLEAN: "BOOLEAN", STRING: "STRING", NUMBER: "NUMBER", JSON: "JSON" },
    ExperimentStatus: { DRAFT: "DRAFT", RUNNING: "RUNNING", PAUSED: "PAUSED", COMPLETED: "COMPLETED" },
    Store: { APP_STORE: "APP_STORE", PLAY_STORE: "PLAY_STORE", STRIPE: "STRIPE" },
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
    FeatureFlagEnv: { PROD: "PROD", STAGING: "STAGING", DEVELOPMENT: "DEVELOPMENT" },
  };
});
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /dashboard/projects", () => {
  test("returns the caller's memberships with role", async () => {
    signedIn("user_1");
    dbMock.projectMember.findMany.mockResolvedValue([
      {
        role: "OWNER",
        project: {
          id: "proj_1",
          name: "Acme",
          slug: "acme",
          createdAt: new Date("2026-04-01T00:00:00Z"),
        },
      },
      {
        role: "CUSTOMER_SUPPORT",
        project: {
          id: "proj_2",
          name: "Beta",
          slug: "beta",
          createdAt: new Date("2026-04-10T00:00:00Z"),
        },
      },
    ]);
    const res = await app.request("/dashboard/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { projects: Array<{ id: string; role: string; name: string }> } };
    expect(body.data.projects).toHaveLength(2);
    expect(body.data.projects[0]).toMatchObject({ id: "proj_1", role: "OWNER", name: "Acme" });
    expect(body.data.projects[1]).toMatchObject({ id: "proj_2", role: "CUSTOMER_SUPPORT", name: "Beta" });
  });

  test("returns 401 when the session is missing", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects");
    expect(res.status).toBe(401);
  });
});

describe("GET /dashboard/projects/:id", () => {
  test("returns project detail with counts + API key metadata (no plaintext secret leak)", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    dbMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Acme",
      slug: "acme",
      webhookUrl: "https://hook.example.com",
      webhookSecret: "topsecret",
      settings: {},
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date("2026-04-10"),
    });
    dbMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k1",
        label: "default",
        keyPublic: "rov_pub_abcd1234",
        environment: "PRODUCTION",
        revokedAt: null,
        createdAt: new Date("2026-04-01"),
      },
    ]);
    dbMock.subscriber.count.mockResolvedValue(42);
    dbMock.experiment.count.mockResolvedValue(3);
    dbMock.featureFlag.count.mockResolvedValue(5);

    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        project: {
          slug: string;
          hasWebhookSecret: boolean;
          counts: Record<string, number>;
          apiKeys: Array<{ publicKey: string; environment: string }>;
        };
      };
    };
    expect(body.data.project.hasWebhookSecret).toBe(true);
    expect(body.data.project.counts).toEqual({
      subscribers: 42,
      experiments: 3,
      featureFlags: 5,
      activeApiKeys: 1,
    });
    expect(body.data.project.apiKeys).toHaveLength(1);
    expect(body.data.project.apiKeys[0]!.publicKey).toBe("rov_pub_abcd1234");
    expect(body.data.project.apiKeys[0]!.environment).toBe("PRODUCTION");
    // Plaintext webhookSecret never leaves the server.
    expect(JSON.stringify(body.data.project)).not.toContain("topsecret");
  });

  test("returns 403 when the user is not a member", async () => {
    signedIn("outsider");
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(403);
  });

  test("strips sensitive-looking keys from settings before returning", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    dbMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Acme",
      slug: "acme",
      webhookUrl: null,
      webhookSecret: null,
      settings: {
        defaultEnvironment: "PRODUCTION",
        apiSecret: "LEAKED-SECRET-DO-NOT-SHOW",
        stripeCredential: "sk_live_leak",
        "user.password": "hunter2",
        safeFlag: true,
      },
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date("2026-04-10"),
    });
    dbMock.apiKey.findMany.mockResolvedValue([]);
    dbMock.subscriber.count.mockResolvedValue(0);
    dbMock.experiment.count.mockResolvedValue(0);
    dbMock.featureFlag.count.mockResolvedValue(0);

    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { project: { settings: Record<string, unknown> } } };
    expect(body.data.project.settings).toEqual({
      defaultEnvironment: "PRODUCTION",
      safeFlag: true,
    });
    const serialized = JSON.stringify(body.data.project);
    expect(serialized).not.toContain("LEAKED-SECRET-DO-NOT-SHOW");
    expect(serialized).not.toContain("sk_live_leak");
    expect(serialized).not.toContain("hunter2");
  });
});

describe("POST /dashboard/projects", () => {
  test("creates project + OWNER membership + default audience + api key in one transaction", async () => {
    signedIn("user_1");
    dbMock.project.create.mockResolvedValue({
      id: "proj_new",
      name: "Alpha",
      slug: "alpha",
      webhookUrl: null,
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-18"),
      updatedAt: new Date("2026-04-18"),
    });
    dbMock.projectMember.create.mockResolvedValue({ id: "pm_new", role: "OWNER" });
    dbMock.audience.create.mockResolvedValue({ id: "aud_default", isDefault: true });
    dbMock.apiKey.create.mockResolvedValue({
      id: "k_new",
      label: "default",
      keyPublic: "rov_pub_new_id_xxxx",
      environment: "PRODUCTION",
      createdAt: new Date("2026-04-18"),
    });
    dbMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k_new",
        label: "default",
        keyPublic: "rov_pub_new_id_xxxx",
        environment: "PRODUCTION",
        revokedAt: null,
        createdAt: new Date("2026-04-18"),
      },
    ]);

    const res = await app.request("/dashboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha", slug: "alpha" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        project: { id: string; name: string; slug: string };
        apiKey: { publicKey: string; secretKey: string };
      };
    };
    expect(body.data.project).toMatchObject({ id: "proj_new", name: "Alpha" });
    expect(body.data.apiKey.publicKey).toMatch(/^rov_pub_/);
    expect(body.data.apiKey.secretKey).toMatch(/^rov_sec_/);
    // Plaintext secret appears in the response but secretKey hash never does.
    expect(body.data.apiKey.publicKey).toBe("rov_pub_new_id_xxxx");

    expect(drizzleMock.db.transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.project.create).toHaveBeenCalledTimes(1);
    expect(dbMock.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "OWNER", userId: "user_1" }),
      }),
    );
    expect(dbMock.audience.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true, name: "All Users" }),
      }),
    );
    expect(dbMock.apiKey.create).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when name or slug is missing", async () => {
    signedIn("user_1");
    const res = await app.request("/dashboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // "accepts environment override (SANDBOX)" was removed with the feature.
  // b74aaa00 ("simplify project setup wizard + drop projects.slug") took
  // `environment` and `slug` out of the create-project body, and neither
  // POST /projects nor POST /projects/:id/api-keys accepts an environment
  // any more — dashboard-created keys are always PRODUCTION
  // (api-keys.integration.test.ts asserts exactly that). The test kept
  // asserting an override the API no longer offers.
});

describe("PATCH /dashboard/projects/:id", () => {
  test("requires ADMIN role — CUSTOMER_SUPPORT gets 403", async () => {
    signedIn("viewer");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "CUSTOMER_SUPPORT" });
    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(403);
  });

  test("ADMIN can rename and update webhookUrl; writes an audit entry", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    dbMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Old",
      webhookUrl: null,
      // The route refuses to set a webhookUrl on a project that has no
      // signing secret, so deliveries can never go out unsigned. This
      // fixture predated that guard and was tripping it: PATCH returned 400.
      webhookSecret: "whsec_existing",
      settings: {},
    });
    dbMock.project.update.mockResolvedValue({
      id: "proj_1",
      name: "Renamed",
      slug: "proj-1",
      webhookUrl: "https://new.example.com",
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date(),
    });
    // Reset the count/apiKey mocks to default (clearAllMocks does not
    // undo mockResolvedValue implementations set by earlier tests).
    dbMock.apiKey.findMany.mockResolvedValue([]);
    dbMock.subscriber.count.mockResolvedValue(0);
    dbMock.experiment.count.mockResolvedValue(0);
    dbMock.featureFlag.count.mockResolvedValue(0);

    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", webhookUrl: "https://new.example.com" }),
    });
    expect(res.status).toBe(200);
    expect(dbMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proj_1" },
        data: expect.objectContaining({ name: "Renamed", webhookUrl: "https://new.example.com" }),
      }),
    );
    expect(auditMock.audit).toHaveBeenCalled();
    // Atomicity: project.update runs inside a Drizzle transaction;
    // audit() is invoked with the same tx handle, so a crash between
    // them can't leave a silent mutation.
    expect(drizzleMock.db.transaction).toHaveBeenCalled();
    expect(
      drizzleMock.db.transaction.mock.invocationCallOrder[0]!,
    ).toBeLessThan(dbMock.project.update.mock.invocationCallOrder[0]!);

    const body = (await res.json()) as {
      data: {
        project: {
          id: string;
          name: string;
          slug: string;
          counts: Record<string, number>;
          apiKeys: unknown[];
        };
      };
    };
    expect(body.data.project.id).toBe("proj_1");
    expect(body.data.project.name).toBe("Renamed");
    expect(body.data.project.counts).toEqual({
      subscribers: 0,
      experiments: 0,
      featureFlags: 0,
      activeApiKeys: 0,
    });
    expect(body.data.project.apiKeys).toEqual([]);
  });

  test("empty PATCH body returns 400", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    dbMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Old",
      webhookUrl: null,
      settings: {},
    });
    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(dbMock.project.update).not.toHaveBeenCalled();
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  test("404 when project not found", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    dbMock.project.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // Body is a valid PATCH payload — name must satisfy min(2)/max(80)
      // and be something the zValidator middleware passes through, since
      // schema validation now runs before the 404 check.
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects settings keys that look like secrets", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    dbMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Old",
      webhookUrl: null,
      settings: {},
    });

    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: { safeKey: "ok", apiSecret: "nope" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/apiSecret/);
    expect(dbMock.project.update).not.toHaveBeenCalled();
    expect(auditMock.audit).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/projects/:id/webhook-secret/rotate", () => {
  test("requires OWNER — ADMIN gets 403", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("OWNER rotates the secret; audit before/after are redacted", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    dbMock.project.update.mockResolvedValue({ id: "proj_1", webhookSecret: "new_placeholder" });

    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { webhookSecret: string } };
    expect(body.data.webhookSecret).toMatch(/^whsec_/);

    const auditCall = auditMock.audit.mock.calls[0]?.[0] as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      resource: string;
    };
    expect(auditCall.resource).toBe("credential");
    expect(auditCall.before).toEqual({ webhookSecret: "[REDACTED]" });
    expect(auditCall.after).toEqual({ webhookSecret: "[REDACTED]" });
  });
});

describe("DELETE /dashboard/projects/:id", () => {
  test("requires OWNER — ADMIN gets 403", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("OWNER deletes the project AND writes an audit entry first", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    dbMock.project.delete.mockResolvedValue({ id: "proj_1" });

    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(dbMock.project.delete).toHaveBeenCalledWith({ where: { id: "proj_1" } });
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.deleted",
        resource: "project",
        resourceId: "proj_1",
      }),
      expect.anything(),
    );
  });
});
