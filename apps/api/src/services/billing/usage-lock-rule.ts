// =============================================================
// Usage-lock rule (Plausible model)
// =============================================================
// A project is locked when at least one HARD-cap meter (events,
// sql_queries) closed AT/over its limit in BOTH of the two most
// recent completed calendar billing periods. MTR is a soft cap and
// never locks. One over-limit period only warns — the rule embeds
// >=1 month of implicit grace.

const HARD_METERS = new Set(["events", "sql_queries"]);

export interface SnapshotLike {
  meterKey: string;
  periodStart: Date;
  currentValue: string;
  limitValue: string | null;
}

export function completedPeriodStarts(now: Date): [Date, Date] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return [before, prev];
}

function periodOverLimit(rows: SnapshotLike[], period: Date): boolean {
  return rows.some((r) => {
    if (!HARD_METERS.has(r.meterKey)) return false;
    if (r.periodStart.getTime() !== period.getTime()) return false;
    if (r.limitValue === null) return false;
    const current = Number(r.currentValue);
    const limit = Number(r.limitValue);
    return Number.isFinite(current) && Number.isFinite(limit) && current >= limit;
  });
}

export function shouldLockUsage(rows: SnapshotLike[], periods: [Date, Date]): boolean {
  return periodOverLimit(rows, periods[0]) && periodOverLimit(rows, periods[1]);
}
