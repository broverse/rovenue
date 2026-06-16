import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  OverviewActivityEvent,
  OverviewSystemHealth,
  OverviewTopProduct,
  ProjectOverviewResponse,
  RevenueEventTypeName,
  SystemHealthStatus,
} from "@rovenue/shared";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../../lib/clickhouse";

// =============================================================
// Project overview aggregator (Phase 3.1)
// =============================================================
//
// One service call → three CH reads + two PG reads in parallel:
//
//   1. CH daily series across prev+current windows (one scan) —
//      MRR / active subs / net-churn KPIs + sparklines.
//   2. CH top-products GROUP BY in the current window,
//      joined to PG `products` for display name + identifier.
//   3. CH recent-activity SELECT (latest 10 events project-wide),
//      joined to PG `products` for display name.
//   4. PG system-health probe (latest webhook_event per source +
//      outgoing-webhook delivery in the trailing hour).
//   5. PG product-display lookup keyed by the union of (2) + (3).
//
// Sparklines come back as decimal-as-strings for gross USD and
// plain numbers for counts — matches the existing metrics/mrr
// wire convention.

const DAY_MS = 24 * 60 * 60 * 1000;

const ALL_REVENUE_TYPES: ReadonlyArray<RevenueEventTypeName> = [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "CANCELLATION",
  "REFUND",
  "REACTIVATION",
  "CREDIT_PURCHASE",
];

function isKnownRevenueType(t: string): t is RevenueEventTypeName {
  return (ALL_REVENUE_TYPES as ReadonlyArray<string>).includes(t);
}

// =============================================================
// Window math
// =============================================================
//
// `to` is anchored to the end of "today" (UTC midnight + 24h - 1ms)
// so the latest day is fully included. The prior window is the
// same length immediately preceding `from`, which gives the KPI
// cards a same-shape baseline for delta calculations.

interface OverviewWindow {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  /** Number of whole days in the current window. */
  days: number;
}

