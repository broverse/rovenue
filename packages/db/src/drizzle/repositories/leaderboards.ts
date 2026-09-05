import { and, asc, desc, eq, lte, max, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  leaderboards,
  leaderboardSeasons,
  leaderboardStandings,
  type Leaderboard,
  type LeaderboardSeason,
  type LeaderboardStanding,
} from "../schema";
import { leaderboardCadence, leaderboardMetric } from "../enums";

// DB or Drizzle tx handle — writes accept either.
type DbOrTx = Db;

type LeaderboardMetric = (typeof leaderboardMetric.enumValues)[number];
type LeaderboardCadence = (typeof leaderboardCadence.enumValues)[number];

// =============================================================
// leaderboards — Drizzle repository
// =============================================================

export async function listLeaderboards(
  db: Db,
  projectId: string,
): Promise<Leaderboard[]> {
  return db
    .select()
    .from(leaderboards)
    .where(eq(leaderboards.projectId, projectId))
    .orderBy(asc(leaderboards.name));
}

export async function findLeaderboardById(
  db: Db,
  id: string,
): Promise<Leaderboard | null> {
  const rows = await db
    .select()
    .from(leaderboards)
    .where(eq(leaderboards.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateLeaderboardInput {
  projectId: string;
  identifier: string;
  name: string;
  metric: LeaderboardMetric;
  // Only meaningful for TOP_CONSUMERS. Null = every currency.
  currencyId?: string | null;
  cadence: LeaderboardCadence;
  customPeriodDays?: number | null;
  timezone?: string;
  entryLimit?: number;
  anchorAt: Date;
  isEnabled?: boolean;
}

export async function createLeaderboard(
  db: DbOrTx,
  input: CreateLeaderboardInput,
): Promise<Leaderboard> {
  const rows = await db
    .insert(leaderboards)
    .values({
      projectId: input.projectId,
      identifier: input.identifier,
      name: input.name,
      metric: input.metric,
      currencyId: input.currencyId ?? null,
      cadence: input.cadence,
      customPeriodDays: input.customPeriodDays ?? null,
      timezone: input.timezone ?? "UTC",
      entryLimit: input.entryLimit ?? 100,
      anchorAt: input.anchorAt,
      isEnabled: input.isEnabled ?? true,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create leaderboard");
  return row;
}

export interface UpdateLeaderboardInput {
  name?: string;
  currencyId?: string | null;
  entryLimit?: number;
  timezone?: string;
  isEnabled?: boolean;
}

export async function updateLeaderboard(
  db: DbOrTx,
  id: string,
  patch: UpdateLeaderboardInput,
): Promise<Leaderboard | null> {
  const data: Partial<typeof leaderboards.$inferInsert> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.currencyId !== undefined) data.currencyId = patch.currencyId;
  if (patch.entryLimit !== undefined) data.entryLimit = patch.entryLimit;
  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.isEnabled !== undefined) data.isEnabled = patch.isEnabled;
  if (Object.keys(data).length === 0) return null;
  data.updatedAt = new Date();
  const rows = await db
    .update(leaderboards)
    .set(data)
    .where(eq(leaderboards.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteLeaderboard(db: DbOrTx, id: string): Promise<void> {
  await db.delete(leaderboards).where(eq(leaderboards.id, id));
}

/**
 * Enabled leaderboards that currently have no ACTIVE season row. Used by
 * the season scheduler to find leaderboards that need a season opened —
 * either brand new, or the previous season was just closed by the same
 * sweep.
 */
export async function findEnabledLeaderboardsWithoutActiveSeason(
  db: Db,
): Promise<Leaderboard[]> {
  return db
    .select()
    .from(leaderboards)
    .where(
      and(
        eq(leaderboards.isEnabled, true),
        sql`NOT EXISTS (
          SELECT 1 FROM "leaderboard_seasons"
          WHERE "leaderboard_seasons"."leaderboardId" = "leaderboards"."id"
            AND "leaderboard_seasons"."status" = 'ACTIVE'
        )`,
      ),
    );
}

/**
 * ACTIVE seasons whose (exclusive) end has already passed `closeBefore`.
 * Used by the scheduler to find seasons due for closing; `statusEndsAtIdx`
 * covers this query.
 */
export async function findDueSeasons(
  db: Db,
  closeBefore: Date,
): Promise<LeaderboardSeason[]> {
  return db
    .select()
    .from(leaderboardSeasons)
    .where(
      and(
        eq(leaderboardSeasons.status, "ACTIVE"),
        lte(leaderboardSeasons.endsAt, closeBefore),
      ),
    );
}

/**
 * Next season number for a leaderboard, derived from its history rather
 * than assumed. Used by the scheduler's "open a first/recovery season"
 * path so a leaderboard that already has season rows (e.g. its previous
 * close's own "open next" lost a race and needs retrying next sweep)
 * doesn't collide forever against a hardcoded `1`.
 */
export async function findNextSeasonNumber(
  db: Db,
  leaderboardId: string,
): Promise<number> {
  const [row] = await db
    .select({ v: max(leaderboardSeasons.seasonNumber) })
    .from(leaderboardSeasons)
    .where(eq(leaderboardSeasons.leaderboardId, leaderboardId));
  return (row?.v ?? 0) + 1;
}

/**
 * Open a season. Returns null when the partial unique index
 * (`leaderboard_seasons_one_active_idx`) or the (leaderboardId,
 * seasonNumber) unique key rejects the insert — i.e. another replica
 * opened one first. That is an expected outcome under concurrency, not
 * an error.
 */
export async function openSeason(
  db: DbOrTx,
  input: {
    leaderboardId: string;
    seasonNumber: number;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<LeaderboardSeason | null> {
  const rows = await db
    .insert(leaderboardSeasons)
    .values({ ...input, status: "ACTIVE" })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/**
 * Conditional claim: never a SELECT followed by an UPDATE. Two replicas
 * sweeping at once cannot both close the same season, because only one
 * UPDATE can see status = 'ACTIVE'. Mirrors
 * `claimExperimentForScheduledStart` in ./experiments.ts.
 */
export async function claimSeasonForClose(
  db: DbOrTx,
  seasonId: string,
  now: Date,
): Promise<LeaderboardSeason | null> {
  const rows = await db
    .update(leaderboardSeasons)
    .set({ status: "CLOSED", closedAt: now })
    .where(
      and(
        eq(leaderboardSeasons.id, seasonId),
        eq(leaderboardSeasons.status, "ACTIVE"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function listSeasons(
  db: Db,
  leaderboardId: string,
): Promise<LeaderboardSeason[]> {
  return db
    .select()
    .from(leaderboardSeasons)
    .where(eq(leaderboardSeasons.leaderboardId, leaderboardId))
    .orderBy(desc(leaderboardSeasons.seasonNumber));
}

export async function findActiveSeason(
  db: Db,
  leaderboardId: string,
): Promise<LeaderboardSeason | null> {
  const rows = await db
    .select()
    .from(leaderboardSeasons)
    .where(
      and(
        eq(leaderboardSeasons.leaderboardId, leaderboardId),
        eq(leaderboardSeasons.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface StandingInput {
  rank: number;
  // Deliberately not validated against `subscribers` here — see the
  // schema comment on `leaderboard_standings.subscriberId`: standings
  // are a historical snapshot, not a live reference.
  subscriberId: string;
  // Numeric as text: USD sums and large credit totals must not go
  // through a float.
  score: string;
  eventCount: number;
}

/**
 * Bulk-insert a season's final standings. Called once, at close time,
 * with the full ranked set — there is no incremental-update path.
 */
export async function insertStandings(
  db: DbOrTx,
  seasonId: string,
  rows: StandingInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(leaderboardStandings).values(
    rows.map((row) => ({ seasonId, ...row })),
  );
}

export async function listStandings(
  db: Db,
  seasonId: string,
): Promise<LeaderboardStanding[]> {
  return db
    .select()
    .from(leaderboardStandings)
    .where(eq(leaderboardStandings.seasonId, seasonId))
    .orderBy(asc(leaderboardStandings.rank));
}
