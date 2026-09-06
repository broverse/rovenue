// =============================================================
// leaderboard-scheduler — real-infra integration tests
// =============================================================
//
// ROADMAP §12 item 3, Task 6. The unit tests in
// leaderboard-scheduler.test.ts mock every dependency, so they prove the
// sweep's *logic* (call order, which branch fires). They cannot prove the
// partial unique index (`leaderboard_seasons_one_active_idx`) actually
// rejects a second concurrent insert, or that the close transaction really
// rolls back on a ClickHouse failure. Only a real Postgres + ClickHouse can
// prove that, which is what this file is for.
//
// Test harness: this repo has no per-file testcontainers bootstrap and no
// withTestDb/seedProject helper. apps/api/tests/setup.ts points the suite
// at the ambient docker-compose dev stack (Postgres 5433, Redis 6380,
// Redpanda 19092, ClickHouse 8124) and repoints DATABASE_URL at a
// per-worker clone of a migrated template. Fixtures below are seeded with
// direct Drizzle inserts / a direct ClickHouse insert() call — never by
// calling sweepLeaderboardSeasons itself — so a passing assertion means the
// sweep agrees with an independently-built baseline, not with itself.
// Follows apps/api/src/workers/access-reconciliation.integration.test.ts
// and apps/api/src/workers/experiment-scheduler.integration.test.ts.
//
// This file starts no container of its own (no testcontainers Redpanda or
// ClickHouse) — it reads/writes the ambient ClickHouse and Postgres — so
// unlike tests/ch-kafka-engine.integration.test.ts and friends it needs no
// CONTAINER_SUITES registration in vitest.config.ts and pins no host port
// in tests/host-port-allocations.test.ts (that registry only tracks fixed
// ports a testcontainers-started broker/ClickHouse advertises on).
//
// It also creates no BullMQ Queue/Worker and no Kafka consumer group: every
// case below calls the pure `sweepLeaderboardSeasons(now)` directly (same
// pattern as runExperimentSchedulerSweep in experiment-scheduler.integration
// .test.ts), so there is no queue name for it to collide on with the three
// files noted in the task brief.
//
// DateTime64(3) coverage: "standings freeze the in-window events only"
// below seeds ClickHouse rows exactly 1ms either side of the season's
// startsAt/endsAt (themselves plain JS Date objects bound as ClickHouse
// query params) and asserts the frozen sum reflects only the two in-window
// events. Nothing before this task inserted real rows and read them back
// through the real half-open-window query, so this is the first genuine
// exercise of Date -> DateTime64(3) round-tripping for this feature.
//
// ClickHouse gotchas (from the brief): production SQL in standings-query.ts
// already writes `raw_revenue_events FINAL` (no alias needed for this
// table), never `FINAL AS e`. The ClickHouse client singleton in
// lib/clickhouse.ts reads a snapshot of `env` at first use, so the
// ClickHouse-failure case mutates the shared `env` object in place and
// calls `__resetClickHouseForTests()` to force a reconnect — reassigning
// `process.env.CLICKHOUSE_URL` after `env` has already been parsed would be
// silently ignored.

import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { __resetClickHouseForTests, getClickHouseClient } from "../lib/clickhouse";
import { seasonWindowContaining } from "../services/leaderboards/cadence";
import {
  LEADERBOARD_SNAPSHOT_SETTLE_MS,
  sweepLeaderboardSeasons,
} from "./leaderboard-scheduler";

// getDb() is called per use, never captured at module scope: tests/setup.ts
// repoints DATABASE_URL at this worker's own cloned database, and a
// module-scope handle can be built before that assignment lands, which
// makes the file fail under parallel workers while passing alone.
// access-reconciliation.integration.test.ts follows the same rule.
const schema = drizzle.schema;

const RUN_ID = Date.now();
let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

