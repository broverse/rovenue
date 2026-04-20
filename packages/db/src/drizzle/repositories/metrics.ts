import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { dailyMrr } from "../views";

// =============================================================
// Analytics reads — Drizzle repository
// =============================================================
//
// Thin wrappers over the TimescaleDB continuous aggregates. The
// goal is to keep time-series queries off the raw revenue_events
// table so the dashboard's MRR chart lands in constant time
// regardless of how many years of history sit behind the window.

export interface DailyMrrPoint {
  bucket: Date;
  grossUsd: string;
  eventCount: number;
  activeSubscribers: number;
}

export interface ListDailyMrrArgs {
  projectId: string;
  /** Inclusive lower bound on the bucket column (UTC). */
  from: Date;
  /** Inclusive upper bound on the bucket column (UTC). */
  to: Date;
}

/**
 * Returns one point per day in [from, to] for the project. The
 * underlying daily_mrr continuous aggregate refreshes every ~10
 * minutes with a 1-hour real-time tail, so the tail of the range
 * stays fresh for live charts without materialising today's
 * bucket on every read.
 */
export async function listDailyMrr(
  db: Db,
  args: ListDailyMrrArgs,
): Promise<DailyMrrPoint[]> {
  const clauses: SQL[] = [
    eq(dailyMrr.projectId, args.projectId),
    gte(dailyMrr.bucket, args.from),
    lte(dailyMrr.bucket, args.to),
  ];

  const rows = await db
    .select({
      bucket: dailyMrr.bucket,
      grossUsd: dailyMrr.grossUsd,
      eventCount: dailyMrr.eventCount,
      activeSubscribers: dailyMrr.activeSubscribers,
    })
    .from(dailyMrr)
    .where(and(...clauses))
    .orderBy(asc(dailyMrr.bucket));

  return rows.map((r) => ({
    bucket: r.bucket,
    // grossUsd comes back as a string for Decimal precision; pass
    // it straight through so the JSON body keeps the full fidelity.
    grossUsd: r.grossUsd,
    eventCount: Number(r.eventCount),
    activeSubscribers: Number(r.activeSubscribers),
  }));
}
