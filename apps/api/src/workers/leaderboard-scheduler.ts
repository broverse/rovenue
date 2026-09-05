import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { drizzle, type Db, type LeaderboardMetric } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit, type AuditEntry, type AuditTx } from "../lib/audit";
import {
  leaderboardSeasonsOpenedTotal,
  leaderboardSeasonsClosedTotal,
  leaderboardSeasonCloseSkippedTotal,
} from "../lib/metrics";
import {
  nextSeasonWindow,
  seasonWindowContaining,
} from "../services/leaderboards/cadence";
import {
  queryStandings as queryStandingsFromClickhouse,
  type StandingRow,
} from "../services/leaderboards/standings-query";

// =============================================================
// Leaderboard season scheduler (ROADMAP §12 item 3, Task 4)
// =============================================================
//
// Repeatable BullMQ job that, per sweep:
//
//   1. Opens a first season for every enabled leaderboard that
//      currently has none (brand new, or the previous season was
//      closed by a PRIOR sweep and its own "open the next one"
//      insert lost a race — this branch is what heals that gap).
//
//   2. Closes every ACTIVE season whose (exclusive) `endsAt` plus
//      LEADERBOARD_SNAPSHOT_SETTLE_MS has passed. Order matters:
//
//        a. Query ClickHouse FIRST. Nothing is written yet, so a
//           failure here is a plain retry on the next sweep: log,
//           count it, leave the season ACTIVE, move on.
//        b. Only then, in ONE Postgres transaction: claim the
//           season with the conditional UPDATE (a zero-row result
//           means another replica won — abandon the transaction),
//           insert the standings, audit the close, and open the
//           next season starting exactly at the old `endsAt`.
//
//      Claiming before querying would leave a season marked CLOSED
//      with no standings whenever ClickHouse is unavailable,
//      recoverable only by a compensating write that un-closes it.
//      Querying first removes that state entirely: either the whole
//      close commits, or nothing did.
//
// The settle delay only changes WHEN the numbers freeze, never
// WHICH events they include: the next season still starts exactly
// at the old season's `endsAt`, so no event can fall between two
// seasons — only the moment the scheduler is willing to snapshot
// the old one is pushed back, to let Kafka-fed ClickHouse catch up.
//
// Modeled on workers/experiment-scheduler.ts: repeatable BullMQ job,
// its own queue name + repeatable job id, a pure sweep function with
// injected dependencies, `audit()` run inside the transaction.

const log = logger.child("leaderboard-scheduler");

export const LEADERBOARD_SCHEDULER_QUEUE_NAME = "rovenue-leaderboard-scheduler";
const REPEATABLE_JOB_NAME = "leaderboard-scheduler:sweep";
const REPEATABLE_JOB_ID = "leaderboard-scheduler-repeatable";

// ClickHouse is fed asynchronously through Kafka/the outbox — snapshotting
// at the instant a season ends would freeze standings before the last few
// events land. Close only once endsAt + this delay has passed.
export const LEADERBOARD_SNAPSHOT_SETTLE_MS = 5 * 60 * 1000;

// How often the sweep runs.
export const LEADERBOARD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Fallback row cap for a season snapshot when a leaderboard row somehow
// carries no entryLimit (the column has a DB-level default, so this is a
// belt-and-suspenders guard, not the normal path).
export const LEADERBOARD_DEFAULT_ENTRY_LIMIT = 100;

const FIRST_SEASON_NUMBER = 1;

// leaderboardSeasonCloseSkippedTotal reason labels.
const SKIP_REASON_CLICKHOUSE = "clickhouse";
const SKIP_REASON_RACE = "race";
const SKIP_REASON_MISSING_LEADERBOARD = "missing-leaderboard";
const SKIP_REASON_ERROR = "error";

export interface SchedulerSweepResult {
  opened: number;
  closed: number;
  skipped: number;
}

type LeaderboardRow = typeof drizzle.schema.leaderboards.$inferSelect;
type LeaderboardSeasonRow = typeof drizzle.schema.leaderboardSeasons.$inferSelect;
type StandingInput = Parameters<typeof drizzle.leaderboardRepo.insertStandings>[2][number];
type OpenSeasonInput = Parameters<typeof drizzle.leaderboardRepo.openSeason>[1];