// -------------------------------------------------------------
// Constants (no magic values)
// -------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
// Arbitrary fixed point in the past. Only its date matters for CUSTOM
// cadence math (see cadence.ts's customWindowContaining, which counts
// whole local days from the anchor) -- with customPeriodDays = 1, every
// UTC midnight is a valid boundary regardless of which one we pick here.
const ANCHOR_AT = new Date("2020-01-01T00:00:00.000Z");
// A settle-past buffer added on top of LEADERBOARD_SNAPSHOT_SETTLE_MS so a
// "now" built from Date.now() at test-run time is unambiguously due,
// independent of how long earlier setup took.
const SETTLE_PAST_BUFFER_MS = 60_000;
// A dead loopback address: nothing listens on port 1, so a client-side
// connect is refused immediately rather than timing out.
const DEAD_CLICKHOUSE_URL = "http://127.0.0.1:1";

// Property 3 (window-freeze) amounts, named for what side of the boundary
// each event sits on.
const BEFORE_WINDOW_AMOUNT_USD = 1000;
const AT_START_AMOUNT_USD = 7;
const JUST_BEFORE_END_AMOUNT_USD = 3;
const AT_END_AMOUNT_USD = 2000;
const AFTER_WINDOW_AMOUNT_USD = 5000;
const EXPECTED_IN_WINDOW_SCORE = AT_START_AMOUNT_USD + JUST_BEFORE_END_AMOUNT_USD;
const EXPECTED_IN_WINDOW_EVENT_COUNT = 2;

