// =============================================================
// Digest KPI fetcher (ClickHouse)
// =============================================================
//
// One query per scheduler tick per timezone batch — fetches the
// per-project KPIs needed to render the daily digest template:
// net revenue, day-over-day delta, refund count + total, new/
// churned subscriber counts.
//
// Queries `raw_revenue_events FINAL` directly rather than the
// `mv_mrr_daily_target` rollup. The rollup is missing the
// per-type breakdown (INITIAL vs CANCELLATION vs REFUND) we
// need for new/churned subs, and adding extra columns to the
// MV would force a full backfill. A direct query is fine for a
// once-a-day job that hits a tightly bounded eventDate window.

import type { ClickHouseClient } from "@clickhouse/client";

export interface DigestSection {
  projectId: string;
  projectName?: string;
  /** Net revenue (USD) for the target day in cents. */
  netCents: number;
  /** netCents minus the prior day's netCents. */
  netDeltaCents: number;
  newSubs: number;
  churnedSubs: number;
  refundCount: number;
  refundTotalCents: number;
}

interface RawRow {
  projectId: string;
  net_usd: string;
  net_usd_prior: string;
  refund_count: string;
  refund_total_usd: string;
  new_subs: string;
  churned_subs: string;
}

function usdStringToCents(s: string): number {
  // raw_revenue_events.amountUsd is Decimal(12, 4); CH serialises
  // it as a string to preserve precision. We want integer cents
  // for the email template, so round to 2 decimals before scaling.
  const f = Number(s);
  if (!Number.isFinite(f)) return 0;
  return Math.round(f * 100);
}

/**
 * Fetch per-project KPIs for `date` plus the day before (for
 * delta computation) in a single grouped query.
 *
 * Returns a Map keyed by projectId so callers iterate only the
 * projects with at least one event in the [date-1, date] window.
 * Projects with zero activity are absent — the digest renderer
 * uses `hasActivity()` to suppress them anyway.
 */
export async function fetchDailyKPIs(
  ch: ClickHouseClient | null,
  projectIds: string[],
  date: string, // YYYY-MM-DD; treated as a calendar day in UTC by CH.
): Promise<Map<string, DigestSection>> {
  if (!ch || projectIds.length === 0) return new Map();

  const sql = `
    WITH
      toDate({date:Date}) AS targetDay,
      addDays(toDate({date:Date}), -1) AS priorDay
    SELECT
      projectId,
      toString(sumIf(amountUsd, type != 'REFUND' AND toDate(eventDate) = targetDay)) AS net_usd,
      toString(sumIf(amountUsd, type != 'REFUND' AND toDate(eventDate) = priorDay))  AS net_usd_prior,
      toString(countIf(type = 'REFUND' AND toDate(eventDate) = targetDay))           AS refund_count,
      toString(sumIf(amountUsd, type = 'REFUND' AND toDate(eventDate) = targetDay))  AS refund_total_usd,
      toString(uniqExactIf(subscriberId, type = 'INITIAL' AND toDate(eventDate) = targetDay))      AS new_subs,
      toString(uniqExactIf(subscriberId, type = 'CANCELLATION' AND toDate(eventDate) = targetDay)) AS churned_subs
    FROM rovenue.raw_revenue_events FINAL
    WHERE projectId IN ({projectIds:Array(String)})
      AND toDate(eventDate) IN (targetDay, priorDay)
    GROUP BY projectId
  `;

  const result = await ch.query({
    query: sql,
    query_params: { projectIds, date },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawRow[];

  const out = new Map<string, DigestSection>();
  for (const r of rows) {
    const netCents = usdStringToCents(r.net_usd);
    const netPriorCents = usdStringToCents(r.net_usd_prior);
    out.set(r.projectId, {
      projectId: r.projectId,
      netCents,
      netDeltaCents: netCents - netPriorCents,
      newSubs: Number(r.new_subs) || 0,
      churnedSubs: Number(r.churned_subs) || 0,
      refundCount: Number(r.refund_count) || 0,
      refundTotalCents: usdStringToCents(r.refund_total_usd),
    });
  }
  return out;
}

/** Returns true if the section contains anything worth rendering. */
export function hasActivity(section: DigestSection): boolean {
  return (
    section.netDeltaCents !== 0 ||
    section.newSubs > 0 ||
    section.churnedSubs > 0 ||
    section.refundCount > 0
  );
}