export interface SchedulerDeps {
  findEnabledLeaderboardsWithoutActiveSeason: (
    db: Db,
  ) => Promise<LeaderboardRow[]>;
  findDueSeasons: (db: Db, closeBefore: Date) => Promise<LeaderboardSeasonRow[]>;
  findLeaderboardById: (db: Db, id: string) => Promise<LeaderboardRow | null>;
  queryStandings: typeof queryStandingsFromClickhouse;
  claimSeasonForClose: (
    db: Db,
    seasonId: string,
    now: Date,
  ) => Promise<LeaderboardSeasonRow | null>;
  insertStandings: (
    db: Db,
    seasonId: string,
    rows: StandingInput[],
  ) => Promise<void>;
  openSeason: (
    db: Db,
    input: OpenSeasonInput,
  ) => Promise<LeaderboardSeasonRow | null>;
  audit: (entry: AuditEntry, tx?: AuditTx) => Promise<void>;
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: SchedulerDeps = {
  findEnabledLeaderboardsWithoutActiveSeason:
    drizzle.leaderboardRepo.findEnabledLeaderboardsWithoutActiveSeason,
  findDueSeasons: drizzle.leaderboardRepo.findDueSeasons,
  findLeaderboardById: drizzle.leaderboardRepo.findLeaderboardById,
  queryStandings: queryStandingsFromClickhouse,
  claimSeasonForClose: drizzle.leaderboardRepo.claimSeasonForClose,
  insertStandings: drizzle.leaderboardRepo.insertStandings,
  openSeason: drizzle.leaderboardRepo.openSeason,
  audit,
  transaction: (fn) =>
    drizzle.db.transaction((tx) => fn(tx as unknown as Db)),
};

/**
 * Opens a first season for every enabled leaderboard currently without an
 * ACTIVE one. A lost insert (`openSeason` returns null — another replica
 * won, or a stale row from before this leaderboard's last season) is
 * counted as skipped, never thrown: the next sweep's read of
 * `findEnabledLeaderboardsWithoutActiveSeason` is authoritative, so a
 * missed open here is simply retried, not lost.
 */
async function openFirstSeasons(
  now: Date,
  deps: SchedulerDeps,
): Promise<{ opened: number; skipped: number }> {
  const candidates = await deps.findEnabledLeaderboardsWithoutActiveSeason(
    drizzle.db,
  );

  let opened = 0;
  let skipped = 0;

  for (const leaderboard of candidates) {
    try {
      const window = seasonWindowContaining(
        now,
        leaderboard.cadence,
        leaderboard.timezone,
        leaderboard.customPeriodDays,
        leaderboard.anchorAt,
      );

      const openedSeason = await deps.openSeason(drizzle.db, {
        leaderboardId: leaderboard.id,
        seasonNumber: FIRST_SEASON_NUMBER,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      });

      if (!openedSeason) {
        skipped += 1;
        leaderboardSeasonCloseSkippedTotal.inc({ reason: SKIP_REASON_RACE });
        continue;
      }

      opened += 1;
      leaderboardSeasonsOpenedTotal.inc();
    } catch (err) {
      log.error("failed to open first season", {
        leaderboardId: leaderboard.id,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
      leaderboardSeasonCloseSkippedTotal.inc({ reason: SKIP_REASON_ERROR });
    }
  }

  return { opened, skipped };
}

/**
 * Closes every ACTIVE season whose settled `endsAt` has passed. See the
 * module doc comment above for why ClickHouse is queried before anything
 * is claimed or written.
 */
async function closeDueSeasons(
  now: Date,
  deps: SchedulerDeps,
): Promise<{ opened: number; closed: number; skipped: number }> {
  const closeBefore = new Date(now.getTime() - LEADERBOARD_SNAPSHOT_SETTLE_MS);
  const dueSeasons = await deps.findDueSeasons(drizzle.db, closeBefore);

  let opened = 0;
  let closed = 0;
  let skipped = 0;

  for (const season of dueSeasons) {
    const leaderboard = await deps.findLeaderboardById(
      drizzle.db,
      season.leaderboardId,
    );
    if (!leaderboard) {
      log.error("due season references a missing leaderboard, skipping", {
        seasonId: season.id,
        leaderboardId: season.leaderboardId,
      });
      skipped += 1;
      leaderboardSeasonCloseSkippedTotal.inc({
        reason: SKIP_REASON_MISSING_LEADERBOARD,
      });
      continue;
    }

    // 1. Query ClickHouse FIRST. Nothing is written yet, so a failure
    // here is a plain retry: leave the season ACTIVE, pick it up next
    // sweep.
    let standings: StandingRow[];
    try {
      standings = await deps.queryStandings({
        projectId: leaderboard.projectId,
        metric: leaderboard.metric as LeaderboardMetric,
        currencyId: leaderboard.currencyId,
        startsAt: season.startsAt,
        endsAt: season.endsAt,
        limit: leaderboard.entryLimit ?? LEADERBOARD_DEFAULT_ENTRY_LIMIT,
      });
    } catch (err) {
      leaderboardSeasonCloseSkippedTotal.inc({ reason: SKIP_REASON_CLICKHOUSE });
      log.warn("standings query failed, leaving season ACTIVE", {
        seasonId: season.id,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
      continue;
    }

    const next = nextSeasonWindow(
      { startsAt: season.startsAt, endsAt: season.endsAt },
      leaderboard.cadence,
      leaderboard.timezone,
      leaderboard.customPeriodDays,
      leaderboard.anchorAt,
    );

    // 2. Claim + snapshot + close + open-next, all in ONE transaction.
    const claimedSeason = await deps.transaction(async (tx) => {
      const claimed = await deps.claimSeasonForClose(tx, season.id, now);
      if (!claimed) return null; // another replica won the claim

      await deps.insertStandings(
        tx,
        claimed.id,
        standings.map((row, index) => ({ rank: index + 1, ...row })),
      );

      await deps.audit(
        {
          projectId: leaderboard.projectId,
          userId: "system",
          action: "leaderboard_season.closed",
          resource: "leaderboard_season",
          resourceId: claimed.id,
          before: { status: "ACTIVE" },
          after: { status: "CLOSED", standingsCount: standings.length },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );

      // Open the next season starting exactly at the old endsAt, so no
      // event can ever fall between two seasons. A lost race here is not
      // fatal — openFirstSeasons' next-sweep read heals the gap.
      const openedNext = await deps.openSeason(tx, {
        leaderboardId: season.leaderboardId,
        seasonNumber: season.seasonNumber + 1,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
      });
      if (openedNext) {
        opened += 1;
        leaderboardSeasonsOpenedTotal.inc();
      }

      return claimed;
    });

    if (!claimedSeason) {
      skipped += 1;
      leaderboardSeasonCloseSkippedTotal.inc({ reason: SKIP_REASON_RACE });
      continue;
    }

    closed += 1;
    leaderboardSeasonsClosedTotal.inc();
  }

  return { opened, closed, skipped };
}

export async function sweepLeaderboardSeasons(
  now: Date,
  deps: SchedulerDeps = defaultDeps,
): Promise<SchedulerSweepResult> {
  const firstSeasons = await openFirstSeasons(now, deps);
  const closes = await closeDueSeasons(now, deps);

  const result: SchedulerSweepResult = {
    opened: firstSeasons.opened + closes.opened,
    closed: closes.closed,
    skipped: firstSeasons.skipped + closes.skipped,
  };

  if (result.opened > 0 || result.closed > 0) {
    log.info("leaderboard season scheduler sweep", { ...result });
  }
  return result;
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getLeaderboardSchedulerQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(LEADERBOARD_SCHEDULER_QUEUE_NAME, {
    connection: createBullConnection("leaderboard-scheduler"),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Registers the repeatable sweep job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleLeaderboardScheduler(): Promise<void> {
  const queue = getLeaderboardSchedulerQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: LEADERBOARD_SWEEP_INTERVAL_MS },
    },
  );
  log.info("leaderboard scheduler sweep registered", {
    everyMs: LEADERBOARD_SWEEP_INTERVAL_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createLeaderboardSchedulerWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    LEADERBOARD_SCHEDULER_QUEUE_NAME,
    async (_job: Job) => {
      return sweepLeaderboardSeasons(new Date());
    },
    {
      connection: createBullConnection("leaderboard-scheduler"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("leaderboard scheduler sweep job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}

/**
 * Single entry point for boot wiring: creates the worker and, unless
 * `autoStart` is explicitly false, registers the repeatable job.
 */
export function ensureLeaderboardScheduler(
  opts: { autoStart?: boolean } = {},
): void {
  createLeaderboardSchedulerWorker();
  if (opts.autoStart === false) return;

  scheduleLeaderboardScheduler().catch((err: unknown) => {
    log.error("failed to schedule leaderboard scheduler", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
