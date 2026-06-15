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

const { engagementMock } = vi.hoisted(() => ({
  engagementMock: { listEngagement: vi.fn(async () => [ { bucket: new Date("2026-04-01T00:00:00Z"), sessionCount: 120, avgSessionMs: 45000, activeSubscribers: 30 } ]) },
}));
vi.mock("../src/services/metrics/engagement", () => engagementMock);

const { drizzleMock, authMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    schema: { notifications: {} },
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    notificationRepo: {
      listNotifications: vi.fn(async () => []),
      countUnread: vi.fn(async () => 0),
      markRead: vi.fn(async () => undefined),
      markAllRead: vi.fn(async () => undefined),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { drizzleMock, authMock };
});

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    projectMember: { findUnique: vi.fn() },
  },
}));

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return {
    ...actual,
    default: dbMock,
    drizzle: drizzleMock,
  };
});
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  engagementMock.listEngagement.mockResolvedValue([
    { bucket: new Date("2026-04-01T00:00:00Z"), sessionCount: 120, avgSessionMs: 45000, activeSubscribers: 30 },
  ]);
});

const authedHeaders = { cookie: "session=test" };

describe("GET /dashboard/projects/:projectId/metrics/engagement", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/engagement",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(401);
  });

  test("403 when caller is not a project member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/engagement",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns engagement points for VIEWER", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/engagement",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { from: string; to: string; points: Record<string, unknown>[] };
    };
    expect(body.data.points).toHaveLength(1);
    expect(body.data.points[0]).toMatchObject({
      bucket: "2026-04-01T00:00:00.000Z",
      sessionCount: 120,
      avgSessionMs: 45000,
      activeSubscribers: 30,
    });
  });
});
