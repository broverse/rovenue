import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST   /dashboard/projects/:projectId/paywalls/:id/preview-sessions
// DELETE /dashboard/projects/:projectId/paywalls/:id/preview-sessions/:sid
// =============================================================
//
// P9 on-device preview (§6.16). Mint issues a plaintext token once (never
// persisted) and stores only its hash via Task 1's previewSessionRepo;
// revoke marks a session revoked. Both are gated on products:write
// (minting grants draft access to a physical device, same trust level as
// a builder write) and 404 when the paywall doesn't belong to the caller's
// project.

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));

const assertProjectCapability = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _userId: string, _cap: string) => ({
    id: "m1",
    role: "OWNER",
  })),
);
vi.mock("../../lib/capabilities", () => ({ assertProjectCapability }));

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../lib/audit", () => ({
  audit: auditMock,
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

// -------------------------------------------------------------
// In-memory `@rovenue/db` state
// -------------------------------------------------------------

const state = vi.hoisted(() => ({
  paywalls: {} as Record<string, any>,
  sessions: {} as Record<string, any>,
  nextId: 1,
}));

function freshId(prefix: string): string {
  return `${prefix}_${state.nextId++}`;
}

// Real Drizzle tx isn't exercised here — just a pass-through so the
// handler's `drizzle.db.transaction(...)` call runs its callback.
const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: any) => Promise<any>) => fn({ __tx: true })),
);

const findPaywallById = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: any, projectId: string, id: string) => {
    const row = state.paywalls[id];
    return row && row.projectId === projectId ? row : null;
  }),
);

const createPreviewSession = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: any, input: any) => {
    const row = {
      id: freshId("pvs"),
      revokedAt: null,
      createdAt: new Date(),
      ...input,
    };
    state.sessions[row.id] = row;
    return row;
  }),
);

const revokePreviewSession = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: any, projectId: string, sessionId: string) => {
    const row = state.sessions[sessionId];
    if (!row || row.projectId !== projectId) return null;
    row.revokedAt = new Date();
    return row;
  }),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction },
      paywallRepo: {
        ...actual.drizzle.paywallRepo,
        findPaywallById,
      },
      previewSessionRepo: {
        ...actual.drizzle.previewSessionRepo,
        createPreviewSession,
        revokePreviewSession,
      },
    },
  };
});

const { Hono } = await import("hono");
const { paywallsDashboardRoute } = await import("./paywalls");
const { errorHandler } = await import("../../middleware/error");
const { hashToken } = await import("../../services/funnel/token");

function app() {
  const a = new Hono().route("/dashboard/projects/:projectId/paywalls", paywallsDashboardRoute);
  a.onError(errorHandler);
  return a;
}

const PROJECT_ID = "p1";
const OTHER_PROJECT_ID = "p2";

function seedPaywall(overrides: Partial<Record<string, any>> & { id: string }): Record<string, any> {
  const row = {
    projectId: PROJECT_ID,
    identifier: overrides.id,
    name: "Paywall",
    ...overrides,
  };
  state.paywalls[row.id] = row;
  return row;
}

beforeEach(() => {
  state.paywalls = {};
  state.sessions = {};
  state.nextId = 1;
  assertProjectCapability.mockClear();
  auditMock.mockClear();
  for (const fn of [findPaywallById, createPreviewSession, revokePreviewSession, transaction]) {
    fn.mockClear();
  }
  seedPaywall({ id: "pwA" });
});

