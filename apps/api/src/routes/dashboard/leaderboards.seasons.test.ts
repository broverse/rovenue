import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Dashboard leaderboard-seasons routes (ROADMAP §12 item 3, Task 5)
// =============================================================
//
// Exercises the REAL `assertProjectAccess` / `assertProjectCapability`
// (unmocked -- see the `@rovenue/db` mock below, which fakes only the
// data layer those two functions read: `drizzle.projectRepo.findMembership`
// plus the `drizzle.leaderboardRepo.*` functions this route calls) against
// an in-memory membership + leaderboard/season/standings store. This is
// what makes the cross-project test below meaningful: a route that
// authorised against the URL's `:projectId` instead of the resolved
// leaderboard's own `projectId` would still pass a self-mocked
// `assertProjectAccess`, but fails here because the REAL authorization
// logic runs against fake data.
//
// `queryStandings` (Task 3, ClickHouse-backed) is mocked at the module
// boundary -- these are route tests, not ClickHouse tests -- which lets
// the "/seasons/:seasonId/standings" tests assert it is NEVER called: that
// endpoint reads only the frozen Postgres snapshot, per the task brief.

vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: c.req.header("x-test-user") ?? "u-anon" });
    await next();
  },
}));

const queryStandings = vi.hoisted(() => vi.fn());
vi.mock("../../services/leaderboards/standings-query", () => ({ queryStandings }));

// -------------------------------------------------------------
// In-memory `@rovenue/db` fake -- membership + leaderboard/season/
// standings rows, keyed the same way the real tables are.
// -------------------------------------------------------------

const state = vi.hoisted(() => ({
  memberships: new Map<string, { id: string; role: string }>(),
  leaderboards: new Map<string, any>(),
  seasons: new Map<string, any>(),
  standings: new Map<string, any[]>(),
  nextId: 1,
}));

function memberKey(projectId: string, userId: string): string {
  return `${projectId}:${userId}`;
}

const findMembership = vi.hoisted(() =>
  vi.fn(async (_db: unknown, projectId: string, userId: string) => {
    return state.memberships.get(memberKey(projectId, userId)) ?? null;
  }),
);

const listLeaderboards = vi.hoisted(() =>
  vi.fn(async (_db: unknown, projectId: string) => {
    return [...state.leaderboards.values()].filter((l) => l.projectId === projectId);
  }),
);
const findLeaderboardById = vi.hoisted(() =>
  vi.fn(async (_db: unknown, id: string) => state.leaderboards.get(id) ?? null),
);
const createLeaderboard = vi.hoisted(() =>
  vi.fn(async (_db: unknown, input: any) => {
    const row = {
      id: `lb_${state.nextId++}`,
      currencyId: null,
      customPeriodDays: null,
      timezone: "UTC",
      entryLimit: 100,
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    };
    state.leaderboards.set(row.id, row);
    return row;
  }),
);
const updateLeaderboard = vi.hoisted(() =>
  vi.fn(async (_db: unknown, id: string, patch: Record<string, unknown>) => {
    if (Object.keys(patch).length === 0) return null;
    const existing = state.leaderboards.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    state.leaderboards.set(id, updated);
    return updated;
  }),
);
const deleteLeaderboard = vi.hoisted(() =>
  vi.fn(async (_db: unknown, id: string) => {
    state.leaderboards.delete(id);
  }),
);
const listSeasons = vi.hoisted(() =>
  vi.fn(async (_db: unknown, leaderboardId: string) => {
    return [...state.seasons.values()]
      .filter((s) => s.leaderboardId === leaderboardId)
      .sort((a, b) => b.seasonNumber - a.seasonNumber);
  }),
);
const findSeasonById = vi.hoisted(() =>
  vi.fn(async (_db: unknown, id: string) => state.seasons.get(id) ?? null),
);
const findActiveSeason = vi.hoisted(() =>
  vi.fn(async (_db: unknown, leaderboardId: string) => {
    return (
      [...state.seasons.values()].find(
        (s) => s.leaderboardId === leaderboardId && s.status === "ACTIVE",
      ) ?? null
    );
  }),
);
const listStandings = vi.hoisted(() =>
  vi.fn(async (_db: unknown, seasonId: string) => {
    return [...(state.standings.get(seasonId) ?? [])].sort((a, b) => a.rank - b.rank);
  }),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { ...actual.drizzle.projectRepo, findMembership },
      leaderboardRepo: {
        ...actual.drizzle.leaderboardRepo,
        listLeaderboards,
        findLeaderboardById,
        createLeaderboard,
        updateLeaderboard,
        deleteLeaderboard,
        listSeasons,
        findSeasonById,
        findActiveSeason,
        listStandings,
      },
    },
  };
});

