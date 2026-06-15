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
// Dashboard: LTV prediction endpoint
// =============================================================
//
// The endpoint is a thin wrapper around
// `services/metrics/ltv-prediction.ts`. The unit test exercises:
//   1. dashboard-auth gating (cookie missing → 401)
//   2. project access enforcement (non-member → 403)
//   3. happy-path response shape

const { predMock } = vi.hoisted(() => ({
  predMock: {
    getLtvPrediction: vi.fn(async () => ({
      horizonMonths: 12,
      blendedPredictedLtvUsd: "84.0000",
      maturityCurve: [{ ageMonth: 0, fraction: 0.4 }, { ageMonth: 12, fraction: 1 }],
      cohorts: [{ cohortMonth: "2026-01-01", size: 100, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", maturity: 0.71, isMature: false }],
      byStore: [{ key: "APP_STORE", label: "App Store", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
      byProduct: [{ key: "p1", label: "Pro Monthly", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
      warning: null,
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
vi.mock("../src/services/metrics/ltv-prediction", () => predMock);
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  predMock.getLtvPrediction.mockResolvedValue({
    horizonMonths: 12,
    blendedPredictedLtvUsd: "84.0000",
    maturityCurve: [{ ageMonth: 0, fraction: 0.4 }, { ageMonth: 12, fraction: 1 }],
    cohorts: [{ cohortMonth: "2026-01-01", size: 100, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", maturity: 0.71, isMature: false }],
    byStore: [{ key: "APP_STORE", label: "App Store", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
    byProduct: [{ key: "p1", label: "Pro Monthly", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
    warning: null,
  });
});

const authedHeaders = { cookie: "session=test" };

describe("GET /dashboard/projects/:projectId/metrics/ltv-prediction", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv-prediction",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(401);
  });

  test("403 when not a member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv-prediction",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns prediction", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/ltv-prediction",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toMatchObject({
      horizonMonths: 12,
      blendedPredictedLtvUsd: "84.0000",
    });
    expect((body.data.byStore as Array<{ label: string }>)[0]!.label).toBe("App Store");
    expect((body.data.cohorts as unknown[]).length).toBe(1);
  });
});
