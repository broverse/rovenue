// =============================================================
// POST /v1/identify — route-level unit tests
//
// These tests exercise the HTTP layer (auth, validation, error
// mapping) using mocked drizzle/service dependencies — no real
// Postgres required. The bindAppUserId service itself is covered
// by identify.test.ts (live DB).
//
// Auth pattern mirrors config-endpoint.test.ts:
//   • vi.hoisted mocks for @rovenue/db (apiKeyRepo + db.transaction)
//   • bcryptjs compare always returns true
//   • api key "rov_pub_test_key" resolves to project "proj_test"
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

  // drizzle.schema is accessed at module-load time by some dashboard routes
  // (e.g. notifications/index.ts `const { notifications } = drizzle.schema`).
  // Provide a minimal stub so the import chain doesn't throw during collection.
  const schema = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => ({ [String(prop)]: {} }),
  });

  const drizzleMock = {
    db: drizzleDb,
    schema,
    subscriberRepo: {
      findSubscriberByRovenueId: vi.fn(async () => null),
      findSubscriberByAppUserId: vi.fn(async () => null),
      setAppUserId: vi.fn(async () => undefined),
    },
    lockRepo: {
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

// bindAppUserId is mocked so the route test doesn't need a real DB.
const bindMock = vi.hoisted(() => ({
  bindAppUserId: vi.fn<
    [string, string, string, string?],
    Promise<{ subscriberId: string; appUserId: string; transferred: boolean }>
  >(),
}));
vi.mock("../src/services/identify", () => bindMock);

// Spread real module so all enum/schema exports are available, then
// override only the drizzle runtime object with our mock repos.
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

// =============================================================
// Shared auth setup
// =============================================================

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
// POST /v1/identify
// =============================================================

describe("POST /v1/identify", () => {
  it("returns 200 with transferred=false when bind succeeds without a prior holder", async () => {
    const subscriberId = "sub_device_abc";
    const rovenueId = "rov_device_abc";
    const appUserId = "customer_xyz";

    bindMock.bindAppUserId.mockResolvedValue({
      subscriberId,
      appUserId,
      transferred: false,
    });

    const res = await app.request(
      withAuth("/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rovenueId, appUserId }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscriberId: string; appUserId: string; transferred: boolean };
    };
    expect(body.data.transferred).toBe(false);
    expect(body.data.subscriberId).toBe(subscriberId);
    expect(body.data.appUserId).toBe(appUserId);
    expect(bindMock.bindAppUserId).toHaveBeenCalledWith(
      "proj_test",
      rovenueId,
      appUserId,
    );
  });

  it("returns 200 with transferred=true when a prior holder's assets were moved", async () => {
    bindMock.bindAppUserId.mockResolvedValue({
      subscriberId: "sub_device_abc",
      appUserId: "customer_xyz",
      transferred: true,
    });

    const res = await app.request(
      withAuth("/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rovenueId: "rov_device_abc", appUserId: "customer_xyz" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { transferred: boolean };
    };
    expect(body.data.transferred).toBe(true);
  });

  it("returns 400 when appUserId is missing from the body", async () => {
    const res = await app.request(
      withAuth("/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rovenueId: "rov_device_abc" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(bindMock.bindAppUserId).not.toHaveBeenCalled();
  });

  it("returns 400 when rovenueId is missing from the body", async () => {
    const res = await app.request(
      withAuth("/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appUserId: "customer_xyz" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(bindMock.bindAppUserId).not.toHaveBeenCalled();
  });

  it("returns 400 with error message when bindAppUserId throws (unknown device rovenueId)", async () => {
    const message = "Device subscriber 'rov_unknown' not found";
    bindMock.bindAppUserId.mockRejectedValue(new Error(message));

    const res = await app.request(
      withAuth("/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rovenueId: "rov_unknown", appUserId: "customer_xyz" }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await app.request(
      new Request("http://localhost/v1/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rovenueId: "rov_device_abc", appUserId: "customer_xyz" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(bindMock.bindAppUserId).not.toHaveBeenCalled();
  });
});
