import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  LEADERBOARD_SNAPSHOT_SETTLE_MS,
  sweepLeaderboardSeasons,
} from "./leaderboard-scheduler";
import { leaderboardSeasonCloseSkippedTotal } from "../lib/metrics";

const NOW = new Date("2026-09-07T00:10:00.000Z");

function season(overrides: Record<string, unknown> = {}) {
  return {
    id: "sea_1",
    leaderboardId: "lb_1",
    seasonNumber: 1,
    startsAt: new Date("2026-08-31T00:00:00.000Z"),
    endsAt: new Date("2026-09-07T00:00:00.000Z"),
    status: "ACTIVE",
    ...overrides,
  };
}

function leaderboard(overrides: Record<string, unknown> = {}) {
  return {
    id: "lb_1",
    projectId: "prj_1",
    metric: "TOP_SPENDERS",
    currencyId: null,
    cadence: "WEEKLY",
    customPeriodDays: null,
    timezone: "UTC",
    entryLimit: 100,
    anchorAt: new Date("2026-08-31T00:00:00.000Z"),
    isEnabled: true,
    ...overrides,
  };
}

let deps: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  deps = {
    findEnabledLeaderboardsWithoutActiveSeason: vi.fn(async () => []),
    findNextSeasonNumber: vi.fn(async () => 1),
    findDueSeasons: vi.fn(async () => []),
    findLeaderboardById: vi.fn(async () => leaderboard()),
    queryStandings: vi.fn(async () => [
      { subscriberId: "sub_1", score: "42.0000", eventCount: 3 },
    ]),
    claimSeasonForClose: vi.fn(async () => season({ status: "CLOSED" })),
    insertStandings: vi.fn(async () => {}),
    openSeason: vi.fn(async () => season({ id: "sea_2", seasonNumber: 2 })),
    audit: vi.fn(async () => {}),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});