function truncateToUtcMidnight(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

// ClickHouse DateTime64(3) wants "YYYY-MM-DD HH:MM:SS.mmm" -- no T/Z.
// Matches the convention already used by digest-scheduler.integration.test.ts
// and routes/dashboard/credits.integration.test.ts.
function toChDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

interface RawRevenueRow {
  eventId: string;
  revenueEventId: string;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: string;
  store: string;
  amount: string;
  amountUsd: string;
  currency: string;
  eventDate: string;
  ingestedAt: string;
  _version: number;
}

function revenueRow(input: {
  projectId: string;
  subscriberId: string;
  amountUsd: number;
  eventDate: Date;
}): RawRevenueRow {
  return {
    eventId: createId(),
    revenueEventId: createId(),
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    purchaseId: createId(),
    productId: `prod_lbsched_${RUN_ID}`,
    type: "INITIAL",
    store: "ios",
    amount: input.amountUsd.toFixed(4),
    amountUsd: input.amountUsd.toFixed(4),
    currency: "USD",
    eventDate: toChDateTime(input.eventDate),
    ingestedAt: toChDateTime(new Date()),
    _version: Date.now(),
  };
}

async function insertRevenueRows(rows: RawRevenueRow[]): Promise<void> {
  const ch = getClickHouseClient();
  await ch.insert({
    table: "raw_revenue_events",
    values: rows,
    format: "JSONEachRow",
  });
}

async function seedProject(): Promise<string> {
  const [proj] = await getDb()
    .insert(schema.projects)
    .values({ name: `Leaderboard Scheduler Test ${nextSuffix()}` })
    .returning();
  if (!proj) throw new Error("seedProject: no row returned");
  return proj.id;
}

interface SeededLeaderboard {
  id: string;
  projectId: string;
}

/**
 * CUSTOM cadence, 1-day period, UTC. Chosen so every UTC midnight is a
 * valid season boundary regardless of `anchorAt`'s phase, which lets each
 * test pick whatever startsAt/endsAt it needs without fighting the cadence
 * arithmetic under test elsewhere (Task 2).
 */
async function seedLeaderboard(
  projectId: string,
  overrides: Partial<typeof schema.leaderboards.$inferInsert> = {},
): Promise<SeededLeaderboard> {
  const s = nextSuffix();
  const [row] = await getDb()
    .insert(schema.leaderboards)
    .values({
      projectId,
      identifier: `lb_${s}`,
      name: `Leaderboard ${s}`,
      metric: "TOP_SPENDERS",
      currencyId: null,
      cadence: "CUSTOM",
      customPeriodDays: 1,
      timezone: "UTC",
      entryLimit: 100,
      anchorAt: ANCHOR_AT,
      isEnabled: true,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedLeaderboard: no row returned");
  return { id: row.id, projectId: row.projectId };
}

/**
 * Inserts an ACTIVE season row directly -- never through openSeason, the
 * function under test -- so "the sweep found a due season" is an
 * assertion about the sweep, not a tautology.
 */
async function seedActiveSeason(input: {
  leaderboardId: string;
  seasonNumber: number;
  startsAt: Date;
  endsAt: Date;
}): Promise<string> {
  const [row] = await getDb()
    .insert(schema.leaderboardSeasons)
    .values({
      leaderboardId: input.leaderboardId,
      seasonNumber: input.seasonNumber,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "ACTIVE",
    })
    .returning();
  if (!row) throw new Error("seedActiveSeason: no row returned");
  return row.id;
}

async function seasonsFor(leaderboardId: string) {
  return getDb()
    .select()
    .from(schema.leaderboardSeasons)
    .where(eq(schema.leaderboardSeasons.leaderboardId, leaderboardId))
    .orderBy(asc(schema.leaderboardSeasons.seasonNumber));
}

async function standingsFor(seasonId: string) {
  return getDb()
    .select()
    .from(schema.leaderboardStandings)
    .where(eq(schema.leaderboardStandings.seasonId, seasonId))
    .orderBy(asc(schema.leaderboardStandings.rank));
}

let chEnvBroken = false;

// Belt-and-suspenders: if a mid-test assertion throws while the
// ClickHouse env is pointed at the dead address, restore it so this file
// (and anything sharing this worker's process afterwards) doesn't keep
// resolving to a dead client.
afterAll(() => {
  if (chEnvBroken) {
    const mEnv = env as unknown as { CLICKHOUSE_URL?: string };
    mEnv.CLICKHOUSE_URL = "http://localhost:8124";
    __resetClickHouseForTests();
  }
});

describe.sequential("leaderboard scheduler against a real database", () => {
  it("two concurrent sweeps open exactly one season", async () => {
    const projectId = await seedProject();
    const lb = await seedLeaderboard(projectId);
    const now = new Date();

    await Promise.all([sweepLeaderboardSeasons(now), sweepLeaderboardSeasons(now)]);

    // Assert on the final DB state, not on which sweep's own counters
    // report the open: the second sweep can legitimately see zero
    // candidates at all (if the first one's insert already committed by
    // the time it queries), which is just as valid a race resolution as
    // losing the unique-index conflict. Either way the constraint IS what
    // guarantees the outcome below, so that's what gets asserted --
    // mirrors experiment-scheduler.integration.test.ts's "(2) two
    // concurrent sweeps" case.
    const seasons = await seasonsFor(lb.id);
    expect(seasons).toHaveLength(1);

    const [season] = seasons;
    expect(season?.status).toBe("ACTIVE");
    expect(season?.seasonNumber).toBe(1);

    // Positive outcome, not just "exactly one row": the window it opened
    // is the one the cadence math actually says contains `now`.
    const expectedWindow = seasonWindowContaining(now, "CUSTOM", "UTC", 1, ANCHOR_AT);
    expect(season?.startsAt?.getTime()).toBe(expectedWindow.startsAt.getTime());
    expect(season?.endsAt?.getTime()).toBe(expectedWindow.endsAt.getTime());
  });

  it("two concurrent sweeps close a due season exactly once", async () => {
    const projectId = await seedProject();
    const lb = await seedLeaderboard(projectId);

    const todayMidnight = truncateToUtcMidnight(new Date());
    const seasonStart = new Date(todayMidnight.getTime() - 2 * DAY_MS);
    const seasonEnd = new Date(todayMidnight.getTime() - 1 * DAY_MS);
    const seasonId = await seedActiveSeason({
      leaderboardId: lb.id,
      seasonNumber: 1,
      startsAt: seasonStart,
      endsAt: seasonEnd,
    });

    // Two subscribers with distinct spend, both inside [seasonStart,
    // seasonEnd), so the frozen standings have more than one rank to
    // check for duplicates.
    const bigSpenderId = `sub_close_big_${nextSuffix()}`;
    const smallSpenderId = `sub_close_small_${nextSuffix()}`;
    const midWindow = new Date(seasonStart.getTime() + 60 * 60 * 1000);
    await insertRevenueRows([
      revenueRow({ projectId, subscriberId: bigSpenderId, amountUsd: 50, eventDate: midWindow }),
      revenueRow({ projectId, subscriberId: smallSpenderId, amountUsd: 30, eventDate: midWindow }),
    ]);

    const now = new Date(seasonEnd.getTime() + LEADERBOARD_SNAPSHOT_SETTLE_MS + SETTLE_PAST_BUFFER_MS);

    await Promise.all([sweepLeaderboardSeasons(now), sweepLeaderboardSeasons(now)]);

    const seasons = await seasonsFor(lb.id);
    expect(seasons).toHaveLength(2);

    // Positive outcome #1: the original season really is CLOSED (not just
    // "no longer 2 ACTIVE rows").
    const closed = seasons.filter((s) => s.status === "CLOSED");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.id).toBe(seasonId);
    expect(closed[0]?.seasonNumber).toBe(1);
    expect(closed[0]?.closedAt).not.toBeNull();

    // Positive outcome #2: standings really were written, and are a
    // single consistent set -- no duplicate ranks, which is what two
    // sweeps both winning the insert would produce.
    const standings = await standingsFor(seasonId);
    expect(standings).toHaveLength(2);
    const ranks = standings.map((s) => s.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks.sort()).toEqual([1, 2]);
    expect(standings.map((s) => s.subscriberId).sort()).toEqual(
      [bigSpenderId, smallSpenderId].sort(),
    );
    // Ranked correctly: the bigger spender is rank 1.
    expect(standings.find((s) => s.rank === 1)?.subscriberId).toBe(bigSpenderId);

    // Positive outcome #3: exactly one new ACTIVE season, starting
    // exactly at the old endsAt so no event can fall between the two.
    const active = seasons.filter((s) => s.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]?.seasonNumber).toBe(2);
    expect(active[0]?.startsAt?.getTime()).toBe(seasonEnd.getTime());
  });

  it("standings freeze the in-window events only", async () => {
    const projectId = await seedProject();
    const lb = await seedLeaderboard(projectId);

    const todayMidnight = truncateToUtcMidnight(new Date());
    // A day-long window well clear of the other cases' date ranges.
    const seasonStart = new Date(todayMidnight.getTime() - 5 * DAY_MS);
    const seasonEnd = new Date(todayMidnight.getTime() - 4 * DAY_MS);
    const seasonId = await seedActiveSeason({
      leaderboardId: lb.id,
      seasonNumber: 1,
      startsAt: seasonStart,
      endsAt: seasonEnd,
    });

    const subscriberId = `sub_window_${nextSuffix()}`;

    // Events straddle both boundaries with millisecond precision, which is
    // what actually exercises Date -> ClickHouse DateTime64(3) round-tripping:
    // a truncated or shifted millisecond component would silently move an
    // event across `>=`/`<` and this test would catch it, where a
    // second-granularity fixture would not.
    await insertRevenueRows([
      // Before the window: 1ms before startsAt.
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: BEFORE_WINDOW_AMOUNT_USD,
        eventDate: new Date(seasonStart.getTime() - 1),
      }),
      // Exactly at startsAt -- inclusive start.
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: AT_START_AMOUNT_USD,
        eventDate: seasonStart,
      }),
      // 1ms before endsAt -- still inside the half-open window.
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: JUST_BEFORE_END_AMOUNT_USD,
        eventDate: new Date(seasonEnd.getTime() - 1),
      }),
      // Exactly at endsAt -- exclusive end, must NOT count.
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: AT_END_AMOUNT_USD,
        eventDate: seasonEnd,
      }),
      // Well after the window.
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: AFTER_WINDOW_AMOUNT_USD,
        eventDate: new Date(seasonEnd.getTime() + DAY_MS),
      }),
    ]);

    const now = new Date(seasonEnd.getTime() + LEADERBOARD_SNAPSHOT_SETTLE_MS + SETTLE_PAST_BUFFER_MS);
    const result = await sweepLeaderboardSeasons(now);
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const standings = await standingsFor(seasonId);
    // Exactly one subscriber row -- proves the settle delay changed WHEN
    // the snapshot ran, not WHICH events it saw: if the window leaked
    // either side, the sum below would be wrong even though the row count
    // stayed at one.
    expect(standings).toHaveLength(1);
    expect(standings[0]?.subscriberId).toBe(subscriberId);
    expect(Number(standings[0]?.score)).toBe(EXPECTED_IN_WINDOW_SCORE);
    expect(standings[0]?.eventCount).toBe(EXPECTED_IN_WINDOW_EVENT_COUNT);
  });

  it("a ClickHouse failure mid-close leaves the season ACTIVE with no standings", async () => {
    const projectId = await seedProject();
    const lb = await seedLeaderboard(projectId);

    const todayMidnight = truncateToUtcMidnight(new Date());
    const seasonStart = new Date(todayMidnight.getTime() - 7 * DAY_MS);
    const seasonEnd = new Date(todayMidnight.getTime() - 6 * DAY_MS);
    const seasonId = await seedActiveSeason({
      leaderboardId: lb.id,
      seasonNumber: 1,
      startsAt: seasonStart,
      endsAt: seasonEnd,
    });

    const subscriberId = `sub_chfail_${nextSuffix()}`;
    await insertRevenueRows([
      revenueRow({
        projectId,
        subscriberId,
        amountUsd: 42,
        eventDate: new Date(seasonStart.getTime() + 60 * 60 * 1000),
      }),
    ]);

    const now = new Date(seasonEnd.getTime() + LEADERBOARD_SNAPSHOT_SETTLE_MS + SETTLE_PAST_BUFFER_MS);

    // lib/clickhouse.ts's client singleton reads a snapshot of `env` at
    // first use -- mutate the shared object in place (never reassign
    // process.env after import; the client would never see it) and force
    // a reconnect so the next query actually dials the dead address.
    const mEnv = env as unknown as { CLICKHOUSE_URL?: string };
    const originalClickhouseUrl = mEnv.CLICKHOUSE_URL;
    mEnv.CLICKHOUSE_URL = DEAD_CLICKHOUSE_URL;
    chEnvBroken = true;
    __resetClickHouseForTests();

    let failedResult;
    try {
      failedResult = await sweepLeaderboardSeasons(now);
    } finally {
      mEnv.CLICKHOUSE_URL = originalClickhouseUrl;
      __resetClickHouseForTests();
      chEnvBroken = false;
    }

    // Prove the sweep actually ran and chose to skip -- "no standings"
    // alone would also be true if the sweep never executed at all.
    expect(failedResult.closed).toBe(0);
    expect(failedResult.skipped).toBeGreaterThanOrEqual(1);

    const [seasonAfterFailure] = await getDb()
      .select()
      .from(schema.leaderboardSeasons)
      .where(eq(schema.leaderboardSeasons.id, seasonId));
    expect(seasonAfterFailure?.status).toBe("ACTIVE");
    expect(seasonAfterFailure?.closedAt).toBeNull();
    await expect(standingsFor(seasonId)).resolves.toHaveLength(0);

    // A later, healthy sweep closes it correctly -- proves the failure
    // above was transient state, not permanent corruption.
    const healthyResult = await sweepLeaderboardSeasons(now);
    expect(healthyResult.closed).toBeGreaterThanOrEqual(1);

    const seasons = await seasonsFor(lb.id);
    const closed = seasons.filter((s) => s.status === "CLOSED");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.id).toBe(seasonId);

    const standings = await standingsFor(seasonId);
    expect(standings).toHaveLength(1);
    expect(standings[0]?.subscriberId).toBe(subscriberId);
    expect(Number(standings[0]?.score)).toBe(42);

    const active = seasons.filter((s) => s.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]?.seasonNumber).toBe(2);
  });
});
