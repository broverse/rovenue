import type { Db } from "@rovenue/db";
import { drizzle } from "@rovenue/db";
import { queryAnalytics, ClickHouseUnavailableError } from "../../lib/clickhouse";

// =============================================================
// Billing Usage Service
// =============================================================
// Computes real-time billing meter values for a project and the
// current billing period. Three meters:
//
//   mtr         — Monthly Tracked Revenue (USD) from ClickHouse.
//                 Soft-cap: overage allowed with a warning.
//   events      — webhook_events (PG) + raw_sdk_session_events
//                 (ClickHouse). Hard-cap.
//   sql_queries — warehouse query runs (PG). Hard-cap.
//
// When ClickHouse is unavailable the request still succeeds:
// CH-backed meters return current:null / available:false; the
// response is still returned and snapshot persistence is skipped
// for those meters (best-effort; never fatal).
// =============================================================

export type UsageMeterKey = "mtr" | "events" | "sql_queries";

export type UsageMeter = {
  key: UsageMeterKey;
  current: number | null; // null when the source is unavailable (CH down)
  limit: number | null;   // null = unlimited
  cap: "hard" | "soft";
  unit: "usd" | "count";
  available: boolean;
};

export type BillingUsage = {
  tier: string;
  cycle: string;
  periodStart: string; // ISO
  periodEnd: string;   // ISO
  meters: UsageMeter[];
};

const CAP: Record<UsageMeterKey, "hard" | "soft"> = {
  mtr: "soft",
  events: "hard",
  sql_queries: "hard",
};

function calendarMonth(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function chScalar(
  projectId: string,
  sql: string,
  params: Record<string, unknown>,
): Promise<number | null> {
  try {
    const rows = await queryAnalytics<{ v: number | string }>(projectId, sql, params);
    return toNum(rows[0]?.v) ?? 0;
  } catch (err) {
    if (err instanceof ClickHouseUnavailableError) return null;
    throw err;
  }
}

export async function buildUsageReport(
  db: Db,
  projectId: string,
): Promise<BillingUsage> {
  const sub = await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
    db,
    projectId,
  );

  const tier = sub?.tier ?? "free";
  const cycle = sub?.cycle ?? "monthly";
  const now = new Date();
  const periodStart = sub?.currentPeriodStart ?? calendarMonth(now).start;
  const periodEnd = sub?.currentPeriodEnd ?? calendarMonth(now).end;

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(db, tier, cycle);
  const mtrLimit = toNum(limits?.mtrMax);
  const eventsLimit = toNum(limits?.eventsLimit);
  const sqlLimit = toNum(limits?.sqlLimit);

  // ISO datetime strings for ClickHouse param binding (no trailing Z, space separator).
  const isoStart = periodStart.toISOString().slice(0, 19).replace("T", " ");
  const isoEnd = periodEnd.toISOString().slice(0, 19).replace("T", " ");

  // --- MTR (ClickHouse) ---
  // Table is prefixed with the rovenue schema (matches existing analytics reads
  // in this codebase, e.g. rovenue.raw_revenue_events in leaderboards.ts).
  const mtrCurrent = await chScalar(
    projectId,
    `SELECT toFloat64(sum(net_usd)) AS v
       FROM rovenue.mv_mrr_daily_target
      WHERE projectId = {projectId:String}
        AND day >= toDate({start:String}) AND day < toDate({end:String})`,
    { start: isoStart, end: isoEnd },
  );

  // --- events = webhook_events (PG) + raw_sdk_session_events (CH) ---
  const webhookCount = await drizzle.webhookEventRepo.countWebhookEventsInPeriod(
    db,
    projectId,
    periodStart,
    periodEnd,
  );
  const sdkCount = await chScalar(
    projectId,
    `SELECT toUInt64(count()) AS v
       FROM rovenue.raw_sdk_session_events
      WHERE projectId = {projectId:String}
        AND occurredAt >= {start:String} AND occurredAt < {end:String}`,
    { start: isoStart, end: isoEnd },
  );
  const eventsAvailable = sdkCount !== null;
  const eventsCurrent = eventsAvailable ? webhookCount + (sdkCount ?? 0) : webhookCount;

  // --- sql_queries (PG) ---
  const sqlCurrent = await drizzle.warehouseQueryRunRepo.countQueryRunsInPeriod(
    db,
    projectId,
    periodStart,
    periodEnd,
  );

  const meters: UsageMeter[] = [
    {
      key: "mtr",
      current: mtrCurrent,
      limit: mtrLimit,
      cap: CAP.mtr,
      unit: "usd",
      available: mtrCurrent !== null,
    },
    {
      key: "events",
      current: eventsCurrent,
      limit: eventsLimit,
      cap: CAP.events,
      unit: "count",
      available: eventsAvailable,
    },
    {
      key: "sql_queries",
      current: sqlCurrent,
      limit: sqlLimit,
      cap: CAP.sql_queries,
      unit: "count",
      available: true,
    },
  ];

  // Persist into the read model + maintain cap-warn bookkeeping (best-effort).
  for (const m of meters) {
    if (m.current === null) continue;
    try {
      await drizzle.usageSnapshotRepo.upsertUsageSnapshot(db, {
        projectId,
        meterKey: m.key,
        periodStart,
        periodEnd,
        currentValue: String(m.current),
        limitValue: m.limit !== null ? String(m.limit) : null,
      });
      if (m.limit !== null && m.current >= m.limit) {
        if (m.cap === "hard") {
          await drizzle.usageSnapshotRepo.markHardCapWarned(
            db,
            projectId,
            m.key,
            periodStart,
          );
        } else {
          await drizzle.usageSnapshotRepo.markSoftCapWarned(
            db,
            projectId,
            m.key,
            periodStart,
          );
        }
      }
    } catch {
      /* snapshot persistence is best-effort; do not fail the read */
    }
  }

  return {
    tier,
    cycle,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    meters,
  };
}
