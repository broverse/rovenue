import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { queryAnalytics } from "../../lib/clickhouse";
import { logger } from "../../lib/logger";

// =============================================================
// MRR read adapter
// =============================================================
//
// Routes daily MRR reads to Timescale (legacy), ClickHouse
// (new), or dual (both — for drift comparison during rollout).
// The active backend is controlled by MRR_READ_SOURCE in env.
//
// Dual mode always returns the Timescale result so callers see
// no degradation if CH is lagging or unavailable.

const log = logger.child("mrr-adapter");

export interface MrrPoint {
  bucket: Date;
  /** Decimal string to preserve precision across both backends. */
  grossUsd: string;
  eventCount: number;
  activeSubscribers: number;
}

export interface MrrInput {
  projectId: string;
  from: Date;
  to: Date;
}

// -------------------------------------------------------------------
// Timescale path — wraps the existing Drizzle repo
// -------------------------------------------------------------------

export async function timescaleListDailyMrr(
  input: MrrInput,
): Promise<MrrPoint[]> {
  return drizzle.metricsRepo.listDailyMrr(drizzle.db, input);
}

// -------------------------------------------------------------------
// ClickHouse path
// -------------------------------------------------------------------

interface ChMrrRow {
  bucket: string;
  gross_usd: string;
  event_count: string;
  active_subscribers: string;
}

export async function clickhouseListDailyMrr(
  input: MrrInput,
): Promise<MrrPoint[]> {
  const sql = `
    SELECT
      toStartOfDay(day)               AS bucket,
      toString(gross_usd)             AS gross_usd,
      toUInt64(event_count)           AS event_count,
      uniqMerge(subscribersHll)       AS active_subscribers
    FROM rovenue.mv_mrr_daily_target FINAL
    WHERE projectId = {projectId:String}
      AND day >= {from:Date}
      AND day <= {to:Date}
    GROUP BY projectId, day, gross_usd, event_count
    ORDER BY day ASC
  `;

  const rows = await queryAnalytics<ChMrrRow>(input.projectId, sql, {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
  });

  return rows.map((r) => ({
    // CH serializes DateTime as 'YYYY-MM-DD HH:mm:ss' with no timezone suffix;
    // V8 would parse this as local time. Force UTC so .toISOString() matches
    // the Timescale path's Drizzle-typed Date.
    bucket: new Date(r.bucket.replace(' ', 'T') + 'Z'),
    grossUsd: r.gross_usd,
    eventCount: Number(r.event_count),
    activeSubscribers: Number(r.active_subscribers),
  }));
}

// -------------------------------------------------------------------
// Drift logger (pure — does not throw)
// -------------------------------------------------------------------

export function logDriftPerBucket(
  projectId: string,
  tsPoints: MrrPoint[],
  chPoints: MrrPoint[],
): void {
  try {
    const tsMap = new Map<string, MrrPoint>();
    for (const p of tsPoints) {
      tsMap.set(p.bucket.toISOString(), p);
    }

    let compared = 0;
    let maxDrift = 0;
    let outOfTolerance = 0;

    for (const ch of chPoints) {
      const bucketIso = ch.bucket.toISOString();
      const ts = tsMap.get(bucketIso);
      if (!ts) {
        log.info("mrr.dual.missing-in-timescale", { projectId, bucket: bucketIso });
        continue;
      }

      compared++;
      const tsGross = Number(ts.grossUsd);
      const chGross = Number(ch.grossUsd);
      const driftPct =
        Math.abs(tsGross - chGross) / Math.max(Math.abs(tsGross), 1e-9);

      if (driftPct > maxDrift) maxDrift = driftPct;

      if (driftPct > 0.005) {
        outOfTolerance++;
        log.warn("mrr.dual.drift-out-of-tolerance", {
          projectId,
          bucket: bucketIso,
          tsGross,
          chGross,
          driftPct,
        });
      }
    }

    log.info("mrr.dual.summary", {
      projectId,
      bucketsCompared: compared,
      maxDrift,
      outOfToleranceCount: outOfTolerance,
    });
  } catch (err) {
    // logDriftPerBucket must never throw — degrade gracefully
    log.warn("mrr.dual.drift-log-error", {
      projectId,
      error: String(err),
    });
  }
}

// -------------------------------------------------------------------
// Dispatcher — routes based on MRR_READ_SOURCE
// -------------------------------------------------------------------

export async function listDailyMrr(input: MrrInput): Promise<MrrPoint[]> {
  const mode = env.MRR_READ_SOURCE;

  if (mode === "timescale") return timescaleListDailyMrr(input);
  if (mode === "clickhouse") return clickhouseListDailyMrr(input);

  // dual — query both, compare, return Timescale result
  const [ts, ch] = await Promise.allSettled([
    timescaleListDailyMrr(input),
    clickhouseListDailyMrr(input),
  ]);

  if (ts.status === "rejected") throw ts.reason;

  if (ch.status === "fulfilled") {
    logDriftPerBucket(input.projectId, ts.value, ch.value);
  } else {
    // CH side failed — log warning but don't fail the request
    log.warn("mrr.dual.clickhouse.failed", {
      projectId: input.projectId,
      error: String(ch.reason),
    });
  }

  return ts.value;
}
