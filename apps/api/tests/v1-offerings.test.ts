import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Hoisted mocks
// =============================================================

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const apiKey = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const project = {
    findUnique: vi.fn(),
  };
  const subscriber = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const purchase = {
    findMany: vi.fn(),
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  };
  const product = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };
  const productGroup = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  };
  const offering = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  };
  const subscriberAccess = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const creditLedger = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };

  const $executeRaw = vi.fn().mockResolvedValue(0);

  const $transaction = vi.fn(
    async (
      fn: (
        tx: Record<string, unknown>,
      ) => Promise<unknown>,
    ) =>
      fn({
        subscriber,
        creditLedger,
        subscriberAccess,
        purchase,
        $executeRaw,
      }),
  );

  const mock = {
    apiKey,
    project,
    subscriber,
    purchase,
    product,
    productGroup,
    offering,
    subscriberAccess,
    creditLedger,
    $executeRaw,
    $transaction,
  };

  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };

  // Proxy so any drizzle.schema.<table> reference resolves to {} at module load
  // (prevents "Cannot destructure property X of undefined" on top-level imports)
  const schemaMock = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return prop === Symbol.toPrimitive ? undefined : {};
    },
  });

  const drizzleMock = {
    db: drizzleDb,
    schema: schemaMock,
    notificationRepo: {
      listNotificationsForUser: vi.fn(async () => []),
      unreadNotificationCount: vi.fn(async () => 0),
      markNotificationRead: vi.fn(async () => undefined),
      markAllNotificationsRead: vi.fn(async () => undefined),
    },
    notificationPreferencesRepo: {
      listPreferencesForUser: vi.fn(async () => []),
      upsertPreference: vi.fn(async () => undefined),
      listDefaultsForProject: vi.fn(async () => []),
      upsertDefault: vi.fn(async () => undefined),
    },
    pushDeviceRepo: {
      upsertDevice: vi.fn(async () => undefined),
      deleteDevice: vi.fn(async () => undefined),
      listDevicesForSubscriber: vi.fn(async () => []),
    },
    subscriberRepo: {
      findSubscriberAttributes: vi.fn(async () => null),
      findSubscriberByAppUserId: vi.fn(
        async (_db: unknown, args: { projectId: string; appUserId: string }) =>
          subscriber.findUnique({
            where: {
              projectId_appUserId: {
                projectId: args.projectId,
                appUserId: args.appUserId,
              },
            },
          }),
      ),
      findSubscriberProjectId: vi.fn(async (_db: unknown, id: string) =>
        subscriber.findUnique({
          where: { id },
          select: { projectId: true },
        }),
      ),
      upsertSubscriber: vi.fn(
        async (
          _db: unknown,
          input: {
            projectId: string;
            appUserId: string;
            createAttributes?: unknown;
            updateAttributes?: unknown;
          },
        ) =>
          subscriber.upsert({
            where: {
              projectId_appUserId: {
                projectId: input.projectId,
                appUserId: input.appUserId,
              },
            },
            create: {
              projectId: input.projectId,
              appUserId: input.appUserId,
              attributes: input.createAttributes ?? {},
            },
            update: {
              lastSeenAt: new Date(),
              ...(input.updateAttributes !== undefined && {
                attributes: input.updateAttributes,
              }),
            },
          }),
      ),
      listSubscribers: vi.fn(async () => []),
      countActiveSubscribers: vi.fn(async () => 0),
    },
    lockRepo: {
      advisoryXactLock: vi.fn(async () => undefined),
      advisoryXactLock2: vi.fn(async () => undefined),
    },
    accessRepo: {
      findActiveAccess: vi.fn(async (_db: unknown, subscriberId: string) =>
        subscriberAccess.findMany({
          where: {
            subscriberId,
            isActive: true,
          },
        }),
      ),
    },
    creditLedgerRepo: {
      findLatestBalance: vi.fn(async (_db: unknown, subscriberId: string) =>
        creditLedger.findFirst({
          where: { subscriberId },
          orderBy: { createdAt: "desc" },
          select: { balance: true },
        }),
      ),
      findExistingPurchaseCredit: vi.fn(
        async (_db: unknown, subscriberId: string, purchaseId: string) =>
          creditLedger.findFirst({
            where: {
              subscriberId,
              referenceType: "purchase",
              referenceId: purchaseId,
            },
          }),
      ),
      insertCreditLedger: vi.fn(
        async (_tx: unknown, entry: Record<string, unknown>) =>
          creditLedger.create({ data: entry }),
      ),
    },
    offeringRepo: {
      // New repo methods used by the updated list route
      listOfferings: vi.fn(async (_db: unknown, _projectId: string) =>
        offering.findMany({}),
      ),
      listOfferingsByAccess: vi.fn(
        async (_db: unknown, _projectId: string, _accessId: string) =>
          offering.findMany({}),
      ),
      findProductsByIds: vi.fn(
        async (_db: unknown, _projectId: string, ids: string[]) =>
          ids.length === 0
            ? []
            : product.findMany({ where: { id: { in: ids } } }),
      ),
      // Legacy methods (product-groups route + per-identifier route)
      listProductGroups: vi.fn(async (_db: unknown, projectId: string) =>
        offering.findMany({
          where: { projectId },
          orderBy: [{ isDefault: "desc" }, { identifier: "asc" }],
        }),
      ),
      findDefaultProductGroup: vi.fn(async (_db: unknown, projectId: string) =>
        offering.findFirst({
          where: { projectId, isDefault: true },
        }),
      ),
      findProductGroupByIdentifier: vi.fn(
        async (_db: unknown, projectId: string, identifier: string) =>
          offering.findUnique({
            where: { projectId_identifier: { projectId, identifier } },
          }),
      ),
      findDefaultOffering: vi.fn(async (_db: unknown, projectId: string) =>
        offering.findFirst({
          where: { projectId, isDefault: true },
        }),
      ),
      findOfferingByIdentifier: vi.fn(
        async (_db: unknown, projectId: string, identifier: string) =>
          offering.findUnique({
            where: { projectId_identifier: { projectId, identifier } },
          }),
      ),
    },
    purchaseRepo: {
      findPurchasesByIds: vi.fn(async (_db: unknown, ids: string[]) =>
        ids.length === 0
          ? []
          : purchase.findMany({
              where: { id: { in: ids } },
              include: { product: { select: { identifier: true } } },
            }),
      ),
    },
    creditLedgerRepoExt: {
      findExistingPurchaseCredit: vi.fn(async () => null),
    },
    experimentRepo: {
      findRunningExperimentsByProject: vi.fn(async () => []),
      findExperimentsByProject: vi.fn(async () => []),
    },
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => []),
      findAudiencesByProject: vi.fn(async () => []),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async (_db: unknown, keyPublic: string) =>
        apiKey.findUnique({
          where: { keyPublic },
          include: { project: true },
        }),
      ),
      findApiKeyById: vi.fn(async (_db: unknown, id: string) =>
        apiKey.findUnique({
          where: { id },
          include: { project: true },
        }),
      ),
      updateApiKeyLastUsed: vi.fn(async () => undefined),
    },
    projectRepo: {
      findMembership: vi.fn(async () => null),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };

  return { dbMock: mock, drizzleMock };
});