function buildWindow(windowDays: number): OverviewWindow {
  const todayUtc = new Date();
  todayUtc.setUTCHours(23, 59, 59, 999);
  const to = todayUtc;
  const from = new Date(to.getTime() - (windowDays - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);

  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - (windowDays - 1) * DAY_MS);
  prevFrom.setUTCHours(0, 0, 0, 0);

  return { from, to, prevFrom, prevTo, days: windowDays };
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// =============================================================
// CH: daily revenue rollup spanning prev + current windows
// =============================================================

interface ChDailyRollupRow {
  day: string;
  gross_usd: string;
  refunds_usd: string;
  active_subs: string;
  trial_conversions: string;
  cancellations: string;
}

async function readDailyRollup(
  projectId: string,
  window: OverviewWindow,
): Promise<ChDailyRollupRow[]> {
  return queryAnalytics<ChDailyRollupRow>(
    projectId,
    `
      SELECT
        toString(toDate(eventDate))                                       AS day,
        toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))   AS gross_usd,
        toString(sumIf(abs(amountUsd), type IN ('REFUND','CHARGEBACK')))  AS refunds_usd,
        toString(uniqExact(subscriberId))                                  AS active_subs,
        toString(countIf(type = 'TRIAL_CONVERSION'))                       AS trial_conversions,
        toString(countIf(type = 'CANCELLATION'))                           AS cancellations
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {prevFrom:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY toDate(eventDate)
      ORDER BY day ASC
    `,
    {
      prevFrom: toDateOnly(window.prevFrom),
      to: toDateOnly(window.to),
    },
  );
}

// =============================================================
// CH: top products in the current window
// =============================================================

interface ChTopProductRow {
  productId: string;
  gross_usd: string;
  subs: string;
}

async function readTopProducts(
  projectId: string,
  window: OverviewWindow,
): Promise<ChTopProductRow[]> {
  return queryAnalytics<ChTopProductRow>(
    projectId,
    `
      SELECT
        productId,
        toString(sum(amountUsd))           AS gross_usd,
        toString(uniqExact(subscriberId))  AS subs
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND type NOT IN ('REFUND','CHARGEBACK')
      GROUP BY productId
      HAVING sum(amountUsd) > 0
      ORDER BY sum(amountUsd) DESC, productId ASC
      LIMIT 5
    `,
    {
      from: toDateOnly(window.from),
      to: toDateOnly(window.to),
    },
  );
}

// =============================================================
// CH: latest project-wide events
// =============================================================

interface ChRecentActivityRow {
  eventId: string;
  type: string;
  productId: string;
  subscriberId: string;
  amount_usd: string;
  currency: string;
  store: string;
  event_date: string;
}

async function readRecentActivity(
  projectId: string,
): Promise<ChRecentActivityRow[]> {
  return queryAnalytics<ChRecentActivityRow>(
    projectId,
    `
      SELECT
        eventId,
        type,
        productId,
        subscriberId,
        toString(amountUsd)                                  AS amount_usd,
        currency,
        store,
        formatDateTime(eventDate, '%Y-%m-%dT%H:%i:%S.%fZ')   AS event_date
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
      ORDER BY eventDate DESC
      LIMIT 10
    `,
  );
}

// =============================================================
// PG: product display name lookup
// =============================================================

async function fetchProductDisplay(
  projectId: string,
  productIds: ReadonlyArray<string>,
): Promise<Map<string, { identifier: string; displayName: string }>> {
  if (productIds.length === 0) return new Map();
  const rows = await drizzle.db
    .select({
      id: drizzle.schema.products.id,
      identifier: drizzle.schema.products.identifier,
      displayName: drizzle.schema.products.displayName,
    })
    .from(drizzle.schema.products)
    .where(
      and(
        eq(drizzle.schema.products.projectId, projectId),
        inArray(drizzle.schema.products.id, [...productIds]),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      { identifier: r.identifier, displayName: r.displayName },
    ]),
  );
}

// =============================================================
// PG: system-health probe
// =============================================================
//
// Latest webhook_events row per source — used as a "last sync"
// signal for App Store / Play / Stripe. Outgoing-webhook section
// reports the trailing-hour delivery ratio.

const HEALTH_SOURCES: ReadonlyArray<{
  source: "APPLE" | "GOOGLE" | "STRIPE";
  key: string;
  name: string;
}> = [
  { source: "APPLE", key: "apple-webhooks", name: "App Store Connect" },
  { source: "GOOGLE", key: "google-webhooks", name: "Google Play" },
  { source: "STRIPE", key: "stripe-webhooks", name: "Stripe" },
];

const DEGRADED_AFTER_MINUTES = 60;
const DOWN_AFTER_MINUTES = 24 * 60;

function describeAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `Last sync ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Last sync ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Last sync ${h}h ago`;
  return `Last sync ${Math.floor(h / 24)}d ago`;
}

