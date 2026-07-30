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
    projectMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(async () => 0),
    },
    user: { findUnique: vi.fn() },
    auditLog: {
      create: vi.fn(async () => ({ id: "al_1" })),
      findFirst: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(dbMock),
    ),
  };

  // Drizzle read paths delegate to the dbMock spies so existing
  // `dbMock.projectMember.findUnique.mockResolvedValue(...)` test
  // setup keeps driving the assertions 1:1.
  // The PATCH/DELETE handlers build a notification context inside their
  // transaction with a raw `tx.select(...).from(...).where(...).limit(1)`
  // (loadEmitContext in the route). The object handed to that callback is
  // this one, so without a select chain the handler dies with "tx.select is
  // not a function" and the route answers 500 — which reads like a
  // permissions failure and is not one. Resolving to [] is the right stub:
  // the route already falls back to the project id and "Someone".
  const emptyChain: Record<string, unknown> = {};
  emptyChain.from = () => emptyChain;
  emptyChain.where = () => emptyChain;
  emptyChain.limit = async () => [];

  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
    select: vi.fn(() => emptyChain),
  };
  const drizzleMock = {
    db: drizzleDb,
    projectRepo: {
      findMembership: vi.fn(async (_db, projectId, userId) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
      findMembershipsForUser: vi.fn(async () => []),
      listProjectMembers: vi.fn(async (_db: unknown, projectId: string) => {
        const rows = await dbMock.projectMember.findMany({
          where: { projectId },
          include: { user: { select: { email: true, name: true, image: true } } },
          orderBy: { createdAt: "asc" },
        });
        return Array.isArray(rows) ? rows : [];
      }),
      countProjectOwners: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.projectMember.count({
          where: { projectId, role: "OWNER" },
        }),
      ),
      // Write paths. Delegate to the dbMock spies so existing
      // `dbMock.projectMember.create.mockResolvedValue(...)`
      // setup keeps driving the test assertions.
      createProjectMember: vi.fn(
        async (
          _tx: unknown,
          input: { projectId: string; userId: string; role: string },
        ) =>
          dbMock.projectMember.create({
            data: { projectId: input.projectId, userId: input.userId, role: input.role },
          }),
      ),
      updateProjectMemberRole: vi.fn(
        async (
          _tx: unknown,
          projectId: string,
          userId: string,
          role: string,
        ) =>
          dbMock.projectMember.update({
            where: { projectId_userId: { projectId, userId } },
            data: { role },
            include: { user: { select: { email: true, name: true, image: true } } },
          }),
      ),
      deleteProjectMember: vi.fn(
        async (_tx: unknown, projectId: string, userId: string) =>
          dbMock.projectMember.delete({
            where: { projectId_userId: { projectId, userId } },
          }),
      ),
    },
    userRepo: {
      findUserByEmail: vi.fn(async (_db: unknown, email: string) =>
        dbMock.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, image: true },
        }),
      ),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { dbMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return {
    ...actual,
    default: dbMock,
    // Real `schema` — pure table definitions with no connection behind them.
    // src/lib/audit.ts destructures `drizzle.schema` at module scope, so a
    // drizzle mock without it fails collection before any test runs.
    drizzle: { ...drizzleMock, schema: actual.drizzle.schema },
    // MemberRole is NOT overridden: it used to be stubbed as
    // OWNER/ADMIN/VIEWER, and VIEWER was dropped from the enum in
    // "feat(db): drop VIEWER from MemberRole enum". A stub that keeps a
    // retired role alive lets these tests assert against a permission model
    // the product no longer has, which is exactly what happened — the real
    // enum is OWNER/ADMIN/DEVELOPER/GROWTH/CUSTOMER_SUPPORT and comes from
    // `...actual`.
  };
});
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

