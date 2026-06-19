import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /dashboard/webhooks/deliveries — recent deliveries list.
// Mocked drizzle (no DB), mirroring dashboard-webhook-retry-guard.
// =============================================================

const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => obj ?? null),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "", rowCount: 0, firstVerifiedAt: null, lastVerifiedAt: null, errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

const { dbMock, drizzleMock, authMock } = vi.hoisted(() => {
  const dbMock = { projectMember: { findUnique: vi.fn() } };
  const drizzleMock = {
    db: {} as unknown,
    schema: {
      notifications: {},
      notificationPreferences: {},
    },
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
    },
    notificationRepo: {
      listNotifications: vi.fn(async () => []),
      countUnread: vi.fn(async () => 0),
      markRead: vi.fn(async () => null),
      markAllRead: vi.fn(async () => 0),
      getPreferences: vi.fn(async () => null),
      upsertPreferences: vi.fn(async () => null),
    },
    outgoingWebhookRepo: {
      listRecentOutgoingWebhooks: vi.fn(async () => []),
      countOutgoingWebhooks: vi.fn(async () => 0),
      findOutgoingWebhookById: vi.fn(async () => null),
      resetWebhookForRetry: vi.fn(async () => null),
      markWebhookDismissed: vi.fn(async () => null),
      listDeadWebhooks: vi.fn(async () => []),
      countDeadWebhooks: vi.fn(async () => 0),
      countRecentDeadWebhooks: vi.fn(async () => 0),
    },
    shadowRead: vi.fn(async <T>(primary: () => Promise<T>): Promise<T> => primary()),
  };
  const authMock = { auth: { api: { getSession: vi.fn() } } };
  return { dbMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    default: dbMock,
    drizzle: drizzleMock,
  };
});

vi.mock("../src/lib/auth", () => authMock);

import { app } from "../src/app";

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test-session" };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.api.getSession.mockResolvedValue({
    user: { id: "user_1" }, session: { id: "sess_1" },
  });
  dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
});

describe("GET /dashboard/webhooks/deliveries", () => {
  it("returns 400 when projectId is missing", async () => {
    const res = await app.request("http://localhost/dashboard/webhooks/deliveries", {
      headers: authedHeaders(),
    });
    expect(res.status).toBe(400);
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).not.toHaveBeenCalled();
  });

  it("maps rows to ISO-stringed wire shape and computes pagination", async () => {
    const created = new Date("2026-06-19T10:00:00.000Z");
    drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks.mockResolvedValue([
      {
        id: "ogw_1", projectId: "proj_1", eventType: "purchase.created",
        url: "https://x.test/hook", status: "SENT", httpStatus: 200, attempts: 1,
        createdAt: created, sentAt: created, lastErrorMessage: null,
      },
    ]);
    drizzleMock.outgoingWebhookRepo.countOutgoingWebhooks.mockResolvedValue(42);

    const res = await app.request(
      "http://localhost/dashboard/webhooks/deliveries?projectId=proj_1&limit=20&offset=0",
      { headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { webhooks: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    };
    expect(body.data.webhooks[0]).toEqual({
      id: "ogw_1", eventType: "purchase.created", url: "https://x.test/hook",
      status: "SENT", httpStatus: 200, attempts: 1,
      createdAt: "2026-06-19T10:00:00.000Z", sentAt: "2026-06-19T10:00:00.000Z",
      lastErrorMessage: null,
    });
    expect(body.data.pagination).toEqual({ total: 42, limit: 20, offset: 0, hasMore: true });
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).toHaveBeenCalledWith(
      expect.anything(), { projectId: "proj_1", limit: 20, offset: 0 },
    );
  });

  it("caps limit at 100 and defaults to 20", async () => {
    await app.request(
      "http://localhost/dashboard/webhooks/deliveries?projectId=proj_1&limit=9999",
      { headers: authedHeaders() },
    );
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).toHaveBeenCalledWith(
      expect.anything(), { projectId: "proj_1", limit: 100, offset: 0 },
    );
  });
});