async function readSystemHealth(
  projectId: string,
): Promise<OverviewSystemHealth[]> {
  const now = Date.now();
  const out: OverviewSystemHealth[] = [];

  const sourceLatest = await Promise.all(
    HEALTH_SOURCES.map(async ({ source }) => {
      const row = await drizzle.db
        .select({ createdAt: drizzle.schema.webhookEvents.createdAt })
        .from(drizzle.schema.webhookEvents)
        .where(
          and(
            eq(drizzle.schema.webhookEvents.projectId, projectId),
            eq(drizzle.schema.webhookEvents.source, source),
          ),
        )
        .orderBy(desc(drizzle.schema.webhookEvents.createdAt))
        .limit(1);
      return row[0]?.createdAt ?? null;
    }),
  );

  HEALTH_SOURCES.forEach(({ key, name }, i) => {
    const latest = sourceLatest[i];
    if (!latest) {
      out.push({ key, name, status: "degraded", metric: "No webhooks yet" });
      return;
    }
    const ageMs = now - latest.getTime();
    const ageMin = ageMs / 60_000;
    const status: SystemHealthStatus =
      ageMin < DEGRADED_AFTER_MINUTES
        ? "operational"
        : ageMin < DOWN_AFTER_MINUTES
          ? "degraded"
          : "down";
    out.push({ key, name, status, metric: describeAge(ageMs) });
  });

  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const recentOutgoing = await drizzle.db
    .select({
      status: drizzle.schema.outgoingWebhooks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(drizzle.schema.outgoingWebhooks)
    .where(
      and(
        eq(drizzle.schema.outgoingWebhooks.projectId, projectId),
        gte(drizzle.schema.outgoingWebhooks.createdAt, oneHourAgo),
      ),
    )
    .groupBy(drizzle.schema.outgoingWebhooks.status);

  const byStatus: Record<string, number> = {};
  for (const r of recentOutgoing) byStatus[r.status] = r.count;
  const total =
    (byStatus.PENDING ?? 0) +
    (byStatus.SENT ?? 0) +
    (byStatus.FAILED ?? 0) +
    (byStatus.DEAD ?? 0);
  if (total === 0) {
    out.push({
      key: "outgoing-webhooks",
      name: "Outgoing webhooks",
      status: "operational",
      metric: "0 in last hour",
    });
  } else {
    const sent = byStatus.SENT ?? 0;
    const dead = byStatus.DEAD ?? 0;
    const pct = (sent / total) * 100;
    const status: SystemHealthStatus =
      dead > 0 || pct < 90 ? "degraded" : "operational";
    out.push({
      key: "outgoing-webhooks",
      name: "Outgoing webhooks",
      status,
      metric: `${pct.toFixed(1)}% delivery (${total} in 1h)`,
    });
  }

  out.push({
    key: "clickhouse",
    name: "Analytics mirror",
    status: isClickHouseConfigured() ? "operational" : "down",
    metric: isClickHouseConfigured() ? "Connected" : "Not configured",
  });

  return out;
}

// =============================================================
// Aggregation helpers
// =============================================================

function dailyByDay(
  rows: ChDailyRollupRow[],
): Map<string, ChDailyRollupRow> {
  return new Map(rows.map((r) => [r.day, r]));
}

function dayKeys(from: Date, days: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * DAY_MS);
    keys.push(toDateOnly(d));
  }
  return keys;
}

function pctOf(num: number, denom: number): number | null {
  if (denom === 0 || !Number.isFinite(denom)) return null;
  return (num / denom) * 100;
}

// =============================================================
// Entry point
// =============================================================

export interface GetProjectOverviewInput {
  projectId: string;
  windowDays: number;
}

