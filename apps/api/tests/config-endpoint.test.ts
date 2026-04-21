import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, drizzleMock, engineMock, flagMock } = vi.hoisted(() => {
  const prismaMock = {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    subscriber: {
      upsert: vi.fn(),
      findUnique: vi.fn(async () => null),
    },
    productGroup: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    product: {
      findMany: vi.fn(async () => []),
    },
  };

  // During tests the shadow path is a no-op that just awaits the
  // Prisma caller. We keep the shape aligned with the real helper
  // (accepts primary + shadow callbacks) so the production code
  // path stays unchanged.
  const drizzleMock = {
    db: {} as unknown,
    subscriberRepo: {
      findSubscriberAttributes: vi.fn(async () => null),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async (_db: unknown, keyPublic: string) =>
        prismaMock.apiKey.findUnique({
          where: { keyPublic },
          include: { project: true },
        }),
      ),
      findApiKeyById: vi.fn(async (_db: unknown, id: string) =>
        prismaMock.apiKey.findUnique({
          where: { id },
          include: { project: true },
        }),
      ),
    },
    projectRepo: {
      findMembership: vi.fn(async () => null),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    shadowRead: vi.fn(
      async <T>(
        primary: () => Promise<T>,
        _shadow: () => Promise<T>,
      ): Promise<T> => primary(),
    ),
  };

  const engineMock = {
    evaluateExperiments: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    resolveProductGroup: vi.fn(async () => null),
    invalidateExperimentCache: vi.fn(async () => undefined),
  };

  const flagMock = {
    evaluateAllFlags: vi.fn(async () => ({})),
    invalidateFlagCache: vi.fn(async () => undefined),
  };

  return { prismaMock, drizzleMock, engineMock, flagMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
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
  ExperimentStatus: {
    DRAFT: "DRAFT",
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETED",
  },
  FeatureFlagType: {
    BOOLEAN: "BOOLEAN",
    STRING: "STRING",
    NUMBER: "NUMBER",
    JSON: "JSON",
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
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

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => true),
    hash: vi.fn(async () => "hashed"),
  },
}));

vi.mock("../src/services/experiment-engine", () => engineMock);
vi.mock("../src/services/flag-engine", () => flagMock);

// =============================================================
// Import app after mocks
// =============================================================

import { app } from "../src/app";

const PUBLIC_KEY = "rov_pub_test_key";

