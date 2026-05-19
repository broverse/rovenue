import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  CreditLedgerType,
  CreditsKpis,
  CreditsLedgerRow,
  CreditsPackageRow,
  CreditsRollupResponse,
  CreditsTopBurnerRow,
  CreditsVolumePoint,
} from "@rovenue/shared";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../../lib/clickhouse";

// =============================================================
// Credits rollup (Phase 3.4)
// =============================================================
//
// One service call returns everything the credits page needs in a
// single roundtrip:
//
//   - KPIs (outstanding / issued / burned / revenue / breakage)
//   - 28-day volume series from CH mv_credit_consumption_daily
//   - Credit-pack revenue mix from raw_revenue_events
//   - Top-burning reference buckets from PG credit_ledger
//   - Latest-50 ledger entries from PG credit_ledger
//
// CH carries the analytics rollups; PG carries the live ledger
// rows and the source of truth for outstanding balances. The
// service throws ClickHouseUnavailableError up to the route when
// CH isn't configured — the page already falls back to mock data
// while the query is in flight, so a configured-but-cold setup
// still renders cleanly.

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_WINDOW_DEFAULT_DAYS = 28;
const ROLLUP_WINDOW_MAX_DAYS = 90;
const PACKAGES_LIMIT = 6;
const TOP_BURNERS_LIMIT = 6;
const LEDGER_LIMIT = 50;

interface RollupWindow {
  from: Date;
  to: Date;
  days: number;
}

