// =============================================================
// /v1/subscribers route-level tests — attributes merge base
//
// Focused HTTP-layer test mirroring identify-route.integration.test.ts:
// the real @rovenue/db module is spread (so every enum/schema export
// resolves) and only `drizzle` is overridden with mock repos. No real
// Postgres required.
//
// Covers Fix 4: the attributes route reads its merge base by rovenueId
// (findSubscriberAttributesByRovenueId), so previously-stored
// attributes survive on a rovenueId-keyed subscriber with a null
// appUserId.
// =============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit mock — must be hoisted before any module import.
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj) return null;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
      return out;
    },
  ),
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

  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };

  // drizzle.schema is accessed at module-load time by some dashboard
  // routes; a Proxy stub keeps the import chain from throwing.
  const schema = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => ({ [String(prop)]: {} }),
  });

  const drizzleMock = {
    db: drizzleDb,
    schema,
    subscriberRepo: {
      findSubscriberAttributesByRovenueId: vi.fn(
        async (
          _db: unknown,
          _args: { projectId: string; rovenueId: string },
        ) => null as { attributes: unknown } | null,
      ),
      findSubscriberByAppUserId: vi.fn(async () => null),
      findSubscriberByRovenueId: vi.fn(async () => null),
      resolveSubscriberByRovenueId: vi.fn(async () => null),
      upsertSubscriber: vi.fn(
        async (
          _db: unknown,
          input: {
            projectId: string;
            rovenueId: string;
            createAttributes?: unknown;
            updateAttributes?: unknown;
          },
        ) => ({
          id: "sub_sdk",
          appUserId: null,
          attributes: input.updateAttributes,
        }),
      ),
    },
    lockRepo: {
      advisoryXactLock: vi.fn(async () => undefined),
      advisoryXactLock2: vi.fn(async () => undefined),
    },
    apiKeyRepo: {
      findApiKeyByPublic: vi.fn(async (_db: unknown, keyPublic: string) =>
        apiKey.findUnique({ where: { keyPublic }, include: { project: true } }),
      ),
      findApiKeyById: vi.fn(async (_db: unknown, id: string) =>
        apiKey.findUnique({ where: { id }, include: { project: true } }),
      ),
      updateApiKeyLastUsed: vi.fn(async () => undefined),
    },
    projectRepo: {
      findMembership: vi.fn(async () => null),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    shadowRead: vi.fn(async (primary: () => unknown) => primary()),
  };

  return { dbMock: { apiKey }, drizzleMock };
});

// Spread the real module so enum/schema exports are available; only the
// drizzle runtime object is overridden with mock repos.
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: drizzleMock,
  };
});

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => true),
    hash: vi.fn(async () => "hashed"),
  },
}));

// =============================================================
// Import app after mocks are wired
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
  project: { id: "proj_test", name: "Test Project", slug: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.apiKey.findUnique.mockResolvedValue(apiKeyRecord);
});

// =============================================================
// POST /v1/subscribers/:appUserId/attributes
// =============================================================

describe("POST /v1/subscribers/:appUserId/attributes", () => {
  it("preserves previously-stored attributes for a rovenueId-keyed (null appUserId) subscriber", async () => {
    // SDK-only subscriber: rovenueId set, appUserId null. The merge
    // base is read by rovenueId so existing keys aren't dropped.
    drizzleMock.subscriberRepo.findSubscriberAttributesByRovenueId.mockResolvedValue(
      { attributes: { country: "TR", tier: "free" } },
    );

    const res = await app.request(
      withAuth("/v1/subscribers/rov_device_42/attributes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attributes: { tier: "pro" } }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscriber: { attributes: Record<string, unknown> } };
    };
    // The old `country` key survived; `tier` was overwritten.
    expect(body.data.subscriber.attributes.country).toBe("TR");
    expect(body.data.subscriber.attributes.tier).toBe("pro");

    // The merge base was read by rovenueId from the path param.
    expect(
      drizzleMock.subscriberRepo.findSubscriberAttributesByRovenueId,
    ).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj_test",
      rovenueId: "rov_device_42",
    });

    // The upsert merged old + new attributes and keyed on the rovenueId.
    const upsertArgs =
      drizzleMock.subscriberRepo.upsertSubscriber.mock.calls[0]![1];
    expect(upsertArgs.rovenueId).toBe("rov_device_42");
    expect(upsertArgs.updateAttributes).toEqual({
      country: "TR",
      tier: "pro",
    });
  });
});
