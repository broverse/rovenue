// =============================================================
// Digest scheduler
// =============================================================
//
// Tick handlers for the daily + weekly digest events. The
// scheduler module exports pure functions (`runDailyTick`,
// `runWeeklyTick`) that take their deps explicitly so the
// integration test can drive them with a fixed clock; the
// BullMQ wiring lives in `digest-scheduler-entry.ts`.
//
// Flow per tick:
//   1. Compute the local-9am IANA timezone set for "now".
//   2. Stream users whose user_preferences.timezone is in that
//      set in pages of 500.
//   3. For each user:
//        a. List the projects they're a member of.
//        b. Fetch ClickHouse KPIs for `targetDay` (daily) or
//           [targetWeekStart, targetWeekEnd] (weekly).
//        c. Filter out sections without activity.
//        d. If any section remains, emit one
//           `revenue.digest.daily|weekly` outbox row inside a tx.
//
// Idempotency: emitNotification writes an outbox row that the
// notifier worker dedups on (eventKey, eventId). We derive
// eventId from `{ user, period }` so re-running a tick within
// the same period is safe.

import { and, eq, gt, inArray } from "drizzle-orm";
import type { ClickHouseClient } from "@clickhouse/client";
import { drizzle, type Db } from "@rovenue/db";
import type { Logger } from "../lib/logger";
import { emitNotification } from "../services/notifications/emit";
import {
  fetchDailyKPIs,
  hasActivity,
  type DigestSection,
} from "../services/notifications/digest-kpi";
import { timezonesAtLocalHour } from "../services/notifications/tz";

const { userPreferences, projectMembers, projects: projectsTable } =
  drizzle.schema;

export const DIGEST_LOCAL_HOUR = 9;
export const PAGE_SIZE = 500;

export interface DigestSchedulerDeps {
  db: Db;
  ch: ClickHouseClient | null;
  logger: Logger;
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface TickOutcome extends Record<string, unknown> {
  /** IANA timezones whose clock currently reads 09:00 local. */
  targetTimezones: string[];
  /** Users matched by timezone (regardless of whether they were emitted). */
  usersConsidered: number;
  /** Users for whom we emitted a digest outbox row. */
  usersEmitted: number;
  /** Users skipped because no project had activity. */
  usersSkipped: number;
}

/**
 * Daily tick — every project section for `targetDay = now - 1d`,
 * grouped per user, emitted as one `revenue.digest.daily` row.
 *
 * `now - 1d` (not `now`) because we want yesterday's complete
 * book once the user's day rolls over to 09:00.
 */
export async function runDailyTick(
  deps: DigestSchedulerDeps,
): Promise<TickOutcome> {
  const log = deps.logger.child("digest.daily");
  const now = deps.now?.() ?? new Date();
  const targetTimezones = timezonesAtLocalHour(now, DIGEST_LOCAL_HOUR);
  const targetDay = priorDayInTimezone(now, targetTimezones[0] ?? "UTC");
  // Use UTC for the CH bucket; targetTimezones share the same
  // local 09:00 so picking the first to compute "yesterday" is
  // safe — they all crossed the same midnight in absolute terms.

  const outcome: TickOutcome = {
    targetTimezones,
    usersConsidered: 0,
    usersEmitted: 0,
    usersSkipped: 0,
  };

  if (targetTimezones.length === 0) {
    log.info("no_timezones_match", { hour: DIGEST_LOCAL_HOUR });
    return outcome;
  }

  for await (const batch of streamUsersInTimezones(
    deps.db,
    targetTimezones,
  )) {
    outcome.usersConsidered += batch.length;
    for (const u of batch) {
      const memberships = await listProjectMemberships(deps.db, u.userId);
      if (memberships.length === 0) {
        outcome.usersSkipped += 1;
        continue;
      }
      const projectIds = memberships.map((m) => m.projectId);
      const kpis = await fetchDailyKPIs(deps.ch, projectIds, targetDay);

      const sections = memberships
        .map((m) => {
          const section = kpis.get(m.projectId);
          if (!section) return null;
          return { ...section, projectName: m.projectName };
        })
        .filter(
          (s): s is DigestSection & { projectName: string } =>
            s !== null && hasActivity(s),
        );

      if (sections.length === 0) {
        outcome.usersSkipped += 1;
        continue;
      }

      await deps.db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "revenue.digest.daily",
          eventId: `digest.daily.${u.userId}.${targetDay}`,
          recipients: [u.userId],
          context: {
            date: targetDay,
            timezone: u.timezone,
            sections: sections.map((s) => ({
              projectId: s.projectId,
              projectName: s.projectName,
              mrr: s.netCents,
              mrrDelta: s.netDeltaCents,
              newSubs: s.newSubs,
              churnedSubs: s.churnedSubs,
              refundCount: s.refundCount,
              refundTotalCents: s.refundTotalCents,
            })),
          },
        });
      });
      outcome.usersEmitted += 1;
    }
  }

  log.info("daily_tick_complete", outcome);
  return outcome;
}

/**
 * Weekly tick — emits `revenue.digest.weekly` once per Monday
 * (per timezone). The KPI shape is intentionally the same as the
 * daily section for v1; weekly aggregation lives one phase out.
 */
