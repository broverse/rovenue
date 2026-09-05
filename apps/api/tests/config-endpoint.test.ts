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

const { dbMock, drizzleMock, engineMock, flagMock } = vi.hoisted(() => {
  // Every findUnique/findFirst/findMany below is called with a `where`
  // args object (resolveSubscriberByRovenueIdOrLegacy / offeringRepo below)
  // and reassigned in tests via .mockResolvedValue with real fixtures — a
  // zero-arg `vi.fn(async () => null)`/`vi.fn(async () => [])` both rejects
  // the where-arg calls (TS2554) and infers a null-only/never[]-only
  // return type no fixture satisfies (TS2345).
  type FindOne = (args?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  type FindMany = (args?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  const dbMock = {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    subscriber: {
      upsert: vi.fn(),
      findUnique: vi.fn<FindOne>(async () => null),
    },
    // Named `offering` because that is what the repo stubs below and the
    // test bodies both reach for. It was still `productGroup` here after the
    // product-group → offering rename, so every offering lookup resolved
    // against `undefined` and failed with "Cannot read properties of
    // undefined (reading 'findUnique')".
    offering: {
      findUnique: vi.fn<FindOne>(async () => null),
      findFirst: vi.fn<FindOne>(async () => null),
    },
    product: {
      findMany: vi.fn<FindMany>(async () => []),
    },
  };

  // During tests the shadow path is a no-op that awaits the
  // primary caller. We keep the shape aligned with the real helper
  // (accepts primary + shadow callbacks) so the production code
  // path stays unchanged.
  const drizzleMock = {
    db: {} as unknown,
    subscriberRepo: {
      // Names follow the real repository. They were the pre-rovenue_id ones
      // (`findSubscriberAttributes` / `findSubscriberByAppUserId`) long after
      // the server started resolving all inbound identity as a rovenueId, so
      // the routes called methods this mock did not define and every request
      // died with "… is not a function" — surfacing as a bare 500.
      findSubscriberAttributesByRovenueId: vi.fn(async () => null),
      // Merge-aware write resolution (resolveSubscriberForWrite): resolve
      // the live row first, check for a dead row, only then create via
      // upsert. Defaults model a brand-new rovenueId.
      resolveSubscriberByRovenueId: vi.fn(async () => null),
      findSubscriberByRovenueId: vi.fn(async () => null),
      updateSubscriberAttributesById: vi.fn(async () => undefined),
      resolveSubscriberByRovenueIdOrLegacy: vi.fn(
        async (_db: unknown, args: { projectId: string; key: string }) =>
          dbMock.subscriber.findUnique({
            where: {
              projectId_rovenueId: {
                projectId: args.projectId,
                rovenueId: args.key,
              },
            },
          }),
      ),
      upsertSubscriber: vi.fn(
        async (
          _tx: unknown,
          input: {
            projectId: string;
            rovenueId: string;
            createAttributes?: unknown;
            updateAttributes?: unknown;
          },
        ) =>
          dbMock.subscriber.upsert({
            where: {
              projectId_rovenueId: {
                projectId: input.projectId,
                rovenueId: input.rovenueId,
              },
            },
            create: {
              projectId: input.projectId,
              rovenueId: input.rovenueId,
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
    },
    offeringRepo: {
      listOfferings: vi.fn(async () => []),
      findDefaultOffering: vi.fn(async (_db: unknown, projectId: string) =>
        dbMock.offering.findFirst({
          where: { projectId, isDefault: true },
        }),
      ),
      findOfferingByIdentifier: vi.fn(
        async (_db: unknown, projectId: string, identifier: string) =>
          dbMock.offering.findUnique({
            where: { projectId_identifier: { projectId, identifier } },
          }),
      ),
      findProductsByIds: vi.fn(async (_db: unknown, projectId: string, ids: string[]) =>
        ids.length === 0
          ? []
          : dbMock.product.findMany({ where: { projectId, id: { in: ids } } }),
      ),
    },
    experimentRepo: {
      findRunningExperimentsByProject: vi.fn(async () => []),
      findExperimentsByProject: vi.fn(async () => []),
      findExperimentById: vi.fn(async () => null),
      findFirstExperimentByAudience: vi.fn(async () => null),
      countExperiments: vi.fn(async () => 0),
    },
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => []),
      findAudiencesByProject: vi.fn(async () => []),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async (_db: unknown, keyPublic: string) =>
        dbMock.apiKey.findUnique({
          where: { keyPublic },
          include: { project: true },
        }),
      ),
      findApiKeyById: vi.fn(async (_db: unknown, id: string) =>
        dbMock.apiKey.findUnique({
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

  return { dbMock, drizzleMock, engineMock, flagMock };
});

// What is under test is the database, not the package around it. This mock
// used to replace @rovenue/db wholesale, which meant every unrelated export
// the import graph happens to touch had to be re-listed here by hand — and a
// missing one is not a test failure but a COLLECTION failure, so the file
// reports "no tests" and blames a TypeError in someone else's module.
// `drizzle.schema` is the sharpest case: src/lib/audit.ts does
// `const { auditLogs } = drizzle.schema` at module scope, so the file could
// not be loaded at all. Starting from the real module and overriding only
// what talks to a database keeps that failure mode from coming back.
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    default: dbMock,
    drizzle: { ...drizzleMock, schema: actual.drizzle.schema },
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
    FeatureFlagEnv: {
      PROD: "PROD",
      STAGING: "STAGING",
      DEVELOPMENT: "DEVELOPMENT",
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
  };
});

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
  dbMock.apiKey.findUnique.mockResolvedValue(apiKeyRecord);
  dbMock.apiKey.update.mockResolvedValue(apiKeyRecord);
  dbMock.subscriber.upsert.mockResolvedValue({
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
        type: "OFFERING",
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
      type: "OFFERING",
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
    expect(dbMock.subscriber.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_rovenueId: {
            projectId: "proj_test",
            rovenueId: "user_abc",
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
      "PROD",
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
    // The merge base comes off the merge-aware-RESOLVED row (not a bare
    // rovenueId attributes read) since the retired-row fork fix.
    drizzleMock.subscriberRepo.resolveSubscriberByRovenueId.mockResolvedValue({
      id: "sub_internal_1",
      projectId: "proj_test",
      appUserId: "user_abc",
      deletedAt: null,
      attributes: { plan: "free", totalRevenue: 0 },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

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
      "PROD",
      "sub_internal_1",
      // `"0"`, not `0`: since the nested-attributes work the engines get a
      // flat projection typed `AttributeMap = Record<string, string>`
      // (flattenAttributes in @rovenue/shared), so every value is a string.
      // The numeric expectation here predated that.
      expect.objectContaining({
        country: "TR",
        platform: "ios",
        plan: "pro",
        totalRevenue: "0",
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
// GET /v1/offerings/:identifier — experiment override
// =============================================================

describe("GET /v1/offerings/:identifier with subscriberId", () => {
  it("applies OFFERING experiment override and sets X-Rovenue-Experiment header", async () => {
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_internal_1",
      projectId: "proj_test",
      appUserId: "user_abc",
      attributes: {},
    });
    engineMock.evaluateExperiments.mockResolvedValue({
      "pricing-test": {
        experimentId: "exp_1",
        key: "pricing-test",
        type: "OFFERING",
        variantId: "variant_a",
        variantName: "Weekly First",
        value: "weekly_first",
      },
    });
    dbMock.offering.findUnique.mockResolvedValue({
      id: "pg_weekly",
      identifier: "weekly_first",
      isDefault: false,
      products: [],
      metadata: {},
    });
    dbMock.product.findMany.mockResolvedValue([]);

    const res = await app.request(
      withAuth(
        "/v1/offerings/default?subscriberId=user_abc",
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
    dbMock.offering.findFirst.mockResolvedValue({
      id: "pg_default",
      identifier: "default",
      isDefault: true,
      products: [],
      metadata: {},
    });

    const res = await app.request(withAuth("/v1/offerings/default"));

    expect(res.status).toBe(200);
    expect(engineMock.resolveProductGroup).not.toHaveBeenCalled();
    expect(res.headers.get("x-rovenue-experiment")).toBeNull();
  });
});
