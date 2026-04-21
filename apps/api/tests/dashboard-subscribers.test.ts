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

const { prismaMock, drizzleMock, authMock } = vi.hoisted(() => {
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
  // Shadow reader: yields the primary caller, ignores the shadow.
  const drizzleMock = {
    db: {} as unknown,
    subscriberRepo: {
      findSubscriberAttributes: vi.fn(async () => null),
      findSubscriberByAppUserId: vi.fn(async () => null),
      findSubscriberById: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.subscriber.findUnique({ where: { id } }),
      ),
      listSubscribers: vi.fn(async () => []),
      countActiveSubscribers: vi.fn(async () => 0),
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
    subscriberDetailRepo: {
      loadSubscriberDetail: vi.fn(async (_db: unknown, subscriberId: string) => {
        const [purchasesRaw, access, ledger, assignmentsRaw, outgoingWebhooks] =
          await Promise.all([
            prismaMock.purchase.findMany({
              where: { subscriberId },
              orderBy: { purchaseDate: "desc" },
              take: 50,
              include: { product: { select: { identifier: true } } },
            }),
            prismaMock.subscriberAccess.findMany({
              where: { subscriberId },
              orderBy: { entitlementKey: "asc" },
            }),
            prismaMock.creditLedger.findMany({
              where: { subscriberId },
              orderBy: { createdAt: "desc" },
              take: 20,
            }),
            prismaMock.experimentAssignment.findMany({
              where: { subscriberId },
              orderBy: { assignedAt: "desc" },
              include: { experiment: { select: { key: true } } },
            }),
            prismaMock.outgoingWebhook.findMany({
              where: { subscriberId },
              orderBy: { createdAt: "desc" },
              take: 20,
            }),
          ]);
        const purchases = (Array.isArray(purchasesRaw) ? purchasesRaw : []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => ({ ...p, productIdentifier: p.product?.identifier }),
        );
        const assignments = (
          Array.isArray(assignmentsRaw) ? assignmentsRaw : []
        ).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (a: any) => ({ ...a, experimentKey: a.experiment?.key }),
        );
        const latestBalance = (Array.isArray(ledger) ? ledger : [])[0]?.balance ?? 0;
        return {
          access: Array.isArray(access) ? access : [],
          purchases,
          latestBalance,
          ledger: Array.isArray(ledger) ? ledger : [],
          assignments,
          outgoingWebhooks: Array.isArray(outgoingWebhooks)
            ? outgoingWebhooks
            : [],
        };
      }),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { prismaMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
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

    // take: limit + 1 = 51 rows to prove the "has more" probe.
    // The Drizzle list repo returns `purchaseCount` and
    // `activeEntitlementKeys` flattened — no _count / access
    // nesting needed post-cutover.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `sub_${i}`,
      appUserId: `user_${i}`,
      attributes: {},
      firstSeenAt: new Date("2026-04-10"),
      lastSeenAt: new Date("2026-04-18"),
      createdAt: new Date(`2026-04-${10 + (i % 8)}T12:00:00Z`),
      purchaseCount: 0,
      activeEntitlementKeys: [],
    }));
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue(rows);

    const res = await app.request("/dashboard/projects/proj_1/subscribers?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscribers: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.subscribers).toHaveLength(50);
    expect(body.data.nextCursor).not.toBeNull();
  });

  test("passes projectId to the list repository (soft-delete filter is internal)", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers");
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      projectId: string;
    };
    expect(call.projectId).toBe("proj_1");
  });

  test("forwards ?q to the list repository for case-insensitive search", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers?q=alice");
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      q?: string;
    };
    expect(call.q).toBe("alice");
  });
});

describe("GET /dashboard/projects/:projectId/subscribers/:id", () => {
  test("forbidden when not a member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(403);
  });

  test("returns 404 when subscriber isn't in project", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_missing");
    expect(res.status).toBe(404);
  });

  test("assembles subscriber + purchases + access + ledger + assignments + webhooks", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_1",
      appUserId: "user_abc",
      attributes: { country: "TR" },
      firstSeenAt: new Date("2026-04-01"),
      lastSeenAt: new Date("2026-04-18"),
      deletedAt: null,
      mergedInto: null,
    });
    prismaMock.purchase.findMany.mockResolvedValue([
      {
        id: "pur_1",
        productId: "prod_1",
        product: { identifier: "pro_monthly" },
        store: "APP_STORE",
        status: "ACTIVE",
        priceAmount: "9.99",
        priceCurrency: "USD",
        purchaseDate: new Date("2026-04-10"),
        expiresDate: new Date("2026-05-10"),
        autoRenewStatus: true,
      },
    ]);
    prismaMock.subscriberAccess.findMany.mockResolvedValue([
      { entitlementKey: "premium", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
    ]);
    // Phase 6 cutover: loadSubscriberDetail reads the latest
    // balance from the most-recent ledger row rather than a
    // separate findFirst. The first row's balance becomes
    // `creditBalance` in the response.
    prismaMock.creditLedger.findMany.mockResolvedValue([
      {
        id: "led_1",
        type: "PURCHASE",
        amount: "100",
        balance: "42",
        referenceType: "purchase",
        description: null,
        createdAt: new Date("2026-04-12"),
      },
    ]);
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      {
        experimentId: "exp_1",
        variantId: "v_a",
        assignedAt: new Date("2026-04-12"),
        convertedAt: null,
        revenue: null,
        experiment: { key: "paywall_test" },
      },
    ]);
    prismaMock.outgoingWebhook.findMany.mockResolvedValue([
      {
        id: "ow_1",
        eventType: "purchase",
        url: "https://example.com/hook",
        status: "SENT",
        attempts: 1,
        createdAt: new Date("2026-04-12"),
        sentAt: new Date("2026-04-12"),
        lastErrorMessage: null,
      },
    ]);

    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subscriber: Record<string, unknown> } };
    const s = body.data.subscriber as Record<string, unknown>;
    expect(s.appUserId).toBe("user_abc");
    expect(Array.isArray(s.purchases)).toBe(true);
    expect(Array.isArray(s.access)).toBe(true);
    expect(s.creditBalance).toBe("42");
    expect(Array.isArray(s.assignments)).toBe(true);
    expect(Array.isArray(s.outgoingWebhooks)).toBe(true);
  });
});