// Member changes emit a team notification. That pipeline has its own tests
// (notifier.integration.test.ts); here it is an unrelated dependency whose
// real implementation writes to tables this file does not model.
vi.mock("../src/services/notifications/emit", () => ({
  emitNotification: vi.fn(async () => undefined),
}));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /dashboard/projects/:projectId/members", () => {
  test("forbidden for non-member", async () => {
    signedIn("outsider");
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/members");
    expect(res.status).toBe(403);
  });

  test("returns list with user fields", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "CUSTOMER_SUPPORT" });
    dbMock.projectMember.findMany.mockResolvedValue([
      {
        id: "pm_owner",
        userId: "u1",
        role: "OWNER",
        createdAt: new Date("2026-04-10"),
        user: { email: "owner@x.com", name: "Owner", image: null },
      },
      {
        id: "pm_admin",
        userId: "u2",
        role: "ADMIN",
        createdAt: new Date("2026-04-11"),
        user: { email: "admin@x.com", name: null, image: "https://img" },
      },
    ]);

    const res = await app.request("/dashboard/projects/proj_1/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { members: Array<{ email: string; role: string }> };
    };
    expect(body.data.members).toHaveLength(2);
    expect(body.data.members[0]).toMatchObject({ email: "owner@x.com", role: "OWNER" });
    expect(body.data.members[1]).toMatchObject({ email: "admin@x.com", role: "ADMIN" });
  });
});

// The POST /members endpoint that used to live here is gone: adding someone
// by email became an invitation flow (src/routes/dashboard/invitations.ts,
// covered by invitations.integration.test.ts). The three tests that
// exercised it were left behind and had been hitting an unmatched route,
// so Hono answered 404 and they read as authorization failures.
describe("PATCH /dashboard/projects/:projectId/members/:userId", () => {
  test("OWNER changes role with audit", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique
      .mockResolvedValueOnce({ id: "pm_caller", role: "OWNER" })
      .mockResolvedValueOnce({ id: "pm_target", role: "ADMIN" });
    dbMock.projectMember.update.mockResolvedValue({
      id: "pm_target",
      userId: "u2",
      role: "DEVELOPER",
      createdAt: new Date("2026-04-10"),
      user: { email: "a@x", name: null, image: null },
    });

    const res = await app.request("/dashboard/projects/proj_1/members/u2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "CUSTOMER_SUPPORT" }),
    });
    expect(res.status).toBe(200);
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.role_changed" }),
      expect.anything(),
    );
  });

  test("refuses to demote the last OWNER", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique
      .mockResolvedValueOnce({ id: "pm_caller", role: "OWNER" })
      .mockResolvedValueOnce({ id: "pm_target", role: "OWNER" });
    dbMock.projectMember.count.mockResolvedValue(1);

    const res = await app.request("/dashboard/projects/proj_1/members/u1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "CUSTOMER_SUPPORT" }),
    });
    expect(res.status).toBe(400);
    expect(dbMock.projectMember.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /dashboard/projects/:projectId/members/:userId", () => {
  test("OWNER removes a regular member", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique
      .mockResolvedValueOnce({ id: "pm_caller", role: "OWNER" })
      .mockResolvedValueOnce({ id: "pm_target", role: "CUSTOMER_SUPPORT" });

    const res = await app.request("/dashboard/projects/proj_1/members/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(dbMock.projectMember.delete).toHaveBeenCalled();
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.removed" }),
      expect.anything(),
    );
  });

  test("refuses to remove the last OWNER", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique
      .mockResolvedValueOnce({ id: "pm_caller", role: "OWNER" })
      .mockResolvedValueOnce({ id: "pm_target", role: "OWNER" });
    dbMock.projectMember.count.mockResolvedValue(1);

    const res = await app.request("/dashboard/projects/proj_1/members/u1", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    expect(dbMock.projectMember.delete).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/projects/:projectId/members/leave", () => {
  test("ADMIN can leave", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_self", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/members/leave", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(dbMock.projectMember.delete).toHaveBeenCalled();
  });

  test("OWNER cannot leave if they are the last OWNER", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_self", role: "OWNER" });
    dbMock.projectMember.count.mockResolvedValue(1);
    const res = await app.request("/dashboard/projects/proj_1/members/leave", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(dbMock.projectMember.delete).not.toHaveBeenCalled();
  });
});
