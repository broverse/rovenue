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
  refundsUsd: string;
  netUsd: string;
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
  refunds_usd: string;
  net_usd: string;
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
      toString(refunds_usd)           AS refunds_usd,
      toString(net_usd)               AS net_usd,
      toUInt64(event_count)           AS event_count,
      toUInt64(active_subscribers)    AS active_subscribers
    FROM rovenue.v_mrr_daily
    WHERE projectId = {projectId:String}
      AND day >= {from:Date}
      AND day <= {to:Date}
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
    refundsUsd: r.refunds_usd,
    netUsd: r.net_usd,
    eventCount: Number(r.event_count),
    activeSubscribers: Number(r.active_subscribers),
  }));
}