describe("sweepLeaderboardSeasons", () => {
  test("queries ClickHouse BEFORE claiming the season", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    const queryOrder = deps.queryStandings.mock.invocationCallOrder[0]!;
    const claimOrder = deps.claimSeasonForClose.mock.invocationCallOrder[0]!;

    // Claiming first would mean a ClickHouse outage leaves a season
    // marked CLOSED with no standings, recoverable only by a
    // compensating un-close. This ordering removes that state.
    expect(queryOrder).toBeLessThan(claimOrder);
  });

  test("a ClickHouse failure closes nothing at all", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.queryStandings.mockRejectedValue(new Error("clickhouse down"));

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.claimSeasonForClose).not.toHaveBeenCalled();
    expect(deps.insertStandings).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("a lost claim writes no standings and opens no next season", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.claimSeasonForClose.mockResolvedValue(null);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.insertStandings).not.toHaveBeenCalled();
    expect(deps.openSeason).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
  });

  test("a closed season opens the next one starting exactly at endsAt", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.openSeason).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaderboardId: "lb_1",
        seasonNumber: 2,
        startsAt: new Date("2026-09-07T00:00:00.000Z"),
      }),
    );
  });

  test("does not close a season before the settle delay has elapsed", async () => {
    // findDueSeasons is called with endsAt + settle <= now, so assert the
    // cutoff the worker actually passes down.
    await sweepLeaderboardSeasons(NOW, deps as never);

    const cutoff = deps.findDueSeasons.mock.calls[0]![1] as Date;
    expect(cutoff.getTime()).toBe(NOW.getTime() - LEADERBOARD_SNAPSHOT_SETTLE_MS);
  });

  test("standings are ranked 1..N in query order", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.queryStandings.mockResolvedValue([
      { subscriberId: "sub_a", score: "99.0000", eventCount: 5 },
      { subscriberId: "sub_b", score: "42.0000", eventCount: 3 },
    ]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.insertStandings).toHaveBeenCalledWith(
      expect.anything(),
      "sea_1",
      [
        { rank: 1, subscriberId: "sub_a", score: "99.0000", eventCount: 5 },
        { rank: 2, subscriberId: "sub_b", score: "42.0000", eventCount: 3 },
      ],
    );
  });

  test("opens a first season for an enabled leaderboard that has none", async () => {
    deps.findEnabledLeaderboardsWithoutActiveSeason.mockResolvedValue([leaderboard()]);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.openSeason).toHaveBeenCalled();
    expect(result.opened).toBe(1);
  });

  test("a rejected open (another replica won) is not an error", async () => {
    deps.findEnabledLeaderboardsWithoutActiveSeason.mockResolvedValue([leaderboard()]);
    deps.openSeason.mockResolvedValue(null);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(result.opened).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test("opens a recovery season using the leaderboard's real next number, not always 1", async () => {
    // A leaderboard with prior season history (e.g. seasons 1-3 already
    // exist, none ACTIVE) must resume at 4, not collide against season 1
    // forever.
    deps.findEnabledLeaderboardsWithoutActiveSeason.mockResolvedValue([leaderboard()]);
    deps.findNextSeasonNumber.mockResolvedValue(4);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.openSeason).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaderboardId: "lb_1",
        seasonNumber: 4,
      }),
    );
  });

  test("closing a season audits the close inside the transaction", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "prj_1",
        action: "leaderboard_season.closed",
        resource: "leaderboard_season",
        resourceId: "sea_1",
      }),
      expect.anything(),
    );
  });

  test("one leaderboard's close throwing does not abort the others in the same sweep", async () => {
    // Regression: closeDueSeasons had no per-season error isolation (its
    // sibling openFirstSeasons already did), so a single bad leaderboard
    // — e.g. a cadence/timezone combination that throws building the
    // next window, or a transaction failure — threw out of the `for`
    // loop and aborted every remaining leaderboard's close in the sweep,
    // failing the whole BullMQ job.
    const seasonA = season({ id: "sea_1", leaderboardId: "lb_1" });
    const seasonB = season({ id: "sea_2", leaderboardId: "lb_2" });
    deps.findDueSeasons.mockResolvedValue([seasonA, seasonB]);

    deps.findLeaderboardById.mockImplementation(
      async (_db: unknown, leaderboardId: string) =>
        leaderboard({ id: leaderboardId, projectId: `prj_${leaderboardId}` }),
    );

    let transactionCalls = 0;
    deps.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          // Simulates a real failure inside the claim/snapshot/close
          // transaction for the FIRST due season.
          throw new Error("boom: simulated postgres failure closing sea_1");
        }
        return fn({});
      },
    );

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    // The second leaderboard's close still went through...
    expect(result.closed).toBe(1);
    expect(deps.claimSeasonForClose).toHaveBeenCalledWith(
      expect.anything(),
      "sea_2",
      NOW,
    );
    // ...and the first leaderboard's failure is reported as a skip, never
    // swallowed and never thrown back out of the sweep.
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  test("a successor season that fails to open inside the close transaction is a distinct signal, not a plain close", async () => {
    // The claim succeeds (season DOES close) but the "open next" insert
    // inside the SAME transaction loses — e.g. another writer already
    // holds that (leaderboardId, seasonNumber). That must never look like
    // an ordinary successful close with nothing to report: it must be
    // counted under its own reason, not folded into "race" (which means
    // "the close itself was lost") or dropped silently.
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.openSeason.mockResolvedValue(null);

    const incSpy = vi.spyOn(leaderboardSeasonCloseSkippedTotal, "inc");

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(result.closed).toBe(1);

    const reasons = incSpy.mock.calls.map(
      (call) => (call[0] as { reason?: string } | undefined)?.reason,
    );
    expect(reasons).not.toContain("race");
    expect(reasons.some((r) => r !== undefined && r !== "race")).toBe(true);

    incSpy.mockRestore();
  });
});