function buildWindow(windowDays: number): RollupWindow {
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - (windowDays - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to, days: windowDays };
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// =============================================================
// CH: volume series
// =============================================================

interface ChVolumeRow {
  day: string;
  issued: string;
  burned: string;
  net: string;
}

async function readVolume(
  projectId: string,
  window: RollupWindow,
): Promise<CreditsVolumePoint[]> {
  const rows = await queryAnalytics<ChVolumeRow>(
    projectId,
    `
      SELECT
        toString(day)                            AS day,
        toString(sum(granted_credits))           AS issued,
        toString(sum(debited_credits))           AS burned,
        toString(sum(net_flow))                  AS net
      FROM rovenue.mv_credit_consumption_daily_target FINAL
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day ASC
    `,
    { from: toDateOnly(window.from), to: toDateOnly(window.to) },
  );

  const byDay = new Map<string, ChVolumeRow>(rows.map((r) => [r.day, r]));
  const out: CreditsVolumePoint[] = [];
  for (let i = 0; i < window.days; i++) {
    const d = new Date(window.from.getTime() + i * DAY_MS);
    const key = toDateOnly(d);
    const row = byDay.get(key);
    out.push({
      day: key,
      issued: Number(row?.issued ?? "0"),
      burned: Number(row?.burned ?? "0"),
      net: Number(row?.net ?? "0"),
    });
  }
  return out;
}

// =============================================================
// CH: credit-pack revenue mix
// =============================================================

interface ChPackageRow {
  productId: string;
  revenue_usd: string;
  sold: string;
}

async function readPackages(
  projectId: string,
  window: RollupWindow,
): Promise<ChPackageRow[]> {
  return queryAnalytics<ChPackageRow>(
    projectId,
    `
      SELECT
        productId,
        toString(sum(amountUsd))    AS revenue_usd,
        toString(count())           AS sold
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND type = 'CREDIT_PURCHASE'
      GROUP BY productId
      ORDER BY sum(amountUsd) DESC, productId ASC
      LIMIT {limit:UInt32}
    `,
    {
      from: toDateOnly(window.from),
      to: toDateOnly(window.to),
      limit: PACKAGES_LIMIT,
    },
  );
}

// =============================================================
// PG: outstanding liability (sum of latest per-subscriber balances)
// =============================================================
//
// We pick the latest credit_ledger row per subscriber via a window
// function. The credit_ledger schema enforces invariant-by-
// construction (each row stores the balance AFTER the mutation),
// so the latest balance per subscriber is the trustworthy value
// for the outstanding-liability gauge.

async function readOutstandingBalance(projectId: string): Promise<number> {
  const rows = await drizzle.db.execute<{ outstanding: string | null }>(sql`
    SELECT COALESCE(SUM(balance), 0)::text AS outstanding
    FROM (
      SELECT DISTINCT ON ("subscriberId") balance
      FROM ${drizzle.schema.creditLedger}
      WHERE "projectId" = ${projectId}
      ORDER BY "subscriberId", "createdAt" DESC
    ) latest
  `);
  return Number(rows.rows[0]?.outstanding ?? "0");
}

// =============================================================
// PG: KPI sums + breakage proxy
// =============================================================

async function readKpis(
  projectId: string,
  window: RollupWindow,
): Promise<CreditsKpis> {
  const cl = drizzle.schema.creditLedger;
  const [outstanding, [windowAgg]] = await Promise.all([
    readOutstandingBalance(projectId),
    drizzle.db
      .select({
        issued: sql<string>`COALESCE(SUM(CASE WHEN "amount" > 0 THEN "amount" ELSE 0 END), 0)::text`,
        burned: sql<string>`COALESCE(SUM(CASE WHEN "amount" < 0 THEN -"amount" ELSE 0 END), 0)::text`,
        granted: sql<string>`COALESCE(SUM(CASE WHEN "type" IN ('PURCHASE','BONUS') AND "amount" > 0 THEN "amount" ELSE 0 END), 0)::text`,
        expired: sql<string>`COALESCE(SUM(CASE WHEN "type" = 'EXPIRE' AND "amount" < 0 THEN -"amount" ELSE 0 END), 0)::text`,
      })
      .from(cl)
      .where(
        and(
          eq(cl.projectId, projectId),
          gte(cl.createdAt, window.from),
          lte(cl.createdAt, window.to),
        ),
      ),
  ]);

  // Window-scoped CREDIT_PURCHASE USD via PG revenue_events
  // (CH may not always be hot for a freshly seeded environment,
  // and we already pay for the read elsewhere).
  const revRows = await drizzle.db
    .select({
      sumUsd: sql<string>`COALESCE(SUM("amountUsd"), 0)::text`,
    })
    .from(drizzle.schema.revenueEvents)
    .where(
      and(
        eq(drizzle.schema.revenueEvents.projectId, projectId),
        eq(drizzle.schema.revenueEvents.type, "CREDIT_PURCHASE"),
        gte(drizzle.schema.revenueEvents.eventDate, window.from),
        lte(drizzle.schema.revenueEvents.eventDate, window.to),
      ),
    );

  const issued = Number(windowAgg?.issued ?? "0");
  const burned = Number(windowAgg?.burned ?? "0");
  const granted = Number(windowAgg?.granted ?? "0");
  const expired = Number(windowAgg?.expired ?? "0");
  const breakagePct = granted > 0 ? (expired / granted) * 100 : null;

  return {
    outstanding,
    issued28d: issued,
    burned28d: burned,
    revenue28dUsd: revRows[0]?.sumUsd ?? "0",
    breakagePct,
  };
}

// =============================================================
// PG: top burning reference buckets
// =============================================================

async function readTopBurners(
  projectId: string,
  window: RollupWindow,
): Promise<CreditsTopBurnerRow[]> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      key: sql<string>`COALESCE(${cl.referenceType}, 'other')`,
      burned: sql<string>`COALESCE(SUM(-"amount"), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        lt(cl.amount, 0),
        gte(cl.createdAt, window.from),
        lte(cl.createdAt, window.to),
      ),
    )
    .groupBy(sql`COALESCE(${cl.referenceType}, 'other')`)
    .orderBy(sql`SUM(-"amount") DESC`)
    .limit(TOP_BURNERS_LIMIT);

  const total = rows.reduce((a, r) => a + Number(r.burned), 0);
  return rows.map((r) => {
    const burned = Number(r.burned);
    return {
      key: r.key || "other",
      burned,
      pct: total > 0 ? Math.round((burned / total) * 1000) / 10 : 0,
    };
  });
}

// =============================================================
// PG: latest-50 ledger entries
// =============================================================

const ALL_TYPES: ReadonlyArray<CreditLedgerType> = [
  "PURCHASE",
  "SPEND",
  "REFUND",
  "BONUS",
  "EXPIRE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
];

function isCreditLedgerType(s: string): s is CreditLedgerType {
  return (ALL_TYPES as ReadonlyArray<string>).includes(s);
}

async function readRecentLedger(
  projectId: string,
): Promise<CreditsLedgerRow[]> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select()
    .from(cl)
    .where(eq(cl.projectId, projectId))
    .orderBy(desc(cl.createdAt), desc(cl.id))
    .limit(LEDGER_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    subscriberId: r.subscriberId,
    type: isCreditLedgerType(r.type) ? r.type : "SPEND",
    amount: r.amount,
    balance: r.balance,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
  }));
}

// =============================================================
// Product display lookup
// =============================================================

async function fetchProductDisplay(
  projectId: string,
  productIds: ReadonlyArray<string>,
): Promise<
  Map<
    string,
    { identifier: string; displayName: string; creditAmount: number | null }
  >
> {
  if (productIds.length === 0) return new Map();
  const rows = await drizzle.db
    .select({
      id: drizzle.schema.products.id,
      identifier: drizzle.schema.products.identifier,
      displayName: drizzle.schema.products.displayName,
      creditAmount: drizzle.schema.products.creditAmount,
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
      {
        identifier: r.identifier,
        displayName: r.displayName,
        creditAmount: r.creditAmount,
      },
    ]),
  );
}

// =============================================================
// Entry point
// =============================================================

export interface GetCreditsRollupInput {
  projectId: string;
  windowDays: number;
}

export async function getCreditsRollup(
  input: GetCreditsRollupInput,
): Promise<CreditsRollupResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const window = buildWindow(
    Math.min(Math.max(input.windowDays, 1), ROLLUP_WINDOW_MAX_DAYS),
  );

  const [kpis, volume, packagesRaw, topBurners, ledger] = await Promise.all([
    readKpis(input.projectId, window),
    readVolume(input.projectId, window),
    readPackages(input.projectId, window),
    readTopBurners(input.projectId, window),
    readRecentLedger(input.projectId),
  ]);

  const productDisplay = await fetchProductDisplay(
    input.projectId,
    packagesRaw.map((p) => p.productId),
  );

  const totalPackRevenue = packagesRaw.reduce(
    (a, p) => a + Number(p.revenue_usd),
    0,
  );
  const packages: CreditsPackageRow[] = packagesRaw.map((row) => {
    const meta = productDisplay.get(row.productId);
    const rev = Number(row.revenue_usd);
    const pct =
      totalPackRevenue > 0
        ? Math.round((rev / totalPackRevenue) * 1000) / 10
        : 0;
    return {
      productId: row.productId,
      identifier: meta?.identifier ?? null,
      displayName: meta?.displayName ?? null,
      revenueUsd: row.revenue_usd,
      sold: Number(row.sold),
      pct,
      creditAmount: meta?.creditAmount ?? null,
    };
  });

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      days: window.days,
    },
    kpis,
    volume,
    packages,
    topBurners,
    ledger,
  };
}

export const __creditsConstants = {
  ROLLUP_WINDOW_DEFAULT_DAYS,
  ROLLUP_WINDOW_MAX_DAYS,
};