vi.mock("@rovenue/db", () => ({
  default: dbMock,
  drizzle: drizzleMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
  Store: {
    APP_STORE: "APP_STORE",
    PLAY_STORE: "PLAY_STORE",
    STRIPE: "STRIPE",
  },
  Environment: {
    PRODUCTION: "PRODUCTION",
    SANDBOX: "SANDBOX",
  },
  PurchaseStatus: {
    TRIAL: "TRIAL",
    ACTIVE: "ACTIVE",
    EXPIRED: "EXPIRED",
    PAUSED: "PAUSED",
    REFUNDED: "REFUNDED",
    GRACE_PERIOD: "GRACE_PERIOD",
  },
  LedgerEventType: {
    CREDIT_PURCHASE: "CREDIT_PURCHASE",
    CONSUMPTION: "CONSUMPTION",
    REFUND: "REFUND",
    REACTIVATION: "REACTIVATION",
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
  FeatureFlagEnv: { PROD: "PROD", STAGING: "STAGING", DEVELOPMENT: "DEVELOPMENT" },
  // Zod schema stub — just pass anything through
  accessIdSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }), optional: () => ({ parse: (v: unknown) => v }) },
  currentYearMonth: () => "2026-06",
  getDb: () => ({}),
  db: {},
  decryptCredential: (v: unknown) => v,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue("hashed"),
  },
}));

