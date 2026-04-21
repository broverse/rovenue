import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Dashboard: MRR metrics endpoint
// =============================================================
//
// The endpoint is a thin wrapper around drizzle.metricsRepo.
// listDailyMrr, so the tests exercise:
//   1. dashboard-auth gating (cookie missing → 401)
//   2. project access enforcement (non-member → 403)
//   3. default window (30 days when no query params)
//   4. explicit from/to passthrough
//   5. window cap (>365 days → 400)
//   6. from > to (→ 400)

const { drizzleMock, authMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    metricsRepo: {
      listDailyMrr: vi.fn(async () => [
        {
          bucket: new Date("2026-04-01T00:00:00Z"),
          grossUsd: "99.90",
          eventCount: 10,
          activeSubscribers: 8,
        },
      ]),
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
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { drizzleMock, authMock };
});

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    projectMember: { findUnique: vi.fn() },
  },
}));

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return {
    ...actual,
    default: prismaMock,
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
  drizzleMock.metricsRepo.listDailyMrr.mockResolvedValue([
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
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/mrr",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns points for the default 30-day window", async () => {
    signedIn();
    prismaMock.projectMember.findUnique.mockResolvedValue({
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
    prismaMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    await app.request(
      "/dashboard/projects/proj_1/metrics/mrr?from=2026-03-01T00:00:00Z&to=2026-03-15T00:00:00Z",
      { headers: authedHeaders },
    );
    const call = drizzleMock.metricsRepo.listDailyMrr.mock.calls[0]![1];
    expect(call.projectId).toBe("proj_1");
    expect(call.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(call.to.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  test("rejects windows larger than the cap", async () => {
    signedIn();
    prismaMock.projectMember.findUnique.mockResolvedValue({
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
    prismaMock.projectMember.findUnique.mockResolvedValue({
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