export async function getProjectOverview(
  input: GetProjectOverviewInput,
): Promise<ProjectOverviewResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }

  const window = buildWindow(input.windowDays);

  const [rollup, top, recent] = await Promise.all([
    readDailyRollup(input.projectId, window),
    readTopProducts(input.projectId, window),
    readRecentActivity(input.projectId),
  ]);

  const productIds = new Set<string>();
  for (const t of top) productIds.add(t.productId);
  for (const e of recent) productIds.add(e.productId);

  const [productDisplay, systemHealth] = await Promise.all([
    fetchProductDisplay(input.projectId, [...productIds]),
    readSystemHealth(input.projectId),
  ]);

  const byDay = dailyByDay(rollup);
  const currKeys = dayKeys(window.from, window.days);
  const prevKeys = dayKeys(window.prevFrom, window.days);

  const grossSpark = currKeys.map((k) => byDay.get(k)?.gross_usd ?? "0");
  const activeSpark = currKeys.map((k) =>
    Number(byDay.get(k)?.active_subs ?? "0"),
  );
  const churnSpark = currKeys.map((k) => {
    const r = byDay.get(k);
    if (!r) return 0;
    const gross = Number(r.gross_usd);
    const refunds = Number(r.refunds_usd);
    if (gross === 0) return 0;
    return (refunds / gross) * 100;
  });

  const sumOver = (
    keys: ReadonlyArray<string>,
    field: keyof ChDailyRollupRow,
  ): number =>
    keys.reduce((acc, k) => {
      const row = byDay.get(k);
      if (!row) return acc;
      return acc + Number(row[field]);
    }, 0);

  // Window-wide active uses the per-day peak since the daily
  // rollup's uniqExact would double-count subscribers active on
  // multiple days. For a true window-wide uniqMerge we'd hit the
  // mv_mrr_daily MV — left as an optimisation for Phase 3.3.
  const uniqMax = (keys: ReadonlyArray<string>): number => {
    let max = 0;
    for (const k of keys) {
      const row = byDay.get(k);
      if (!row) continue;
      const v = Number(row.active_subs);
      if (v > max) max = v;
    }
    return max;
  };

  const currGross = sumOver(currKeys, "gross_usd");
  const prevGross = sumOver(prevKeys, "gross_usd");
  const currRefunds = sumOver(currKeys, "refunds_usd");
  const prevRefunds = sumOver(prevKeys, "refunds_usd");
  const currActive = uniqMax(currKeys);
  const prevActive = uniqMax(prevKeys);

  const currNetChurnPct = pctOf(currRefunds, currGross);
  const prevNetChurnPct = pctOf(prevRefunds, prevGross);
  const netChurnDeltaPp =
    currNetChurnPct !== null && prevNetChurnPct !== null
      ? currNetChurnPct - prevNetChurnPct
      : null;

  const totalTopGross = top.reduce((a, t) => a + Number(t.gross_usd), 0);
  const topProducts: OverviewTopProduct[] = top.map((row) => {
    const meta = productDisplay.get(row.productId);
    const gross = Number(row.gross_usd);
    const pct =
      totalTopGross > 0 ? Math.round((gross / totalTopGross) * 1000) / 10 : 0;
    return {
      productId: row.productId,
      identifier: meta?.identifier ?? row.productId,
      displayName: meta?.displayName ?? row.productId,
      grossUsd: row.gross_usd,
      pct,
      subscriberCount: Number(row.subs),
    };
  });

  const recentActivity: OverviewActivityEvent[] = recent.map((row) => {
    const meta = productDisplay.get(row.productId);
    const type: RevenueEventTypeName = isKnownRevenueType(row.type)
      ? row.type
      : "INITIAL";
    return {
      id: row.eventId,
      type,
      productId: row.productId,
      productName: meta?.displayName ?? null,
      subscriberId: row.subscriberId,
      amountUsd: row.amount_usd,
      currency: row.currency,
      store: row.store,
      eventDate: row.event_date,
    };
  });

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      days: window.days,
      prevFrom: window.prevFrom.toISOString(),
      prevTo: window.prevTo.toISOString(),
    },
    kpis: {
      mrr: {
        current: currGross.toFixed(4),
        previous: prevGross.toFixed(4),
        deltaPct: pctOf(currGross - prevGross, prevGross),
        spark: grossSpark,
      },
      activeSubscribers: {
        current: currActive,
        previous: prevActive,
        deltaAbs: currActive - prevActive,
        spark: activeSpark,
      },
      trialToPaid: {
        // Trial→paid needs subscription-lifecycle context that
        // arrives with Phase 3.3 (renewal-calendar + composition).
        // Until then we return null so the page keeps its
        // placeholder rather than rendering a misleading ratio.
        ratePct: null,
        previousRatePct: null,
        deltaPp: null,
        spark: [],
      },
      netChurnPct: {
        current: currNetChurnPct,
        previous: prevNetChurnPct,
        deltaPp: netChurnDeltaPp,
        spark: churnSpark,
      },
    },
    topProducts,
    recentActivity,
    systemHealth,
  };
}
