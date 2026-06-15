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
// Dashboard: Revenue summary metrics endpoint
// =============================================================
//
// The endpoint is a thin wrapper around `services/metrics/summary.ts`
// (CH-only). The unit test exercises:
//   1. dashboard-auth gating (cookie missing → 401)
//   2. project access enforcement (non-member → 403)
//   3. default window (payload fields, from/to as strings)
//   4. explicit from/to passthrough to the service

const { summaryMock } = vi.hoisted(() => ({
  summaryMock: {
    getRevenueSummary: vi.fn(async () => ({
      grossUsd: "1000.0000",
      refundsUsd: "100.0000",
      netUsd: "900.0000",
      refundRate: 0.1,
      payingSubscribers: 9,
      arppu: "100.0000",
      avgLtvUsd: "42.5000",
      medianLtvUsd: "30.0000",
      p90LtvUsd: "120.0000",
      ltvSubscribers: 50,
      activeSubscriberBase: 120,
      arpu: "7.5000",
      churnedInWindow: 8,
      churnRate: 0.0625,
      trialStarts: 40,
      trialConversions: 26,
      trialConversionRate: 0.65,
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
vi.mock("../src/services/metrics/summary", () => summaryMock);
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  summaryMock.getRevenueSummary.mockResolvedValue({
    grossUsd: "1000.0000",
    refundsUsd: "100.0000",
    netUsd: "900.0000",
    refundRate: 0.1,
    payingSubscribers: 9,
    arppu: "100.0000",
    avgLtvUsd: "42.5000",
    medianLtvUsd: "30.0000",
    p90LtvUsd: "120.0000",
    ltvSubscribers: 50,
    activeSubscriberBase: 120,
    arpu: "7.5000",
    churnedInWindow: 8,
    churnRate: 0.0625,
    trialStarts: 40,
    trialConversions: 26,
    trialConversionRate: 0.65,
  });
});

const authedHeaders = { cookie: "session=test" };

describe("GET /dashboard/projects/:projectId/metrics/summary", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/summary",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(401);
  });

  test("403 when caller is not a project member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/summary",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(403);
  });

  test("returns the summary payload for the default window", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    const res = await app.request(
      "/dashboard/projects/proj_1/metrics/summary",
      { headers: authedHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toMatchObject({
      grossUsd: "1000.0000",
      netUsd: "900.0000",
      refundRate: 0.1,
      payingSubscribers: 9,
      arppu: "100.0000",
      avgLtvUsd: "42.5000",
      p90LtvUsd: "120.0000",
      arpu: "7.5000",
      churnRate: 0.0625,
      trialConversionRate: 0.65,
      activeSubscriberBase: 120,
    });
    expect(typeof body.data.from).toBe("string");
    expect(typeof body.data.to).toBe("string");
  });

  test("passes explicit from/to to the service", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "VIEWER",
    });
    await app.request(
      "/dashboard/projects/proj_1/metrics/summary?from=2026-03-01T00:00:00Z&to=2026-03-15T00:00:00Z",
      { headers: authedHeaders },
    );
    const call = summaryMock.getRevenueSummary.mock.calls[0]![0];
    expect(call.projectId).toBe("proj_1");
    expect(call.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(call.to.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
});
