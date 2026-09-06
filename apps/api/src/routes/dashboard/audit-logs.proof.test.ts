import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUDIT_CHAIN_FORMAT_V1, hashAuditRow } from "@rovenue/shared/audit-chain";
import auditProofFixture from "@rovenue/shared/audit-proof-bundle-fixture.json";

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

  test("range is null/null when no from/to was requested", async () => {
    // FIX 2 (final review): `origin` alone can't distinguish a legitimate
    // ranged export from one whose head rows were deleted -- `range`
    // echoes what was actually requested so a reader can tell.
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.range).toEqual({ from: null, to: null });
  });

  test("range echoes the requested from/to as ISO strings", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof(
      "?projectId=p1&from=2026-09-01T00:00:00.000Z&to=2026-09-03T00:00:00.000Z",
      { user: "u1" },
    );
    const body = await res.json();

    expect(body.data.range).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-03T00:00:00.000Z",
    });
  });

  test("range echoes only the side of the range that was requested", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1&from=2026-09-01T00:00:00.000Z", {
      user: "u1",
    });
    const body = await res.json();

    expect(body.data.range).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: null,
    });
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

  test("queries the repository for the AUTHORISED project, capped", async () => {
    // Asserts the full call shape, not just `limit` in isolation: a route
    // that authorised the caller against "p1" but then asked the
    // repository for a different project's rows (a cross-tenant leak of
    // the most sensitive table in the system) must fail this test even
    // though the response envelope still looks fine.
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    await getProof("?projectId=p1", { user: "u1" });

    expect(listAuditProofRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: "p1", limit: AUDIT_PROOF_MAX_ENTRIES }),
    );
  });

  test("passes the requested date range to the repository as Date objects", async () => {
    // listAuditProofRows's args are `{ projectId, from?: Date, to?: Date,
    // limit }` (packages/db/src/drizzle/repositories/audit-logs.ts) -- the
    // route must convert the validated ISO strings, not drop them.
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    await getProof(
      "?projectId=p1&from=2026-09-01T00:00:00.000Z&to=2026-09-03T00:00:00.000Z",
      { user: "u1" },
    );

    expect(listAuditProofRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from: new Date("2026-09-01T00:00:00.000Z"),
        to: new Date("2026-09-03T00:00:00.000Z"),
      }),
    );
  });

  test("the bundle is labelled with the requested (authorised) project", async () => {
    // A bundle mislabelled with the wrong projectId would ship to a third
    // party unnoticed -- assert the response body's own field, not just
    // the repository call.
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.projectId).toBe("p1");
  });

  test("rejects a malformed from/to with the standard validation envelope", async () => {
    addMembership("p1", "u1", "OWNER");

    const res = await getProof("?projectId=p1&from=not-a-date", { user: "u1" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Request validation failed" },
    });
    expect(listAuditProofRows).not.toHaveBeenCalled();
  });

  test("accepts an offset ISO timestamp, matching the sibling list route's grammar", async () => {
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce([]);

    const res = await getProof("?projectId=p1&from=2026-09-01T00:00:00%2B03:00", {
      user: "u1",
    });

    expect(res.status).toBe(200);
    expect(listAuditProofRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: new Date("2026-09-01T00:00:00+03:00") }),
    );
  });

  test("reports truncated: true when the read hits the cap", async () => {
    const rows = Array.from({ length: AUDIT_PROOF_MAX_ENTRIES }, (_, i) =>
      makeRow({
        id: `capped-${i}`,
        prevHash: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        rowHash: null,
      }),
    );
    addMembership("p1", "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce(rows);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.entries).toHaveLength(AUDIT_PROOF_MAX_ENTRIES);
    expect(body.data.truncated).toBe(true);
  });

  test("reports truncated: false for a short export", async () => {
    addMembership("p1", "u1", "OWNER");
    const row1 = hashedRow("a1", null, "2026-09-01T00:00:00.000Z");
    listAuditProofRows.mockResolvedValueOnce([row1]);

    const res = await getProof("?projectId=p1", { user: "u1" });
    const body = await res.json();

    expect(body.data.truncated).toBe(false);
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

  // Ties this endpoint's assembly to
  // packages/shared/src/audit-proof-bundle-fixture.json, the same fixture
  // scripts/verify-audit-bundle.test.ts asserts verifies clean offline.
  // `apps/api` cannot depend on `@rovenue/scripts` (the standalone
  // verifier must stay isolated from the server it audits), so this
  // fixture -- read by both sides via the `@rovenue/shared` subpath
  // export, never typed by hand on either side -- is what keeps the
  // endpoint's output and the verifier's acceptance criteria from
  // drifting apart while both suites stay green (ROADMAP §12's recurring
  // failure mode). If the endpoint's assembly ever changes shape, this
  // goes red here; if the verifier's acceptance criteria change, the
  // scripts-side test goes red there.
  test("assembles a bundle that deep-equals the shared fixture (modulo exportedAt)", async () => {
    addMembership(auditProofFixture.projectId, "u1", "OWNER");
    listAuditProofRows.mockResolvedValueOnce(auditProofFixture.entries);

    const res = await getProof(`?projectId=${auditProofFixture.projectId}`, {
      user: "u1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // `exportedAt` is a wall-clock timestamp the endpoint stamps at
    // request time -- it can never match a static fixture -- so it is
    // asserted separately and excluded from the deep-equal below.
    expect(typeof body.data.exportedAt).toBe("string");
    const { exportedAt: _actualExportedAt, ...restOfBody } = body.data;
    const { exportedAt: _fixtureExportedAt, ...restOfFixture } = auditProofFixture;
    expect(restOfBody).toEqual(restOfFixture);
  });
});