vi.mock("../src/services/receipt-verify", () => ({
  verifyReceipt: vi.fn(),
}));

vi.mock("../src/services/access-engine", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/access-engine")
  >("../src/services/access-engine");
  return {
    ...actual,
    syncAccess: vi.fn().mockResolvedValue(undefined),
  };
});

// =============================================================
// Now import the app (after mocks are set)
// =============================================================

import { app } from "../src/app";
import * as drizzle from "../src/routes/v1/offerings";

const PUBLIC_KEY = "rov_pub_test_project_key";

const apiKeyRecord = {
  id: "testapikeyid",
  projectId: "proj_test",
  label: "test",
  keyPublic: PUBLIC_KEY,
  keySecretHash: "hashed",
  environment: "PRODUCTION",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: {
    id: "proj_test",
    name: "Test",
    slug: "test",
  },
};

function withPublicAuth(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PUBLIC_KEY}`);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

// =============================================================
// GET /v1/offerings
// =============================================================

describe("GET /v1/offerings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.apiKey.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.keyPublic === PUBLIC_KEY) return apiKeyRecord;
      if (args?.where?.id === "testapikeyid") return apiKeyRecord;
      return null;
    });
  });

  it("hydrates each offering's products including storeIds", async () => {
    vi.mocked(drizzleMock.offeringRepo.listOfferings).mockResolvedValue([
      {
        id: "off_1",
        identifier: "default",
        accessId: "acc_x",
        isDefault: true,
        products: [{ productId: "prod_1", order: 0, isPromoted: false }],
        metadata: {},
      },
    ] as any);
    vi.mocked(drizzleMock.offeringRepo.findProductsByIds).mockResolvedValue([
      {
        id: "prod_1",
        identifier: "monthly",
        type: "SUBSCRIPTION",
        displayName: "Pro Monthly",
        creditAmount: null,
        accessIds: ["pro"],
        isActive: true,
        storeIds: { apple: "com.x.pro.monthly", google: "pro_monthly" },
      },
    ] as any);

    const res = await app.request(withPublicAuth("/v1/offerings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const product = body.data.offerings[0].products[0];
    expect(product.storeIds).toEqual({ apple: "com.x.pro.monthly", google: "pro_monthly" });
    expect(product.identifier).toBe("monthly");
    expect(product.type).toBe("SUBSCRIPTION");
  });

  it("returns empty products array when offering has no product memberships", async () => {
    vi.mocked(drizzleMock.offeringRepo.listOfferings).mockResolvedValue([
      {
        id: "off_2",
        identifier: "empty",
        accessId: null,
        isDefault: false,
        products: [],
        metadata: {},
      },
    ] as any);
    vi.mocked(drizzleMock.offeringRepo.findProductsByIds).mockResolvedValue([] as any);

    const res = await app.request(withPublicAuth("/v1/offerings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.offerings[0].products).toEqual([]);
  });

  it("filters out inactive products", async () => {
    vi.mocked(drizzleMock.offeringRepo.listOfferings).mockResolvedValue([
      {
        id: "off_3",
        identifier: "mixed",
        accessId: null,
        isDefault: true,
        products: [
          { productId: "prod_active", order: 0, isPromoted: false },
          { productId: "prod_inactive", order: 1, isPromoted: false },
        ],
        metadata: {},
      },
    ] as any);
    vi.mocked(drizzleMock.offeringRepo.findProductsByIds).mockResolvedValue([
      {
        id: "prod_active",
        identifier: "active_monthly",
        type: "SUBSCRIPTION",
        displayName: "Active",
        creditAmount: null,
        accessIds: ["pro"],
        isActive: true,
        storeIds: { apple: "com.x.active" },
      },
      {
        id: "prod_inactive",
        identifier: "inactive_monthly",
        type: "SUBSCRIPTION",
        displayName: "Inactive",
        creditAmount: null,
        accessIds: ["pro"],
        isActive: false,
        storeIds: { apple: "com.x.inactive" },
      },
    ] as any);

    const res = await app.request(withPublicAuth("/v1/offerings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.offerings[0].products).toHaveLength(1);
    expect(body.data.offerings[0].products[0].identifier).toBe("active_monthly");
  });
});