export async function runWeeklyTick(
  deps: DigestSchedulerDeps,
): Promise<TickOutcome> {
  const log = deps.logger.child("digest.weekly");
  const now = deps.now?.() ?? new Date();
  const targetTimezones = timezonesAtLocalHour(now, DIGEST_LOCAL_HOUR);

  const outcome: TickOutcome = {
    targetTimezones,
    usersConsidered: 0,
    usersEmitted: 0,
    usersSkipped: 0,
  };
  if (targetTimezones.length === 0) {
    log.info("no_timezones_match", { hour: DIGEST_LOCAL_HOUR });
    return outcome;
  }

  // Weekly = last 7 finished days. weekEnd = yesterday, weekStart = -6d.
  const tz = targetTimezones[0] ?? "UTC";
  const weekEnd = priorDayInTimezone(now, tz);
  const weekStart = shiftDay(weekEnd, -6);

  for await (const batch of streamUsersInTimezones(
    deps.db,
    targetTimezones,
  )) {
    outcome.usersConsidered += batch.length;
    for (const u of batch) {
      const memberships = await listProjectMemberships(deps.db, u.userId);
      if (memberships.length === 0) {
        outcome.usersSkipped += 1;
        continue;
      }
      const projectIds = memberships.map((m) => m.projectId);

      // Aggregate across the week by fetching each day and
      // summing per project. CH returns at most 7 rows/project,
      // and the digest scheduler runs once a week — total work
      // is bounded.
      const acc = new Map<string, DigestSection>();
      for (let d = 0; d < 7; d++) {
        const day = shiftDay(weekStart, d);
        const partial = await fetchDailyKPIs(deps.ch, projectIds, day);
        for (const [pid, s] of partial) {
          const prev = acc.get(pid);
          acc.set(pid, prev ? mergeSections(prev, s) : s);
        }
      }

      const sections = memberships
        .map((m) => {
          const section = acc.get(m.projectId);
          if (!section) return null;
          return { ...section, projectName: m.projectName };
        })
        .filter(
          (s): s is DigestSection & { projectName: string } =>
            s !== null && hasActivity(s),
        );

      if (sections.length === 0) {
        outcome.usersSkipped += 1;
        continue;
      }

      await deps.db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "revenue.digest.weekly",
          eventId: `digest.weekly.${u.userId}.${weekStart}`,
          recipients: [u.userId],
          context: {
            weekStart,
            weekEnd,
            timezone: u.timezone,
            sections: sections.map((s) => ({
              projectId: s.projectId,
              projectName: s.projectName,
              mrr: s.netCents,
              mrrDelta: s.netDeltaCents,
              newSubs: s.newSubs,
              churnedSubs: s.churnedSubs,
              refundCount: s.refundCount,
              refundTotalCents: s.refundTotalCents,
            })),
          },
        });
      });
      outcome.usersEmitted += 1;
    }
  }

  log.info("weekly_tick_complete", outcome);
  return outcome;
}

// ---------- helpers ----------

interface UserPage {
  userId: string;
  timezone: string;
}

interface MembershipRow {
  projectId: string;
  projectName: string;
}

async function* streamUsersInTimezones(
  db: Db,
  timezones: string[],
): AsyncGenerator<UserPage[], void, void> {
  let cursor: string | null = null;
  while (true) {
    const rows: UserPage[] = await db
      .select({
        userId: userPreferences.userId,
        timezone: userPreferences.timezone,
      })
      .from(userPreferences)
      .where(
        cursor === null
          ? inArray(userPreferences.timezone, timezones)
          : and(
              inArray(userPreferences.timezone, timezones),
              gt(userPreferences.userId, cursor),
            ),
      )
      .orderBy(userPreferences.userId)
      .limit(PAGE_SIZE);

    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.userId;
  }
}

async function listProjectMemberships(
  db: Db,
  userId: string,
): Promise<MembershipRow[]> {
  return db
    .select({
      projectId: projectMembers.projectId,
      projectName: projectsTable.name,
    })
    .from(projectMembers)
    .innerJoin(projectsTable, eq(projectsTable.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId));
}

/**
 * "Yesterday" in the user's tz, returned as YYYY-MM-DD. The CH
 * query treats this as a UTC calendar day, which is the correct
 * unit because raw_revenue_events.eventDate is UTC and the user's
 * "day boundary at midnight local" is what we approximate by
 * picking a 09:00-local trigger.
 */
function priorDayInTimezone(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now); // YYYY-MM-DD
  return shiftDay(today, -1);
}

function shiftDay(ymd: string, deltaDays: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function mergeSections(a: DigestSection, b: DigestSection): DigestSection {
  return {
    projectId: a.projectId,
    projectName: a.projectName ?? b.projectName,
    netCents: a.netCents + b.netCents,
    // For a weekly aggregate, "delta" is the sum of per-day deltas
    // — i.e. the change from (weekStart - 1) to weekEnd. Summing
    // the daily deltas telescopes to that.
    netDeltaCents: a.netDeltaCents + b.netDeltaCents,
    newSubs: a.newSubs + b.newSubs,
    churnedSubs: a.churnedSubs + b.churnedSubs,
    refundCount: a.refundCount + b.refundCount,
    refundTotalCents: a.refundTotalCents + b.refundTotalCents,
  };
}
