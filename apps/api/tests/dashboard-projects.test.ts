import { beforeEach, describe, expect, test, vi } from "vitest";

const { prismaMock, drizzleMock, authMock } = vi.hoisted(() => {
  const prismaMock = {
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
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(prismaMock)),
  };
  const drizzleMock = {
    db: {} as unknown,
    projectRepo: {
      findMembership: vi.fn(async (_db, projectId, userId) =>
        prismaMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
      findMembershipsForUser: vi.fn(async () => []),
      listProjectMembers: vi.fn(async () => []),
      countProjectOwners: vi.fn(async () => 0),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { prismaMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
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
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /dashboard/projects", () => {
  test("returns the caller's memberships with role", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findMany.mockResolvedValue([
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
        role: "VIEWER",
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
    const body = (await res.json()) as { data: { projects: Array<{ id: string; role: string; slug: string }> } };
    expect(body.data.projects).toHaveLength(2);
    expect(body.data.projects[0]).toMatchObject({ id: "proj_1", role: "OWNER", slug: "acme" });
    expect(body.data.projects[1]).toMatchObject({ id: "proj_2", role: "VIEWER", slug: "beta" });
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
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Acme",
      slug: "acme",
      webhookUrl: "https://hook.example.com",
      webhookSecret: "topsecret",
      settings: {},
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date("2026-04-10"),
    });
    prismaMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k1",
        label: "default",
        keyPublic: "rov_pub_abcd1234",
        environment: "PRODUCTION",
        revokedAt: null,
        createdAt: new Date("2026-04-01"),
      },
    ]);
    prismaMock.subscriber.count.mockResolvedValue(42);
    prismaMock.experiment.count.mockResolvedValue(3);
    prismaMock.featureFlag.count.mockResolvedValue(5);

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
    expect(body.data.project.slug).toBe("acme");
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
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(403);
  });

  test("strips sensitive-looking keys from settings before returning", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.findUnique.mockResolvedValue({
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
    prismaMock.apiKey.findMany.mockResolvedValue([]);
    prismaMock.subscriber.count.mockResolvedValue(0);
    prismaMock.experiment.count.mockResolvedValue(0);
    prismaMock.featureFlag.count.mockResolvedValue(0);

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
    prismaMock.project.create.mockResolvedValue({
      id: "proj_new",
      name: "Alpha",
      slug: "alpha",
      webhookUrl: null,
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-18"),
      updatedAt: new Date("2026-04-18"),
    });
    prismaMock.projectMember.create.mockResolvedValue({ id: "pm_new", role: "OWNER" });
    prismaMock.audience.create.mockResolvedValue({ id: "aud_default", isDefault: true });
    prismaMock.apiKey.create.mockResolvedValue({
      id: "k_new",
      label: "default",
      keyPublic: "rov_pub_new_id_xxxx",
      environment: "PRODUCTION",
      createdAt: new Date("2026-04-18"),
    });
    prismaMock.apiKey.findMany.mockResolvedValue([
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
    expect(body.data.project).toMatchObject({ id: "proj_new", name: "Alpha", slug: "alpha" });
    expect(body.data.apiKey.publicKey).toMatch(/^rov_pub_/);
    expect(body.data.apiKey.secretKey).toMatch(/^rov_sec_/);
    // Plaintext secret appears in the response but secretKey hash never does.
    expect(body.data.apiKey.publicKey).toBe("rov_pub_new_id_xxxx");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.project.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "OWNER", userId: "user_1" }),
      }),
    );
    expect(prismaMock.audience.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true, name: "All Users" }),
      }),
    );
    expect(prismaMock.apiKey.create).toHaveBeenCalledTimes(1);
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

  test("accepts environment override (SANDBOX)", async () => {
    signedIn("user_1");
    prismaMock.project.create.mockResolvedValue({
      id: "proj_sandbox",
      name: "Sbx",
      slug: "sbx",
      webhookUrl: null,
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-18"),
      updatedAt: new Date("2026-04-18"),
    });
    prismaMock.projectMember.create.mockResolvedValue({ id: "pm_new", role: "OWNER" });
    prismaMock.audience.create.mockResolvedValue({ id: "aud_default", isDefault: true });
    prismaMock.apiKey.create.mockResolvedValue({
      id: "k_sbx",
      label: "default",
      keyPublic: "rov_pub_sandbox_yyy",
      environment: "SANDBOX",
      createdAt: new Date("2026-04-18"),
    });
    prismaMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k_sbx",
        label: "default",
        keyPublic: "rov_pub_sandbox_yyy",
        environment: "SANDBOX",
        revokedAt: null,
        createdAt: new Date("2026-04-18"),
      },
    ]);

    const res = await app.request("/dashboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sbx", slug: "sbx", environment: "SANDBOX" }),
    });

    expect(res.status).toBe(200);
    expect(prismaMock.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ environment: "SANDBOX" }),
      }),
    );
  });
});

describe("PATCH /dashboard/projects/:id", () => {
  test("requires ADMIN role — VIEWER gets 403", async () => {
    signedIn("viewer");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "VIEWER" });
    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(403);
  });

  test("ADMIN can rename and update webhookUrl; writes an audit entry", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    prismaMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Old",
      webhookUrl: null,
      settings: {},
    });
    prismaMock.project.update.mockResolvedValue({
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
    prismaMock.apiKey.findMany.mockResolvedValue([]);
    prismaMock.subscriber.count.mockResolvedValue(0);
    prismaMock.experiment.count.mockResolvedValue(0);
    prismaMock.featureFlag.count.mockResolvedValue(0);

    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", webhookUrl: "https://new.example.com" }),
    });
    expect(res.status).toBe(200);
    expect(prismaMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proj_1" },
        data: expect.objectContaining({ name: "Renamed", webhookUrl: "https://new.example.com" }),
      }),
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    // Atomicity: project.update + auditLog.create run inside the SAME
    // $transaction call, so a crash between them can't leave a silent
    // mutation.
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.project.update.mock.invocationCallOrder[0]!,
    );

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
    expect(body.data.project.slug).toBe("proj-1");
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
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    prismaMock.project.findUnique.mockResolvedValue({
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
    expect(prismaMock.project.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  test("404 when project not found", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    prismaMock.project.findUnique.mockResolvedValue(null);
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
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    prismaMock.project.findUnique.mockResolvedValue({
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
    expect(prismaMock.project.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/projects/:id/webhook-secret/rotate", () => {
  test("requires OWNER — ADMIN gets 403", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("OWNER rotates the secret; audit before/after are redacted", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.update.mockResolvedValue({ id: "proj_1", webhookSecret: "new_placeholder" });

    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { webhookSecret: string } };
    expect(body.data.webhookSecret).toMatch(/^whsec_/);

    const auditCall = prismaMock.auditLog.create.mock.calls[0]?.[0] as {
      data: { before: Record<string, unknown>; after: Record<string, unknown>; resource: string };
    };
    expect(auditCall.data.resource).toBe("credential");
    expect(auditCall.data.before).toEqual({ webhookSecret: "[REDACTED]" });
    expect(auditCall.data.after).toEqual({ webhookSecret: "[REDACTED]" });
  });
});

describe("DELETE /dashboard/projects/:id", () => {
  test("requires OWNER — ADMIN gets 403", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("OWNER deletes the project AND writes an audit entry first", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.delete.mockResolvedValue({ id: "proj_1" });

    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(prismaMock.project.delete).toHaveBeenCalledWith({ where: { id: "proj_1" } });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "project.deleted",
          resource: "project",
          resourceId: "proj_1",
        }),
      }),
    );
  });
});