const { Hono } = await import("hono");
const { leaderboardsRoute } = await import("./leaderboards");
const { errorHandler } = await import("../../middleware/error");

function app() {
  const a = new Hono().route(
    "/dashboard/projects/:projectId/leaderboards",
    leaderboardsRoute,
  );
  a.onError(errorHandler);
  return a;
}

function addMembership(projectId: string, userId: string, role: string): void {
  state.memberships.set(memberKey(projectId, userId), { id: `m_${state.nextId++}`, role });
}

function addLeaderboard(overrides: Partial<Record<string, unknown>> & { projectId: string }) {
  const row = {
    id: `lb_${state.nextId++}`,
    identifier: "top-spenders",
    name: "Top Spenders",
    metric: "TOP_SPENDERS",
    currencyId: null,
    cadence: "WEEKLY",
    customPeriodDays: null,
    timezone: "UTC",
    entryLimit: 10,
    anchorAt: new Date("2026-01-01T00:00:00Z"),
    isEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  state.leaderboards.set(row.id, row);
  return row;
}

function addSeason(overrides: Partial<Record<string, unknown>> & { leaderboardId: string }) {
  const row = {
    id: `season_${state.nextId++}`,
    seasonNumber: 1,
    startsAt: new Date("2026-09-01T00:00:00Z"),
    endsAt: new Date("2026-09-08T00:00:00Z"),
    status: "ACTIVE",
    closedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
  state.seasons.set(row.id, row);
  return row;
}

function addStandings(seasonId: string, rows: Array<Record<string, unknown>>) {
  state.standings.set(
    seasonId,
    rows.map((r, i) => ({ id: `st_${state.nextId++}`, seasonId, rank: i + 1, ...r })),
  );
}

async function req(
  method: string,
  path: string,
  opts: { user?: string; body?: unknown } = {},
) {
  return app().request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.user ? { "x-test-user": opts.user } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(() => {
  state.memberships.clear();
  state.leaderboards.clear();
  state.seasons.clear();
  state.standings.clear();
  // Clears call history (spy assertions like `.not.toHaveBeenCalled()` must
  // not see calls from a PRIOR test) without touching the fake
  // implementations installed above.
  vi.clearAllMocks();
});

describe("POST /dashboard/projects/:projectId/leaderboards", () => {
  it("rejects a CUSTOM cadence without customPeriodDays", async () => {
    addMembership("p1", "owner1", "OWNER");
    const res = await req("POST", "/dashboard/projects/p1/leaderboards", {
      user: "owner1",
      body: {
        identifier: "top-spenders",
        name: "Top Spenders",
        metric: "TOP_SPENDERS",
        cadence: "CUSTOM",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/customPeriodDays must be a positive integer/i);
    expect(createLeaderboard).not.toHaveBeenCalled();
  });

  it("rejects customPeriodDays on a WEEKLY leaderboard", async () => {
    addMembership("p1", "owner1", "OWNER");
    const res = await req("POST", "/dashboard/projects/p1/leaderboards", {
      user: "owner1",
      body: {
        identifier: "top-spenders",
        name: "Top Spenders",
        metric: "TOP_SPENDERS",
        cadence: "WEEKLY",
        customPeriodDays: 7,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/customPeriodDays must be null when cadence is WEEKLY/i);
    expect(createLeaderboard).not.toHaveBeenCalled();
  });

  it("rejects an unknown IANA timezone", async () => {
    addMembership("p1", "owner1", "OWNER");
    const res = await req("POST", "/dashboard/projects/p1/leaderboards", {
      user: "owner1",
      body: {
        identifier: "top-spenders",
        name: "Top Spenders",
        metric: "TOP_SPENDERS",
        cadence: "WEEKLY",
        timezone: "Nonexistent/Timezone",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/timezone/i);
    expect(createLeaderboard).not.toHaveBeenCalled();
  });

  it("creates a leaderboard when cadence and timezone are valid", async () => {
    addMembership("p1", "owner1", "OWNER");
    const res = await req("POST", "/dashboard/projects/p1/leaderboards", {
      user: "owner1",
      body: {
        identifier: "top-spenders",
        name: "Top Spenders",
        metric: "TOP_SPENDERS",
        cadence: "MONTHLY",
        timezone: "Europe/Istanbul",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { leaderboard: { id: string; timezone: string } } };
    expect(body.data.leaderboard.timezone).toBe("Europe/Istanbul");
    expect(createLeaderboard).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-member with 403 and never calls createLeaderboard", async () => {
    // No membership seeded for p1/intruder.
    const res = await req("POST", "/dashboard/projects/p1/leaderboards", {
      user: "intruder",
      body: {
        identifier: "top-spenders",
        name: "Top Spenders",
        metric: "TOP_SPENDERS",
        cadence: "WEEKLY",
      },
    });
    expect(res.status).toBe(403);
    expect(createLeaderboard).not.toHaveBeenCalled();
  });
});

describe("GET /dashboard/projects/:projectId/leaderboards/:id/current", () => {
  it("returns live standings for the ACTIVE season, windowed to its [startsAt, endsAt)", async () => {
    addMembership("p1", "viewer1", "CUSTOMER_SUPPORT");
    const lb = addLeaderboard({ projectId: "p1", entryLimit: 25 });
    const season = addSeason({ leaderboardId: lb.id, seasonNumber: 3 });
    queryStandings.mockResolvedValueOnce([
      { subscriberId: "sub1", score: "42.00", eventCount: 4 },
    ]);

    // Caller-supplied query params must never override the active season's
    // own window -- the endpoint doesn't even read them.
    const res = await req(
      "GET",
      `/dashboard/projects/p1/leaderboards/${lb.id}/current?from=2000-01-01&to=2000-01-02`,
      { user: "viewer1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { season: { id: string }; entries: unknown[] };
    };
    expect(body.data.season.id).toBe(season.id);
    expect(body.data.entries).toEqual([
      { subscriberId: "sub1", score: "42.00", eventCount: 4 },
    ]);

    expect(queryStandings).toHaveBeenCalledTimes(1);
    const call = queryStandings.mock.calls[0][0];
    expect(call.projectId).toBe("p1");
    expect(call.limit).toBe(25);
    expect(new Date(call.startsAt).toISOString()).toBe(season.startsAt.toISOString());
    expect(new Date(call.endsAt).toISOString()).toBe(season.endsAt.toISOString());
  });

  it("returns an empty envelope, not a 404, when no season has opened yet", async () => {
    addMembership("p1", "viewer1", "CUSTOMER_SUPPORT");
    const lb = addLeaderboard({ projectId: "p1" });
    // No season added at all -- findActiveSeason resolves null.

    const res = await req(
      "GET",
      `/dashboard/projects/p1/leaderboards/${lb.id}/current`,
      { user: "viewer1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { season: null; entries: unknown[] } };
    expect(body.data).toEqual({ season: null, entries: [] });
    expect(queryStandings).not.toHaveBeenCalled();
  });
});

describe("GET /dashboard/projects/:projectId/leaderboards/seasons/:seasonId/standings", () => {
  it("returns the frozen Postgres snapshot without ever touching ClickHouse", async () => {
    addMembership("p1", "viewer1", "CUSTOMER_SUPPORT");
    const lb = addLeaderboard({ projectId: "p1" });
    const season = addSeason({ leaderboardId: lb.id, status: "CLOSED", seasonNumber: 1 });
    addStandings(season.id, [
      { subscriberId: "subA", score: "100.00", eventCount: 10 },
      { subscriberId: "subB", score: "50.00", eventCount: 5 },
    ]);
    // Deliberately never given a resolved value -- if the route called it,
    // awaiting `undefined` would throw and this test would fail loudly.

    const res = await req(
      "GET",
      `/dashboard/projects/p1/leaderboards/seasons/${season.id}/standings`,
      { user: "viewer1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { season: { id: string }; standings: Array<{ subscriberId: string; rank: number }> };
    };
    expect(body.data.season.id).toBe(season.id);
    expect(body.data.standings.map((s) => s.subscriberId)).toEqual(["subA", "subB"]);
    expect(body.data.standings.map((s) => s.rank)).toEqual([1, 2]);
    expect(queryStandings).not.toHaveBeenCalled();
  });

  it("404s for an unknown seasonId", async () => {
    addMembership("p1", "viewer1", "CUSTOMER_SUPPORT");
    const res = await req(
      "GET",
      "/dashboard/projects/p1/leaderboards/seasons/does-not-exist/standings",
      { user: "viewer1" },
    );
    expect(res.status).toBe(404);
  });

  it("a project member cannot read another project's leaderboard via a season id from that project", async () => {
    // Season belongs to a leaderboard under project p2. The attacker is a
    // real member of p1 (named in the URL) but NOT of p2.
    const lb2 = addLeaderboard({ projectId: "p2" });
    const season2 = addSeason({ leaderboardId: lb2.id });
    addStandings(season2.id, [{ subscriberId: "victim", score: "1.00", eventCount: 1 }]);
    addMembership("p1", "attacker", "OWNER");

    // Path names p1 (the attacker's own project) even though the season
    // belongs to p2 -- a route that authorised against the path segment
    // instead of the leaderboard's own projectId would incorrectly allow
    // this.
    const res = await req(
      "GET",
      `/dashboard/projects/p1/leaderboards/seasons/${season2.id}/standings`,
      { user: "attacker" },
    );

    expect(res.status).toBe(403);
    expect(findMembership).toHaveBeenCalledWith(expect.anything(), "p2", "attacker");
  });

  it("succeeds when the caller IS a member of the season's OWN project, regardless of the path's :projectId", async () => {
    const lb2 = addLeaderboard({ projectId: "p2" });
    const season2 = addSeason({ leaderboardId: lb2.id });
    addStandings(season2.id, [{ subscriberId: "sub1", score: "1.00", eventCount: 1 }]);
    // Legitimate member of p2, but the request still names p1 in the path.
    addMembership("p2", "legit", "CUSTOMER_SUPPORT");

    const res = await req(
      "GET",
      `/dashboard/projects/p1/leaderboards/seasons/${season2.id}/standings`,
      { user: "legit" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { standings: Array<{ subscriberId: string }> } };
    expect(body.data.standings.map((s) => s.subscriberId)).toEqual(["sub1"]);
  });
});

describe("PATCH /dashboard/projects/:projectId/leaderboards/:id", () => {
  it("rejects an empty patch with 400, not a 404 on a row that exists", async () => {
    addMembership("p1", "owner1", "OWNER");
    const lb = addLeaderboard({ projectId: "p1" });

    const res = await req(
      "PATCH",
      `/dashboard/projects/p1/leaderboards/${lb.id}`,
      { user: "owner1", body: {} },
    );

    // updateLeaderboard would return null for this (nothing to set) the
    // same way it does for "no such row" -- the route itself must tell
    // those apart rather than reporting an existing leaderboard as
    // missing.
    expect(res.status).toBe(400);
    expect(updateLeaderboard).not.toHaveBeenCalled();
  });

  it("still applies a non-empty patch normally", async () => {
    addMembership("p1", "owner1", "OWNER");
    const lb = addLeaderboard({ projectId: "p1", name: "Old Name" });

    const res = await req(
      "PATCH",
      `/dashboard/projects/p1/leaderboards/${lb.id}`,
      { user: "owner1", body: { name: "New Name" } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { leaderboard: { name: string } } };
    expect(body.data.leaderboard.name).toBe("New Name");
  });
});