function withAuth(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PUBLIC_KEY}`);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

const apiKeyRecord = {
  id: "apikey_1",
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
  project: { id: "proj_test", name: "Test", slug: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.apiKey.findUnique.mockResolvedValue(apiKeyRecord);
  prismaMock.apiKey.update.mockResolvedValue(apiKeyRecord);
  prismaMock.subscriber.upsert.mockResolvedValue({
    id: "sub_internal_1",
    projectId: "proj_test",
    appUserId: "user_abc",
    attributes: {},
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  engineMock.evaluateExperiments.mockResolvedValue({});
  engineMock.recordEvent.mockResolvedValue(undefined);
  engineMock.resolveProductGroup.mockResolvedValue(null);
  flagMock.evaluateAllFlags.mockResolvedValue({});
});

// =============================================================
// GET /v1/config
// =============================================================

describe("GET /v1/config", () => {
  it("returns flags + experiments for a subscriberId query param", async () => {
    flagMock.evaluateAllFlags.mockResolvedValue({
      new_paywall_enabled: true,
      max_free_edits: 3,
    });
    engineMock.evaluateExperiments.mockResolvedValue({
      "pricing-test": {
        experimentId: "exp_1",
        key: "pricing-test",
        type: "PRODUCT_GROUP",
        variantId: "variant_a",
        variantName: "Weekly First",
        value: "weekly_first",
      },
    });

    const res = await app.request(withAuth("/v1/config?subscriberId=user_abc"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { flags: Record<string, unknown>; experiments: Record<string, unknown> };
    };
    expect(body.data.flags).toEqual({
      new_paywall_enabled: true,
      max_free_edits: 3,
    });
    expect(body.data.experiments["pricing-test"]).toMatchObject({
      variantId: "variant_a",
      type: "PRODUCT_GROUP",
      value: "weekly_first",
    });
  });

  it("accepts subscriberId via X-Rovenue-User-Id header", async () => {
    const res = await app.request(
      withAuth("/v1/config", {
        headers: { "x-rovenue-user-id": "user_abc" },
      }),
    );

    expect(res.status).toBe(200);
    expect(prismaMock.subscriber.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_appUserId: {
            projectId: "proj_test",
            appUserId: "user_abc",
          },
        },
      }),
    );
  });

  it("returns 400 when subscriberId is missing", async () => {
    const res = await app.request(withAuth("/v1/config"));
    expect(res.status).toBe(400);
  });

  it("passes the internal subscriber.id to the engines", async () => {
    await app.request(withAuth("/v1/config?subscriberId=user_abc"));

    expect(flagMock.evaluateAllFlags).toHaveBeenCalledWith(
      "proj_test",
      "sub_internal_1",
      expect.any(Object),
    );
    expect(engineMock.evaluateExperiments).toHaveBeenCalledWith(
      "proj_test",
      "sub_internal_1",
      expect.any(Object),
    );
  });
});

// =============================================================
// POST /v1/config — with runtime attributes
// =============================================================

describe("POST /v1/config", () => {
  it("merges request attributes with DB-stored attributes (request wins)", async () => {
    // Phase 5: the attributes read is Drizzle-only now.
    drizzleMock.subscriberRepo.findSubscriberAttributes.mockResolvedValue({
      attributes: { plan: "free", totalRevenue: 0 },
    } as any);
    prismaMock.subscriber.upsert.mockResolvedValue({
      id: "sub_internal_1",
      projectId: "proj_test",
      appUserId: "user_abc",
      attributes: { plan: "pro", totalRevenue: 0, country: "TR", platform: "ios" },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await app.request(
      withAuth("/v1/config?subscriberId=user_abc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attributes: {
            country: "TR",
            platform: "ios",
            plan: "pro",
          },
        }),
      }),
    );

    expect(flagMock.evaluateAllFlags).toHaveBeenCalledWith(
      "proj_test",
      "sub_internal_1",
      expect.objectContaining({
        country: "TR",
        platform: "ios",
        plan: "pro",
        totalRevenue: 0,
      }),
    );
  });

  it("accepts an empty body", async () => {
    const res = await app.request(
      withAuth("/v1/config?subscriberId=user_abc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });
});

// =============================================================
// POST /v1/experiments/track
// =============================================================

describe("POST /v1/experiments/track", () => {
  it("invokes recordEvent for each event in the batch", async () => {
    const res = await app.request(
      withAuth("/v1/experiments/track?subscriberId=user_abc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            { key: "paywall-summer", type: "paywall_viewed" },
            {
              key: "cta-text-test",
              type: "cta_clicked",
              timestamp: "2026-04-15T10:00:05Z",
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { recorded: number } };
    expect(body.data.recorded).toBe(2);

    expect(engineMock.recordEvent).toHaveBeenCalledTimes(2);
    expect(engineMock.recordEvent).toHaveBeenNthCalledWith(
      1,
      "sub_internal_1",
      "paywall_viewed",
      expect.any(Object),
    );
    expect(engineMock.recordEvent).toHaveBeenNthCalledWith(
      2,
      "sub_internal_1",
      "cta_clicked",
      expect.any(Object),
    );
  });

  it("returns 400 when events array is empty or malformed", async () => {
    const res = await app.request(
      withAuth("/v1/experiments/track?subscriberId=user_abc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when subscriberId is missing", async () => {
    const res = await app.request(
      withAuth("/v1/experiments/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ type: "paywall_viewed" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// =============================================================
// GET /v1/product-groups/:identifier — experiment override
// =============================================================

describe("GET /v1/product-groups/:identifier with subscriberId", () => {
  it("applies PRODUCT_GROUP experiment override and sets X-Rovenue-Experiment header", async () => {
    prismaMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_internal_1",
      projectId: "proj_test",
      appUserId: "user_abc",
      attributes: {},
    });
    engineMock.evaluateExperiments.mockResolvedValue({
      "pricing-test": {
        experimentId: "exp_1",
        key: "pricing-test",
        type: "PRODUCT_GROUP",
        variantId: "variant_a",
        variantName: "Weekly First",
        value: "weekly_first",
      },
    });
    prismaMock.productGroup.findUnique.mockResolvedValue({
      id: "pg_weekly",
      identifier: "weekly_first",
      isDefault: false,
      products: [],
      metadata: {},
    });
    prismaMock.product.findMany.mockResolvedValue([]);

    const res = await app.request(
      withAuth(
        "/v1/product-groups/default?subscriberId=user_abc",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-rovenue-experiment")).toBe(
      "pricing-test:variant_a",
    );
    const body = (await res.json()) as { data: { identifier: string } };
    expect(body.data.identifier).toBe("weekly_first");
  });

  it("falls through to the direct lookup when no subscriberId is provided", async () => {
    prismaMock.productGroup.findFirst.mockResolvedValue({
      id: "pg_default",
      identifier: "default",
      isDefault: true,
      products: [],
      metadata: {},
    });

    const res = await app.request(withAuth("/v1/product-groups/default"));

    expect(res.status).toBe(200);
    expect(engineMock.resolveProductGroup).not.toHaveBeenCalled();
    expect(res.headers.get("x-rovenue-experiment")).toBeNull();
  });
});
