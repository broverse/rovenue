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

  const offering = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
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
      findSubscriberAttributesByRovenueId: vi.fn(
        async (_db: unknown, args: { projectId: string; rovenueId: string }) =>
          subscriber.findUnique({
            where: { id: args.rovenueId, projectId: args.projectId },
            select: { attributes: true },
          }),
      ),
      resolveSubscriberByRovenueId: vi.fn(
        async (_db: unknown, args: { projectId: string; rovenueId: string }) =>
          subscriber.findUnique({
            where: { id: args.rovenueId, projectId: args.projectId },
          }),
      ),
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
            rovenueId?: string;
            appUserId?: string;
            createAttributes?: unknown;
            updateAttributes?: unknown;
          },
        ) =>
          subscriber.upsert({
            where: {
              projectId_rovenueId: {
                projectId: input.projectId,
                rovenueId: input.rovenueId ?? input.appUserId ?? "",
              },
            },
            create: {
              projectId: input.projectId,
              rovenueId: input.rovenueId ?? input.appUserId ?? "",
              appUserId: input.appUserId ?? null,
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
      listOfferings: vi.fn(async (_db: unknown, projectId: string) =>
        offering.findMany({
          where: { projectId },
          orderBy: [{ isDefault: "desc" }, { identifier: "asc" }],
        }),
      ),
      listOfferingsByAccess: vi.fn(
        async (_db: unknown, projectId: string, accessId: string) =>
          offering.findMany({
            where: { projectId, accessId },
            orderBy: [{ isDefault: "desc" }, { identifier: "asc" }],
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
      findProductsByIds: vi.fn(async (_db: unknown, projectId: string, ids: string[]) =>
        ids.length === 0
          ? []
          : product.findMany({ where: { projectId, id: { in: ids } } }),
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
    accessCatalogRepo: {
      findByIds: vi.fn(async (_db: unknown, ids: string[]) =>
        ids.map((id) => ({ id, identifier: id })),
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
  WebhookSource: {
    APPLE: "APPLE",
    GOOGLE: "GOOGLE",
    STRIPE: "STRIPE",
  },
  OutgoingWebhookStatus: {
    PENDING: "PENDING",
    SENT: "SENT",
    FAILED: "FAILED",
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

// Stub bcrypt so secret key compare is deterministic in tests
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue("hashed"),
  },
}));

// Stub the receipt verification service so the /v1/receipts test
// doesn't have to mount real Apple/Google SDKs.
vi.mock("../src/services/receipt-verify", () => ({
  verifyReceipt: vi.fn(),
}));

// Stub access-engine.syncAccess so tests aren't exercising the
// full reconciliation code path against mocked DB spies.
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
import { verifyReceipt } from "../src/services/receipt-verify";

const PUBLIC_KEY = "rov_pub_test_project_key";
const SECRET_KEY = "rov_sec_testapikeyid_random";

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

function withPublicAuth(
  url: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PUBLIC_KEY}`);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

function withSecretAuth(
  url: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SECRET_KEY}`);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Auth: resolve public key lookup
  dbMock.apiKey.findUnique.mockImplementation(async (args: any) => {
    if (args?.where?.keyPublic === PUBLIC_KEY) return apiKeyRecord;
    if (args?.where?.id === "testapikeyid") return apiKeyRecord;
    return null;
  });
  dbMock.apiKey.update.mockResolvedValue(apiKeyRecord);
});

// =============================================================
// POST /v1/receipts/apple + /google
// =============================================================

describe("POST /v1/receipts/apple", () => {
  it("verifies receipt, syncs access, and returns subscriber + access + credits", async () => {
    const subscriberRow = {
      id: "sub_1",
      appUserId: "user_1",
      attributes: {},
    };
    const productRow = {
      id: "prod_1",
      identifier: "pro_monthly",
      type: "SUBSCRIPTION",
      displayName: "Pro Monthly",
      creditAmount: null,
      accessIds: ["premium"],
      isActive: true,
    };
    const purchaseRow = {
      id: "pur_1",
      productId: "prod_1",
      product: { identifier: "pro_monthly" },
    };

    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: subscriberRow as any,
      product: productRow as any,
      purchase: purchaseRow as any,
    });

    dbMock.subscriberAccess.findMany.mockResolvedValue([
      {
        accessId: "premium",
        isActive: true,
        expiresDate: new Date("2026-05-01T00:00:00Z"),
        store: "APP_STORE",
        purchaseId: "pur_1",
      },
    ]);
    dbMock.purchase.findMany.mockResolvedValue([purchaseRow]);
    dbMock.creditLedger.findFirst.mockResolvedValue(null);

    const res = await app.request(
      withPublicAuth("/v1/receipts/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receipt: "jws_fake",
          appUserId: "user_1",
          productId: "pro_monthly",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.subscriber.appUserId).toBe("user_1");
    expect(body.data.access.premium).toBeDefined();
    expect(body.data.access.premium.productIdentifier).toBe("pro_monthly");
    expect(body.data.credits.balance).toBe(0);
    expect(verifyReceipt).toHaveBeenCalledOnce();
    expect(vi.mocked(verifyReceipt).mock.calls[0][0].store).toBe("APP_STORE");
  });

  it("rejects invalid body", async () => {
    const res = await app.request(
      withPublicAuth("/v1/receipts/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appUserId: "user_1" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/receipts/google", () => {
  it("dispatches the verifier with PLAY_STORE", async () => {
    const subscriberRow = {
      id: "sub_1",
      appUserId: "user_1",
      attributes: {},
    };
    const productRow = {
      id: "prod_1",
      identifier: "pro_monthly",
      type: "SUBSCRIPTION",
      displayName: "Pro Monthly",
      creditAmount: null,
      accessIds: ["premium"],
      isActive: true,
    };
    const purchaseRow = {
      id: "pur_1",
      productId: "prod_1",
      product: { identifier: "pro_monthly" },
    };

    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: subscriberRow as any,
      product: productRow as any,
      purchase: purchaseRow as any,
    });

    dbMock.subscriberAccess.findMany.mockResolvedValue([]);
    dbMock.purchase.findMany.mockResolvedValue([purchaseRow]);
    dbMock.creditLedger.findFirst.mockResolvedValue(null);

    const res = await app.request(
      withPublicAuth("/v1/receipts/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receipt: "play_token_fake",
          appUserId: "user_1",
          productId: "pro_monthly",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(verifyReceipt).toHaveBeenCalledOnce();
    expect(vi.mocked(verifyReceipt).mock.calls[0][0].store).toBe("PLAY_STORE");
  });
});

// =============================================================
// GET /v1/subscribers/:appUserId/access
// =============================================================

describe("GET /v1/subscribers/:appUserId/access", () => {
  it("returns the active entitlement map", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);

    dbMock.subscriberAccess.findMany.mockResolvedValue([
      {
        accessId: "premium",
        isActive: true,
        expiresDate: null,
        store: "APP_STORE",
        purchaseId: "pur_1",
      },
    ]);
    dbMock.purchase.findMany.mockResolvedValue([
      { id: "pur_1", product: { identifier: "pro_monthly" } },
    ]);

    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/access"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.access.premium.productIdentifier).toBe("pro_monthly");
    expect(body.data.access.premium.store).toBe("APP_STORE");
  });

  it("returns 404 for unknown subscriber", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue(null);
    const res = await app.request(
      withPublicAuth("/v1/subscribers/ghost/access"),
    );
    expect(res.status).toBe(404);
  });
});

// =============================================================
// POST /v1/subscribers/:appUserId/restore
// =============================================================

describe("POST /v1/subscribers/:appUserId/restore", () => {
  it("runs through supplied receipts and returns access", async () => {
    const subscriberRow = {
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    };
    dbMock.subscriber.findUnique.mockResolvedValue(subscriberRow as any);

    vi.mocked(verifyReceipt).mockResolvedValue({
      subscriber: subscriberRow as any,
      product: { id: "prod_1" } as any,
      purchase: { id: "pur_1" } as any,
    });

    dbMock.subscriberAccess.findMany.mockResolvedValue([]);

    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receipts: [
            {
              store: "APP_STORE",
              receipt: "jws_fake",
              productId: "pro_monthly",
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.restored).toHaveLength(1);
    expect(body.data.restored[0].productId).toBe("pro_monthly");
  });
});

// =============================================================
// POST /v1/subscribers/:appUserId/attributes
// =============================================================

describe("POST /v1/subscribers/:appUserId/attributes", () => {
  it("merges new attributes with existing ones", async () => {
    // findSubscriberByAppUserId delegates to dbMock.subscriber.
    // findUnique (see the drizzleMock above), so we mock the stored
    // attributes on that spy. upsertSubscriber delegates to
    // dbMock.subscriber.upsert for the return value.
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: { locale: "en" },
    } as any);
    dbMock.subscriber.upsert.mockResolvedValue({
      id: "sub_1",
      appUserId: "user_1",
      attributes: { locale: "tr", timezone: "Europe/Istanbul" },
    } as any);

    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/attributes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attributes: { locale: "tr", timezone: "Europe/Istanbul" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.subscriber.attributes.locale).toBe("tr");
    // New flow collapses upsert-then-update into a single upsert.
    expect(dbMock.subscriber.upsert).toHaveBeenCalled();
  });
});

// =============================================================
// GET /v1/subscribers/:appUserId/credits
// =============================================================

describe("GET /v1/subscribers/:appUserId/credits", () => {
  it("returns current ledger balance", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({
      balance: 290,
    } as any);

    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/credits"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.balance).toBe(290);
  });
});

// =============================================================
// POST /v1/subscribers/:appUserId/credits/spend
// =============================================================

describe("POST /v1/subscribers/:appUserId/credits/spend", () => {
  it("records a spend and returns the new balance", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);
    // credit-engine.spendCredits → tx.subscriber.findUnique + tx.creditLedger.findFirst/create
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({
      balance: 290,
    } as any);
    dbMock.creditLedger.create.mockResolvedValue({
      id: "led_1",
      amount: -10,
      balance: 280,
      type: "SPEND",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    } as any);

    const res = await app.request(
      withSecretAuth("/v1/subscribers/user_1/credits/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: 10,
          description: "Photo generation",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.balance).toBe(280);
    expect(body.data.ledgerEntry.amount).toBe(-10);
  });

  it("returns 402 when balance is insufficient", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({
      balance: 5,
    } as any);

    const res = await app.request(
      withSecretAuth("/v1/subscribers/user_1/credits/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 10 }),
      }),
    );

    expect(res.status).toBe(402);
  });

  it("rejects a public key with 403", async () => {
    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/credits/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 10 }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

// =============================================================
// POST /v1/subscribers/:appUserId/credits/add  (secret key only)
// =============================================================

describe("POST /v1/subscribers/:appUserId/credits/add", () => {
  it("accepts a secret key and records the grant", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue(null);
    dbMock.creditLedger.create.mockResolvedValue({
      id: "led_2",
      amount: 50,
      balance: 330,
      type: "BONUS",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    } as any);

    const res = await app.request(
      withSecretAuth("/v1/subscribers/user_1/credits/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: 50,
          type: "BONUS",
          description: "Welcome bonus",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.balance).toBe(330);
    expect(body.data.ledgerEntry.amount).toBe(50);
  });

  it("rejects a public key with 403", async () => {
    const res = await app.request(
      withPublicAuth("/v1/subscribers/user_1/credits/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 50 }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

// =============================================================
// GET /v1/offerings/:identifier
// =============================================================

describe("GET /v1/offerings/:identifier", () => {
  it("returns a sorted product list for the named offering", async () => {
    dbMock.offering.findUnique.mockResolvedValue({
      id: "pg_1",
      projectId: "proj_test",
      identifier: "premium",
      isDefault: false,
      accessId: null,
      products: [
        {
          productId: "prod_1",
          order: 2,
          isPromoted: false,
          metadata: {},
        },
        {
          productId: "prod_2",
          order: 1,
          isPromoted: true,
          metadata: {},
        },
      ],
      metadata: { title: "Choose your plan" },
    } as any);
    dbMock.product.findMany.mockResolvedValue([
      {
        id: "prod_1",
        identifier: "pro_monthly",
        type: "SUBSCRIPTION",
        displayName: "Pro Monthly",
        creditAmount: null,
        accessIds: ["premium"],
        isActive: true,
      },
      {
        id: "prod_2",
        identifier: "credits_100",
        type: "CONSUMABLE",
        displayName: "100 Credits",
        creditAmount: 100,
        accessIds: [],
        isActive: true,
      },
    ]);

    const res = await app.request(
      withPublicAuth("/v1/offerings/premium"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.identifier).toBe("premium");
    expect(body.data.products).toHaveLength(2);
    expect(body.data.products[0].identifier).toBe("credits_100");
    expect(body.data.products[0].isPromoted).toBe(true);
    expect(body.data.products[1].identifier).toBe("pro_monthly");
  });

  it("looks up the default offering when identifier is 'default'", async () => {
    dbMock.offering.findFirst.mockResolvedValue({
      id: "pg_1",
      projectId: "proj_test",
      identifier: "default",
      isDefault: true,
      accessId: null,
      products: [],
      metadata: {},
    } as any);
    dbMock.product.findMany.mockResolvedValue([]);

    const res = await app.request(
      withPublicAuth("/v1/offerings/default"),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when the offering doesn't exist", async () => {
    dbMock.offering.findUnique.mockResolvedValue(null);
    const res = await app.request(
      withPublicAuth("/v1/offerings/missing"),
    );
    expect(res.status).toBe(404);
  });
});

// =============================================================
// GET /v1/offerings
// =============================================================

describe("GET /v1/offerings", () => {
  it("lists offerings with their products", async () => {
    dbMock.offering.findMany.mockResolvedValue([
      {
        identifier: "default",
        isDefault: true,
        accessId: null,
        products: [{ productId: "p1", order: 1, isPromoted: false }],
      },
      {
        identifier: "experiment_summer",
        isDefault: false,
        accessId: null,
        products: [
          { productId: "p1", order: 1, isPromoted: true },
          { productId: "p2", order: 2, isPromoted: false },
        ],
      },
    ] as any);
    dbMock.product.findMany.mockResolvedValue([]);

    const res = await app.request(withPublicAuth("/v1/offerings"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.offerings).toHaveLength(2);
    expect(body.data.offerings[0].identifier).toBe("default");
    expect(body.data.offerings[0].products).toHaveLength(0);
    expect(body.data.offerings[1].products).toHaveLength(0);
  });
});

// =============================================================
// /v1/me — subscriber-scoped SDK routes
// =============================================================

function withAppUser(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PUBLIC_KEY}`);
  headers.set("x-rovenue-app-user-id", "user_1");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

describe("GET /v1/me", () => {
  it("returns subscriber profile + entitlements + credit balance", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: { plan: "pro" },
    } as any);
    dbMock.subscriberAccess.findMany.mockResolvedValue([
      {
        accessId: "premium",
        isActive: true,
        expiresDate: new Date("2026-05-01T00:00:00Z"),
        store: "APP_STORE",
        purchaseId: "pur_1",
      },
    ]);
    dbMock.purchase.findMany.mockResolvedValue([
      { id: "pur_1", product: { identifier: "pro_monthly" } },
    ]);
    dbMock.creditLedger.findFirst.mockResolvedValue({ balance: 175 } as any);

    const res = await app.request(withAppUser("/v1/me"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.subscriber.appUserId).toBe("user_1");
    expect(body.data.subscriber.attributes.plan).toBe("pro");
    expect(body.data.access.premium.isActive).toBe(true);
    expect(body.data.access.premium.productIdentifier).toBe("pro_monthly");
    expect(body.data.credits.balance).toBe(175);
  });

  it("rejects when X-Rovenue-App-User-Id header is missing", async () => {
    const res = await app.request(withPublicAuth("/v1/me"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the subscriber does not exist", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue(null);
    const res = await app.request(withAppUser("/v1/me"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/me/access", () => {
  it("returns only the access map", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: {},
    } as any);
    dbMock.subscriberAccess.findMany.mockResolvedValue([
      {
        accessId: "premium",
        isActive: true,
        expiresDate: null,
        store: "PLAY_STORE",
        purchaseId: "pur_2",
      },
    ]);
    dbMock.purchase.findMany.mockResolvedValue([
      { id: "pur_2", product: { identifier: "pro_annual" } },
    ]);

    const res = await app.request(withAppUser("/v1/me/access"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.access.premium.store).toBe("PLAY_STORE");
  });
});

describe("GET /v1/me/credits", () => {
  it("returns the balance", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: {},
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({ balance: 42 } as any);

    const res = await app.request(withAppUser("/v1/me/credits"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.balance).toBe(42);
  });
});

describe("POST /v1/me/credits/spend", () => {
  it("accepts a public key + idempotency key and records spend", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: {},
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({ balance: 100 } as any);
    dbMock.creditLedger.create.mockResolvedValue({
      id: "led_1",
      amount: -25,
      balance: 75,
      type: "SPEND",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    } as any);

    const res = await app.request(
      withAppUser("/v1/me/credits/spend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "spend-001",
        },
        body: JSON.stringify({ amount: 25, description: "image gen" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.balance).toBe(75);
    expect(body.data.ledgerEntry.amount).toBe(-25);
  });

  it("returns 402 when balance is insufficient", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: {},
    } as any);
    dbMock.creditLedger.findFirst.mockResolvedValue({ balance: 5 } as any);

    const res = await app.request(
      withAppUser("/v1/me/credits/spend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "spend-002",
        },
        body: JSON.stringify({ amount: 10 }),
      }),
    );
    expect(res.status).toBe(402);
  });
});

describe("POST /v1/me/attributes", () => {
  it("merges attributes for the resolved subscriber", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_test",
      appUserId: "user_1",
      attributes: { tier: "free" },
    } as any);
    dbMock.subscriber.upsert.mockResolvedValue({
      id: "sub_1",
      appUserId: "user_1",
      attributes: { tier: "free", country: "TR" },
    } as any);

    const res = await app.request(
      withAppUser("/v1/me/attributes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attributes: { country: "TR" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.subscriber.attributes.tier).toBe("free");
    expect(body.data.subscriber.attributes.country).toBe("TR");
  });
});
