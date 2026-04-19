import { beforeEach, describe, expect, test, vi } from "vitest";

const { prismaMock, authMock } = vi.hoisted(() => {
  const prismaMock = {
    projectMember: { findUnique: vi.fn() },
    subscriber: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    purchase: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    subscriberAccess: { findMany: vi.fn(async () => []) },
    creditLedger: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    experimentAssignment: { findMany: vi.fn(async () => []) },
    outgoingWebhook: { findMany: vi.fn(async () => []) },
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { prismaMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
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

describe("GET /dashboard/projects/:projectId/subscribers", () => {
  test("forbidden when the user is not a project member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers");
    expect(res.status).toBe(403);
  });

  test("returns a page + nextCursor when more rows exist", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });

    // take: limit + 1 = 51 — indicates there's a next page.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `sub_${i}`,
      appUserId: `user_${i}`,
      attributes: {},
      firstSeenAt: new Date("2026-04-10"),
      lastSeenAt: new Date("2026-04-18"),
      createdAt: new Date(`2026-04-${10 + (i % 8)}T12:00:00Z`),
      _count: { purchases: 0 },
      access: [],
    }));
    prismaMock.subscriber.findMany.mockResolvedValue(rows);

    const res = await app.request("/dashboard/projects/proj_1/subscribers?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscribers: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.subscribers).toHaveLength(50);
    expect(body.data.nextCursor).not.toBeNull();
  });

  test("hides soft-deleted subscribers", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findMany.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers");
    const call = prismaMock.subscriber.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ projectId: "proj_1", deletedAt: null });
  });

  test("applies case-insensitive search on appUserId when ?q is set", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findMany.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers?q=alice");
    const call = prismaMock.subscriber.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    const whereJson = JSON.stringify(call.where);
    expect(whereJson).toContain("alice");
    expect(whereJson).toContain("insensitive");
  });
});
