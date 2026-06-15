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

// =============================================================
// Dashboard: LTV distribution metrics endpoint
// =============================================================
//
// The endpoint is a thin wrapper around `services/metrics/ltv.ts`
// (CH-only). The unit test exercises:
//   1. dashboard-auth gating (cookie missing → 401)
//   2. project access enforcement (non-member → 403)
//   3. happy path returns the distribution payload

const { ltvMock } = vi.hoisted(() => ({
  ltvMock: {
    getLtvDistribution: vi.fn(async () => ({
      avgUsd: "42.5000",
      medianUsd: "30.0000",
      p90Usd: "120.0000",
      totalSubscribers: 50,
      histogram: [
        { lowerUsd: 0, upperUsd: 5, count: 10 },
        { lowerUsd: 1000, upperUsd: null, count: 2 },
      ],
    })),
  },
}));

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
vi.mock("../src/services/metrics/ltv", () => ltvMock);
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ltvMock.getLtvDistribution.mockResolvedValue({
    avgUsd: "42.5000",
    medianUsd: "30.0000",
    p90Usd: "120.0000",
    totalSubscribers: 50,
    histogram: [
      { lowerUsd: 0, upperUsd: 5, count: 10 },
      { lowerUsd: 1000, upperUsd: null, count: 2 },
    ],
  });
});

const authedHeaders = { cookie: "session=test" };

describe("GET /dashboard/projects/:projectId/metrics/ltv", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(401);
  });

  test("403 when caller is not a project member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns the distribution", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toMatchObject({
      avgUsd: "42.5000",
      totalSubscribers: 50,
    });
    const histogram = body.data.histogram as Array<Record<string, unknown>>;
    expect(histogram).toHaveLength(2);
    expect(histogram[1]!.upperUsd).toBeNull();
  });
});
