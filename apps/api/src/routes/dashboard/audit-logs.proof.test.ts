import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUDIT_CHAIN_FORMAT_V1, hashAuditRow } from "@rovenue/shared/audit-chain";

// =============================================================
// GET /dashboard/audit-logs/proof (ROADMAP §9.3, Task 3)
// =============================================================
//
// Exercises the REAL `assertProjectAccess` (unmocked -- see the
// `@rovenue/db` mock below, which fakes only the data layer it reads:
// `drizzle.projectRepo.findMembership` plus `drizzle.auditLogRepo.
// listAuditProofRows`) against an in-memory membership store, the same
// approach §12.3's dashboard tests (leaderboards.seasons.test.ts) used.
// A route that authorised against the wrong id would still pass a
// self-mocked `assertProjectAccess`, but fails here because the real
// authorization logic runs against fake data.

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: c.req.header("x-test-user") ?? "u-anon" });
    await next();
  },
}));

const state = vi.hoisted(() => ({
  memberships: new Map<string, { id: string; role: string }>(),
}));

function memberKey(projectId: string, userId: string): string {
  return `${projectId}:${userId}`;
}

const findMembership = vi.hoisted(() =>
  vi.fn(async (_db: unknown, projectId: string, userId: string) => {
    return state.memberships.get(memberKey(projectId, userId)) ?? null;
  }),
);

const listAuditProofRows = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { ...actual.drizzle.projectRepo, findMembership },
      auditLogRepo: { ...actual.drizzle.auditLogRepo, listAuditProofRows },
    },
  };
});

const { Hono } = await import("hono");
const { auditLogsRoute, AUDIT_PROOF_MAX_ENTRIES } = await import("./audit-logs");
const { errorHandler } = await import("../../middleware/error");

function app() {
  const a = new Hono().route("/dashboard/audit-logs", auditLogsRoute);
  a.onError(errorHandler);
  return a;
}

function addMembership(projectId: string, userId: string, role: string): void {
  state.memberships.set(memberKey(projectId, userId), { id: `m_${userId}`, role });
}

async function getProof(
  query: string,
  opts: { user?: string } = {},
) {
  return app().request(`/dashboard/audit-logs/proof${query}`, {
    headers: opts.user ? { "x-test-user": opts.user } : {},
  });
}

// A proof row as `listAuditProofRows` returns it: exactly the fields
// `hashAuditRow` covers, plus `id` and `rowHash`.
function makeRow(overrides: {
  id: string;
  prevHash: string | null;
  createdAt: string;
  rowHash: string | null;
}) {
  const payload = {
    projectId: "p1",
    userId: "u1",
    action: "project.update",
    resource: "project",
    resourceId: "p1",
    before: null,
    after: { name: "New name" },
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    createdAt: overrides.createdAt,
    prevHash: overrides.prevHash,
  };
  return { id: overrides.id, ...payload, rowHash: overrides.rowHash };
}

// Builds a hashed row: computes rowHash from exactly the
// AuditChainPayload fields (never `id`/`rowHash` themselves).
function hashedRow(id: string, prevHash: string | null, createdAt: string) {
  const row = makeRow({ id, prevHash, createdAt, rowHash: null });
  const { id: _id, rowHash: _rowHash, ...payload } = row;
  const rowHash = hashAuditRow(payload);
  return { ...row, rowHash };
}

beforeEach(() => {
  state.memberships.clear();
  // `resetAllMocks` (not `clearAllMocks`) so an unconsumed
  // `mockResolvedValueOnce` from a test whose route short-circuits
  // before calling the repo (e.g. the 403 case below) can't leak into
  // a later test's queue and shift its return value by one call.
  vi.resetAllMocks();
  findMembership.mockImplementation(async (_db: unknown, projectId: string, userId: string) => {
    return state.memberships.get(memberKey(projectId, userId)) ?? null;
  });
});

describe("GET /audit-logs/proof", () => {
  test("returns a bundle whose entries reproduce their own rowHash", async () => {
    addMembership("p1", "u1", "OWNER");
    const row1 = hashedRow("a1", null, "2026-09-01T00:00:00.000Z");
    const row2 = hashedRow("a2", row1.rowHash, "2026-09-02T00:00:00.000Z");
    const row3 = hashedRow("a3", row2.rowHash, "2026-09-03T00:00:00.000Z");
    listAuditProofRows.mockResolvedValueOnce([row1, row2, row3]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.entries).toHaveLength(3);
    for (const entry of body.data.entries) {
      const { id, rowHash, ...payload } = entry;
      expect(hashAuditRow(payload)).toBe(rowHash);
    }
  });

  test("declares the format version", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.formatVersion).toBe(AUDIT_CHAIN_FORMAT_V1);
  });

  test("origin is null when the range starts at the chain's first row", async () => {
    addMembership("p1", "u1", "OWNER");
    const row1 = hashedRow("a1", null, "2026-09-01T00:00:00.000Z");
    listAuditProofRows.mockResolvedValueOnce([row1]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.origin).toBeNull();
  });

  test("origin names the predecessor when the range starts mid-chain", async () => {
    addMembership("p1", "u1", "OWNER");
    const row1 = hashedRow("a1", null, "2026-09-01T00:00:00.000Z");
    const row2 = hashedRow("a2", row1.rowHash, "2026-09-02T00:00:00.000Z");
    // Export starting from row2 onward: origin must carry row1's hash.
    listAuditProofRows.mockResolvedValueOnce([row2]);

    const res = await getProof("?projectId=p1&from=2026-09-02T00:00:00.000Z", {
      user: "u1",
    });
    const body = await res.json();

    expect(body.data.origin).toEqual({ rowHash: row1.rowHash });
  });

  test("an empty range returns an empty bundle, not an error", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.entries).toEqual([]);
    expect(body.data.tip).toBeNull();
    expect(body.data.origin).toBeNull();
  });

  test("a member of another project cannot export this project's bundle", async () => {
    // u2 belongs to p2, not p1.
    addMembership("p2", "u2", "OWNER");

    const res = await getProof("?projectId=p1", { user: "u2" });
    expect(res.status).toBe(403);
    expect(listAuditProofRows).not.toHaveBeenCalled();
  });

  test("a legitimate member can export", async () => {
    addMembership("p1", "u1", "CUSTOMER_SUPPORT");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    expect(res.status).toBe(200);
  });

  test("caps the entry count", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    await getProof("?projectId=p1", { user: "u1" });

    expect(listAuditProofRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: AUDIT_PROOF_MAX_ENTRIES }),
    );
  });

  test("carries a null rowHash through for a pre-chain legacy row", async () => {
    addMembership("p1", "u1", "OWNER");
    // A row written before the hash chain existed: rowHash is null, and
    // listAuditProofRows deliberately does not filter it out.
    const legacyRow = makeRow({
      id: "legacy1",
      prevHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      rowHash: null,
    });
    listAuditProofRows.mockResolvedValueOnce([legacyRow]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].rowHash).toBeNull();
    expect(body.data.tip).toEqual({
      rowHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
