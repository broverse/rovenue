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
  const drizzleMock = {
    db: drizzleDb,
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
    productGroupRepo: {
      listProductGroups: vi.fn(async (_db: unknown, projectId: string) =>
        productGroup.findMany({
          where: { projectId },
          orderBy: [{ isDefault: "desc" }, { identifier: "asc" }],
        }),
      ),
      findDefaultProductGroup: vi.fn(async (_db: unknown, projectId: string) =>
        productGroup.findFirst({
          where: { projectId, isDefault: true },
        }),
      ),
      findProductGroupByIdentifier: vi.fn(
        async (_db: unknown, projectId: string, identifier: string) =>
          productGroup.findUnique({
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
// POST /v1/receipts
// =============================================================

describe("POST /v1/receipts", () => {
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
      entitlementKeys: ["premium"],
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
        entitlementKey: "premium",
        isActive: true,
        expiresDate: new Date("2026-05-01T00:00:00Z"),
        store: "APP_STORE",
        purchaseId: "pur_1",
      },
    ]);
    dbMock.purchase.findMany.mockResolvedValue([purchaseRow]);
    dbMock.creditLedger.findFirst.mockResolvedValue(null);

    const res = await app.request(
      withPublicAuth("/v1/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          store: "APP_STORE",
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
  });

  it("rejects invalid body", async () => {
    const res = await app.request(
      withPublicAuth("/v1/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ store: "APP_STORE" }),
      }),
    );
    expect(res.status).toBe(400);
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
        entitlementKey: "premium",
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
// GET /v1/product-groups/:identifier
// =============================================================

describe("GET /v1/product-groups/:identifier", () => {
  it("returns a sorted product list for the named group", async () => {
    dbMock.productGroup.findUnique.mockResolvedValue({
      id: "pg_1",
      projectId: "proj_test",
      identifier: "premium",
      isDefault: false,
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
        entitlementKeys: ["premium"],
        isActive: true,
      },
      {
        id: "prod_2",
        identifier: "credits_100",
        type: "CONSUMABLE",
        displayName: "100 Credits",
        creditAmount: 100,
        entitlementKeys: [],
        isActive: true,
      },
    ]);

    const res = await app.request(
      withPublicAuth("/v1/product-groups/premium"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.identifier).toBe("premium");
    expect(body.data.products).toHaveLength(2);
    expect(body.data.products[0].identifier).toBe("credits_100");
    expect(body.data.products[0].isPromoted).toBe(true);
    expect(body.data.products[1].identifier).toBe("pro_monthly");
  });

  it("looks up the default group when identifier is 'default'", async () => {
    dbMock.productGroup.findFirst.mockResolvedValue({
      id: "pg_1",
      projectId: "proj_test",
      identifier: "default",
      isDefault: true,
      products: [],
      metadata: {},
    } as any);
    dbMock.product.findMany.mockResolvedValue([]);

    const res = await app.request(
      withPublicAuth("/v1/product-groups/default"),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when the group doesn't exist", async () => {
    dbMock.productGroup.findUnique.mockResolvedValue(null);
    const res = await app.request(
      withPublicAuth("/v1/product-groups/missing"),
    );
    expect(res.status).toBe(404);
  });
});

// =============================================================
// GET /v1/product-groups
// =============================================================

describe("GET /v1/product-groups", () => {
  it("lists groups with product counts", async () => {
    dbMock.productGroup.findMany.mockResolvedValue([
      {
        identifier: "default",
        isDefault: true,
        products: [{ productId: "p1", order: 1, isPromoted: false }],
      },
      {
        identifier: "experiment_summer",
        isDefault: false,
        products: [
          { productId: "p1", order: 1, isPromoted: true },
          { productId: "p2", order: 2, isPromoted: false },
        ],
      },
    ] as any);

    const res = await app.request(withPublicAuth("/v1/product-groups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.groups).toHaveLength(2);
    expect(body.data.groups[0].identifier).toBe("default");
    expect(body.data.groups[0].productCount).toBe(1);
    expect(body.data.groups[1].productCount).toBe(2);
  });
});
