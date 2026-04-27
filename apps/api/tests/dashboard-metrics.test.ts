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
// Dashboard: MRR metrics endpoint
// =============================================================
//
// The endpoint is a thin wrapper around `services/metrics/mrr.ts`
// (CH-only since Plan 3). The unit test exercises:
//   1. dashboard-auth gating (cookie missing → 401)
//   2. project access enforcement (non-member → 403)
//   3. default window (30 days when no query params)
//   4. explicit from/to passthrough
//   5. window cap (>365 days → 400)
//   6. from > to (→ 400)

const { mrrMock } = vi.hoisted(() => ({
  mrrMock: {
    listDailyMrr: vi.fn(async () => [
      {
        bucket: new Date("2026-04-01T00:00:00Z"),
        grossUsd: "99.90",
        eventCount: 10,
        activeSubscribers: 8,
      },
    ]),
  },
}));

const { drizzleMock, authMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
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
vi.mock("../src/services/metrics/mrr", () => mrrMock);
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mrrMock.listDailyMrr.mockResolvedValue([
    {
      bucket: new Date("2026-04-01T00:00:00Z"),
      grossUsd: "99.90",
      eventCount: 10,
      activeSubscribers: 8,
    },
  ]);
});

const authedHeaders = { cookie: "session=test" };

describe("GET /dashboard/projects/:projectId/metrics/mrr", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(401);
  });

  test("403 when caller is not a project member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns points for the default 30-day window", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        from: string;
        to: string;
        points: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.points).toHaveLength(1);
    expect(body.data.points[0]).toMatchObject({
      bucket: "2026-04-01T00:00:00.000Z",
      grossUsd: "99.90",
      eventCount: 10,
      activeSubscribers: 8,
    });
    // Default window spans ~30 days
    const fromDate = new Date(body.data.from);
    const toDate = new Date(body.data.to);
    const spanDays =
      (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(29);
    expect(spanDays).toBeLessThan(31);
  });

  test("passes explicit from/to to the repository", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    await app.request(
      "/dashboard/projects/proj_1/metrics/mrr?from=2026-03-01T00:00:00Z&to=2026-03-15T00:00:00Z",
      { headers: authedHeaders },
    );
    const call = mrrMock.listDailyMrr.mock.calls[0]![0];
    expect(call.projectId).toBe("proj_1");
    expect(call.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(call.to.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  test("rejects windows larger than the cap", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(400);
  });

  test("rejects from > to", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr?from=2026-04-10T00:00:00Z&to=2026-04-01T00:00:00Z",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(400);
  });
});
