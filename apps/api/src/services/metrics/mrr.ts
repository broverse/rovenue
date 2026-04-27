import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// MRR read service — ClickHouse exclusive
// =============================================================
//
// Plan 3 cutover replaces the previous timescale/dual/clickhouse
// adapter with a single CH-bound implementation. The endpoint
// shape is unchanged; only the source of truth moves.

export interface MrrPoint {
  bucket: Date;
  /** Decimal string to preserve precision across the wire. */
  grossUsd: string;
  eventCount: number;
  activeSubscribers: number;
}

export interface ListDailyMrrInput {
  projectId: string;
  from: Date;
  to: Date;
}

interface ChMrrRow {
  bucket: string;
  gross_usd: string;
  event_count: string;
  active_subscribers: string;
}

export async function listDailyMrr(
  input: ListDailyMrrInput,
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
    // CH serialises DateTime as 'YYYY-MM-DD HH:mm:ss' with no timezone
    // suffix; V8 would parse this as local time. Force UTC so callers
    // get the same instant regardless of host timezone.
    bucket: new Date(r.bucket.replace(" ", "T") + "Z"),
    grossUsd: r.gross_usd,
    eventCount: Number(r.event_count),
    activeSubscribers: Number(r.active_subscribers),
  }));
}