describe("POST /paywalls/:id/preview-sessions", () => {
  it("mints a token, persists only its HASH, and returns url/expiresAt in the data envelope", async () => {
    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/preview-sessions", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();

    expect(typeof json.data.sessionId).toBe("string");
    expect(typeof json.data.token).toBe("string");
    expect(json.data.token.length).toBeGreaterThan(0);
    expect(typeof json.data.expiresAt).toBe("string");
    expect(json.data.previewUrl).toBe(`http://localhost/v1/preview/paywalls/${json.data.token}`);
    expect(json.data.qrPayload).toBe(json.data.previewUrl);

    // The plaintext token is never what got persisted — only its hash is.
    expect(createPreviewSession).toHaveBeenCalledTimes(1);
    const insertArg = createPreviewSession.mock.calls[0]![1];
    expect(insertArg.tokenHash).not.toBe(json.data.token);
    expect(insertArg.tokenHash).toBe(hashToken(json.data.token));
    expect(insertArg.projectId).toBe("p1");
    expect(insertArg.paywallId).toBe("pwA");
  });

  it("gates on products:write", async () => {
    await app().request("/dashboard/projects/p1/paywalls/pwA/preview-sessions", {
      method: "POST",
    });

    expect(assertProjectCapability).toHaveBeenCalledWith("p1", "u1", "products:write");
  });

  it("404s for a paywall belonging to another project", async () => {
    seedPaywall({ id: "pwOther", projectId: OTHER_PROJECT_ID });

    const res = await app().request(
      "/dashboard/projects/p1/paywalls/pwOther/preview-sessions",
      { method: "POST" },
    );

    expect(res.status).toBe(404);
    expect(createPreviewSession).not.toHaveBeenCalled();
  });

  it("audits the mint under the paywall_preview_session resource", async () => {
    const res = await app().request("/dashboard/projects/p1/paywalls/pwA/preview-sessions", {
      method: "POST",
    });
    const json = await res.json();

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        userId: "u1",
        action: "create",
        resource: "paywall_preview_session",
        resourceId: json.data.sessionId,
      }),
      expect.anything(),
    );
  });
});

describe("DELETE /paywalls/:id/preview-sessions/:sid", () => {
  it("revokes the session via the repo and returns { revoked: true }", async () => {
    const seeded = await createPreviewSession(null, {
      projectId: "p1",
      paywallId: "pwA",
      tokenHash: "deadbeef",
      createdBy: "u1",
      expiresAt: new Date(),
    });
    createPreviewSession.mockClear();

    const res = await app().request(
      `/dashboard/projects/p1/paywalls/pwA/preview-sessions/${seeded.id}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { revoked: true } });
    expect(revokePreviewSession).toHaveBeenCalledWith(expect.anything(), "p1", seeded.id);
    expect(state.sessions[seeded.id].revokedAt).not.toBeNull();
  });

  it("gates on products:write", async () => {
    const seeded = await createPreviewSession(null, {
      projectId: "p1",
      paywallId: "pwA",
      tokenHash: "deadbeef",
      createdBy: "u1",
      expiresAt: new Date(),
    });

    await app().request(`/dashboard/projects/p1/paywalls/pwA/preview-sessions/${seeded.id}`, {
      method: "DELETE",
    });

    expect(assertProjectCapability).toHaveBeenCalledWith("p1", "u1", "products:write");
  });

  it("404s for a paywall belonging to another project", async () => {
    seedPaywall({ id: "pwOther", projectId: OTHER_PROJECT_ID });
    const seeded = await createPreviewSession(null, {
      projectId: OTHER_PROJECT_ID,
      paywallId: "pwOther",
      tokenHash: "deadbeef",
      createdBy: "u1",
      expiresAt: new Date(),
    });

    const res = await app().request(
      `/dashboard/projects/p1/paywalls/pwOther/preview-sessions/${seeded.id}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(revokePreviewSession).not.toHaveBeenCalled();
  });

  it("audits the revoke under the paywall_preview_session resource", async () => {
    const seeded = await createPreviewSession(null, {
      projectId: "p1",
      paywallId: "pwA",
      tokenHash: "deadbeef",
      createdBy: "u1",
      expiresAt: new Date(),
    });

    await app().request(`/dashboard/projects/p1/paywalls/pwA/preview-sessions/${seeded.id}`, {
      method: "DELETE",
    });

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        userId: "u1",
        action: "delete",
        resource: "paywall_preview_session",
        resourceId: seeded.id,
      }),
      expect.anything(),
    );
  });
});
