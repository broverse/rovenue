// =============================================================
// POST /dashboard/projects/:projectId/queries/execute — best-effort
// usage logging test
//
// Verifies that a throwing `warehouseQueryRunRepo.recordQueryRun`
// does NOT propagate to the caller: the route must still return
// the query payload with HTTP 200.
// =============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before any module import so that the
// vi.mock factory closures can reference them.
// ---------------------------------------------------------------------------

const { drizzleMock, authMock } = vi.hoisted(() => {
  const authMock = {
    auth: {
      api: {
        getSession: vi.fn(),
      },
    },
  };

  // schema proxy: returns a dummy table object for any property access so
  // routes that destructure drizzle.schema at module-init level don't crash.
  const schemaProxy = new Proxy(
    {},
    { get: (_t, prop) => new Proxy({ _table: String(prop) }, { get: (_t2, p2) => p2 }) },
  );

  const drizzleMock = {
    db: {} as unknown,
    schema: schemaProxy,
    projectRepo: {
      findMembership: vi.fn(async () => ({ id: "pm_1", role: "OWNER" })),
      findProjectById: vi.fn(async () => null),
    },
    savedQueryRepo: {
      listSavedQueries: vi.fn(async () => []),
      createSavedQuery: vi.fn(),
      findSavedQueryById: vi.fn(),
      updateSavedQuery: vi.fn(),
      deleteSavedQuery: vi.fn(),
    },
    warehouseQueryRunRepo: {
      recordQueryRun: vi.fn().mockRejectedValue(new Error("boom")),
    },
    // Stub other repos that the full dashboard router imports at init time.
    notificationRepo: { listNotifications: vi.fn(async () => []), countUnread: vi.fn(async () => 0) },
    notificationPreferencesRepo: { getPreferences: vi.fn(async () => null) },
    shadowRead: vi.fn(async <T>(primary: () => Promise<T>) => primary()),
  };

  return { drizzleMock, authMock };
});

// ---------------------------------------------------------------------------
// Mock @rovenue/db — spread real exports to keep all enums intact; only
// override `drizzle` (the repo namespace used by the route).
// ---------------------------------------------------------------------------

vi.mock("@rovenue/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...real,
    drizzle: drizzleMock,
  };
});

// ---------------------------------------------------------------------------
// Mock the auth lib used by requireDashboardAuth middleware.
// ---------------------------------------------------------------------------

vi.mock("../src/lib/auth", () => authMock);

// ---------------------------------------------------------------------------
// Mock the audit lib — its module-init code destructures drizzle.schema
// which we don't need to supply for this test.
// ---------------------------------------------------------------------------

vi.mock("../src/lib/audit", () => ({
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

// ---------------------------------------------------------------------------
// Mock the playground service so the test never hits ClickHouse.
// ---------------------------------------------------------------------------

const FIXED_PAYLOAD = {
  columns: [{ name: "count()", type: "UInt64" }],
  rows: [[42]],
  rowCount: 1,
  truncated: false,
  durationMs: 123,
};

vi.mock("../src/services/queries-playground", () => ({
  executePlaygroundQuery: vi.fn(async () => FIXED_PAYLOAD),
  readPlaygroundSchema: vi.fn(async () => ({ database: "rovenue", tables: [] })),
  QueryValidationError: class QueryValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "QueryValidationError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Also stub services that the full app wires up (flag engine, experiment
// engine) to prevent them from importing real infrastructure.
// ---------------------------------------------------------------------------

vi.mock("../src/services/flag-engine", () => ({
  evaluateAllFlags: vi.fn(async () => ({})),
  invalidateFlagCache: vi.fn(async () => undefined),
}));

vi.mock("../src/services/experiment-engine", () => ({
  evaluateExperiments: vi.fn(async () => ({})),
  recordEvent: vi.fn(async () => undefined),
  resolveProductGroup: vi.fn(async () => null),
  invalidateExperimentCache: vi.fn(async () => undefined),
  getExperimentResults: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Import app AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { app } from "../src/app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test-session" };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Re-apply the throwing mock (clearAllMocks resets mockRejectedValue).
  drizzleMock.warehouseQueryRunRepo.recordQueryRun.mockRejectedValue(
    new Error("boom"),
  );

  authMock.auth.api.getSession.mockResolvedValue({
    user: { id: "user_1" },
    session: { id: "sess_1" },
  });

  drizzleMock.projectRepo.findMembership.mockResolvedValue({
    id: "pm_1",
    role: "OWNER",
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /execute logging", () => {
  it("returns the query result even when usage logging throws", async () => {
    const res = await app.request(
      "http://localhost/dashboard/projects/proj_a/queries/execute",
      {
        method: "POST",
        headers: {
          ...authedHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: "SELECT count() FROM raw_revenue_events" }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof FIXED_PAYLOAD };
    expect(body.data).toEqual(FIXED_PAYLOAD);
    // Confirm recordQueryRun was called (and threw) — not silently skipped.
    expect(
      drizzleMock.warehouseQueryRunRepo.recordQueryRun,
    ).toHaveBeenCalledOnce();
  });

  it("calls recordQueryRun with correct projectId and userId", async () => {
    // Make recordQueryRun succeed in this test to verify call args.
    drizzleMock.warehouseQueryRunRepo.recordQueryRun.mockResolvedValue(
      undefined,
    );

    await app.request(
      "http://localhost/dashboard/projects/proj_b/queries/execute",
      {
        method: "POST",
        headers: {
          ...authedHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: "SELECT 1" }),
      },
    );

    expect(
      drizzleMock.warehouseQueryRunRepo.recordQueryRun,
    ).toHaveBeenCalledWith(drizzleMock.db, {
      projectId: "proj_b",
      userId: "user_1",
      durationMs: FIXED_PAYLOAD.durationMs,
      rowCount: FIXED_PAYLOAD.rows.length,
    });
  });
});
