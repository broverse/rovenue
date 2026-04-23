import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Dashboard webhook retry/dismiss age guard (Task 6.1 follow-up)
// =============================================================
//
// Migration 0006 adds a compression policy on outgoing_webhooks
// (rows older than 7 days are compressed). Dashboard manual-retry
// and dismiss endpoints must reject such rows because an UPDATE on
// a compressed chunk forces a decompress and permanently bloats
// disk until the next compression pass. The route returns 410 Gone
// when the row's createdAt is beyond the cutoff.

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
    projectMember: { findUnique: vi.fn() },
  };
  const drizzleMock = {
    db: {} as unknown,
    projectRepo: {
      findMembership: vi.fn(
        async (_db: unknown, projectId: string, userId: string) =>
          dbMock.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
            select: { id: true, role: true },
          }),
      ),
    },
    outgoingWebhookRepo: {
      findOutgoingWebhookById: vi.fn(async () => null),
      resetWebhookForRetry: vi.fn(async () => null),
      markWebhookDismissed: vi.fn(async () => null),
      listDeadWebhooks: vi.fn(async () => []),
      countDeadWebhooks: vi.fn(async () => 0),
      countRecentDeadWebhooks: vi.fn(async () => 0),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = {
    auth: {
      api: {
        getSession: vi.fn(),
      },
    },
  };
  return { dbMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: dbMock,
  drizzle: drizzleMock,
  MemberRole: {
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    VIEWER: "VIEWER",
  },
  FeatureFlagType: {
    BOOLEAN: "BOOLEAN",
    STRING: "STRING",
    NUMBER: "NUMBER",
    JSON: "JSON",
  },
  ExperimentStatus: {
    DRAFT: "DRAFT",
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETED",
  },
  Store: {
    APP_STORE: "APP_STORE",
    PLAY_STORE: "PLAY_STORE",
    STRIPE: "STRIPE",
  },
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
  OutgoingWebhookStatus: {
    PENDING: "PENDING",
    SENT: "SENT",
    FAILED: "FAILED",
    DEAD: "DEAD",
    DISMISSED: "DISMISSED",
  },
  RevenueEventType: {
    INITIAL: "INITIAL",
    RENEWAL: "RENEWAL",
    TRIAL_CONVERSION: "TRIAL_CONVERSION",
    CANCELLATION: "CANCELLATION",
    REFUND: "REFUND",
    REACTIVATION: "REACTIVATION",
    CREDIT_PURCHASE: "CREDIT_PURCHASE",
  },
}));

vi.mock("../src/lib/auth", () => authMock);

import { app } from "../src/app";

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test-session" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.api.getSession.mockResolvedValue({
    user: { id: "user_1" },
    session: { id: "sess_1" },
  });
  dbMock.projectMember.findUnique.mockResolvedValue({
    id: "pm_1",
    role: "OWNER",
  });
});

// =============================================================
// POST /dashboard/webhooks/:id/retry
// =============================================================

describe("POST /dashboard/webhooks/:id/retry — compression chunk guard", () => {
  it("returns 410 when the webhook is older than 7 days", async () => {
    const stale = {
      id: "webhook_stale",
      projectId: "proj_1",
      status: "DEAD",
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      stale,
    );

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_stale/retry",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/10 days/);
    expect(
      drizzleMock.outgoingWebhookRepo.resetWebhookForRetry,
    ).not.toHaveBeenCalled();
  });

  it("proceeds normally when the webhook is within the 7-day window", async () => {
    const fresh = {
      id: "webhook_fresh",
      projectId: "proj_1",
      status: "DEAD",
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      fresh,
    );
    drizzleMock.outgoingWebhookRepo.resetWebhookForRetry.mockResolvedValue({
      ...fresh,
      status: "PENDING",
    });

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_fresh/retry",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    expect(
      drizzleMock.outgoingWebhookRepo.resetWebhookForRetry,
    ).toHaveBeenCalledWith(expect.anything(), "webhook_fresh");
  });

  it("returns 400 (not 410) when status isn't DEAD, regardless of age", async () => {
    // Status check runs before the age check — a stale SENT row
    // should return 400 for the status reason, not 410 for age.
    const staleSent = {
      id: "webhook_stale_sent",
      projectId: "proj_1",
      status: "SENT",
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      staleSent,
    );

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_stale_sent/retry",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(400);
    expect(
      drizzleMock.outgoingWebhookRepo.resetWebhookForRetry,
    ).not.toHaveBeenCalled();
  });
});

// =============================================================
// POST /dashboard/webhooks/:id/dismiss
// =============================================================

describe("POST /dashboard/webhooks/:id/dismiss — compression chunk guard", () => {
  it("returns 410 when the webhook is older than 7 days", async () => {
    const stale = {
      id: "webhook_stale",
      projectId: "proj_1",
      status: "DEAD",
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      stale,
    );

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_stale/dismiss",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/10 days/);
    expect(
      drizzleMock.outgoingWebhookRepo.markWebhookDismissed,
    ).not.toHaveBeenCalled();
  });

  it("proceeds normally when the webhook is within the 7-day window", async () => {
    const fresh = {
      id: "webhook_fresh",
      projectId: "proj_1",
      status: "DEAD",
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      fresh,
    );
    drizzleMock.outgoingWebhookRepo.markWebhookDismissed.mockResolvedValue({
      ...fresh,
      status: "DISMISSED",
    });

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_fresh/dismiss",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    expect(
      drizzleMock.outgoingWebhookRepo.markWebhookDismissed,
    ).toHaveBeenCalledWith(expect.anything(), "webhook_fresh");
  });

  it("returns 400 (not 410) when status isn't DEAD, regardless of age", async () => {
    // Status check runs before the age check — a stale FAILED row
    // should return 400 for the status reason, not 410 for age.
    const staleFailed = {
      id: "webhook_stale_failed",
      projectId: "proj_1",
      status: "FAILED",
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    };
    drizzleMock.outgoingWebhookRepo.findOutgoingWebhookById.mockResolvedValue(
      staleFailed,
    );

    const res = await app.request(
      "http://localhost/dashboard/webhooks/webhook_stale_failed/dismiss",
      { method: "POST", headers: authedHeaders() },
    );

    expect(res.status).toBe(400);
    expect(
      drizzleMock.outgoingWebhookRepo.markWebhookDismissed,
    ).not.toHaveBeenCalled();
  });
});
