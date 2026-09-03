import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  CreditLedgerType,
  CreditsFlow,
  CreditsFlowByType,
  CreditsKpis,
  CreditsLedgerRow,
  CreditsLiability,
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
  bucket: string;
  issued: string;
  burned: string;
  net: string;
}

async function readVolume(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<CreditsVolumePoint[]> {
  // NB: alias the projected column to `bucket`, not `day`. Aliasing
  // `toString(day) AS day` shadows the underlying Date column with a
  // String of the same name, and ClickHouse then binds `WHERE day >=
  // {from:Date}` to that String alias → NO_COMMON_TYPE (String vs Date).
  //
  // v_credit_consumption_daily is keyed by (projectId, currencyId, day).
  // Without a currencyId filter the view returns one row per (currency, day);
  // the sum() + GROUP BY day collapses all currencies back to the project-wide
  // daily series (preserving pre-existing project-wide behavior).
  // With a currencyId filter only that currency's rows remain, so the sum
  // is that currency's daily flow.
  const currencyFilter = currencyId ? "AND currencyId = {currencyId:String}" : "";
  const rows = await queryAnalytics<ChVolumeRow>(
    projectId,
    `
      SELECT
        toString(day)                  AS bucket,
        toString(sum(granted_credits)) AS issued,
        toString(sum(debited_credits)) AS burned,
        toString(sum(net_flow))        AS net
      FROM rovenue.v_credit_consumption_daily
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
        ${currencyFilter}
      GROUP BY day
      ORDER BY day ASC
    `,
    {
      from: toDateOnly(window.from),
      to: toDateOnly(window.to),
      ...(currencyId ? { currencyId } : {}),
    },
  );

  const byDay = new Map<string, ChVolumeRow>(rows.map((r) => [r.bucket, r]));
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
// Daily credit-burn series — charts.ts's `credit_burn` chart id
// =============================================================
//
// No new SQL: `readVolume`'s CH query above already groups by day and
// already carries `burned` (credits debited that day). This just
// re-shapes that same query's output into charts.ts's plain
// `{ day, n }` daily-count shape (see buildCountSeriesPoints) instead
// of widening the query or duplicating it.
//
// SIGN CONVENTION: `burned` is already a positive magnitude here, not
// a negative flow. `v_credit_consumption_daily` (0012/0015 migrations)
// defines `debited_credits` as `sumIf(-amount, amount < 0)` — ledger
// SPEND/EXPIRE rows store a negative `amount`, and negating a negative
// sums to positive. `readKpis.burned28d` and `readTopBurners.burned`
// use the identical convention (`-"amount"` under `amount < 0`) for
// the same reason. `Math.abs` below is a defensive normalisation, not
// a fix for an observed negative — it's there so a future change to
// the view's sign can't silently ship a chart that dips below zero.
export async function getCreditBurnDaily(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<Array<{ day: string; n: number }>> {
  const rows = await readVolume(projectId, window, currencyId);
  return rows.map((r) => ({ day: r.day, n: Math.abs(r.burned) }));
}

// =============================================================
// PG: outstanding liability, per day
// =============================================================

/**
 * Daily grain behind the chart-catalog `liability` id: the outstanding
 * credit balance at the end of each day in the window.
 *
 * Anchored on TODAY's authoritative figure and walked BACKWARDS through
 * the window's signed deltas:
 *
 *     liability(D) = outstanding_now − Σ { amount : createdAt > end of D }
 *
 * Three reasons for that direction, none of them stylistic:
 *
 *  1. The last point equals `getCreditsRollup`'s gauge BY CONSTRUCTION
 *     — same query, so the chart and the card cannot drift apart.
 *  2. It reads no row outside the window. `credit_ledger` is monthly
 *     range-partitioned; a forward sum from zero would silently lose its
 *     opening balance the day an old partition is detached, and report
 *     the shortfall as a real decline.
 *  3. It sums `amount` (the signed delta) while the anchor reads
 *     `balance` (the running total the schema stores per row). Those two
 *     agreeing IS the ledger's append-only invariant; asserting the
 *     final point against the gauge on real Postgres
 *     (credits.liability-daily.integration.test.ts) is what turns that
 *     invariant from an assumption into a test.
 *
 * Credits, not USD: the rollup's `paidReserveUsd` needs an average
 * credit price derived from a window's revenue, which has no meaning
 * "as of last March". Every currency is summed, matching the gauge's
 * own default (`readOutstandingBalance` with no currency filter).
 *
 * This was `supported: false` until 2026-09-04 on the grounds that "no
 * balance history is retained anywhere". The ledger retains it: it is
 * append-only and every row carries both the delta and the balance
 * after it.
 */
export async function getCreditLiabilityDaily(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<Array<{ day: string; n: number }>> {
  const [{ outstanding }, deltaRows] = await Promise.all([
    readOutstandingBalance(projectId, currencyId),
    readDailyDeltas(projectId, window, currencyId),
  ]);

  const deltaByDay = new Map(deltaRows.map((r) => [r.day, r.delta]));

  const days: string[] = [];
  const cursor = new Date(window.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(window.to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  // Right to left: the last day carries today's authoritative figure,
  // and each earlier day undoes the deltas booked after it.
  const out: Array<{ day: string; n: number }> = new Array(days.length);
  let running = outstanding;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]!;
    out[i] = { day, n: running };
    running -= deltaByDay.get(day) ?? 0;
  }
  return out;
}

async function readDailyDeltas(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<Array<{ day: string; delta: number }>> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${cl.createdAt}), 'YYYY-MM-DD')`,
      delta: sql<string>`COALESCE(SUM("amount"), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        gte(cl.createdAt, window.from),
        lte(cl.createdAt, window.to),
        ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
      ),
    )
    .groupBy(sql`date_trunc('day', ${cl.createdAt})`);

  return rows.map((r) => ({ day: r.day, delta: Number(r.delta) }));
}

// =============================================================
// Currency filter helper
// =============================================================
//
// Returns a Drizzle sql fragment that appends "AND "currencyId" = $1"
// when a currencyId is supplied, or an empty fragment otherwise.
// Insert ${currencyClause(currencyId)} after the "projectId" predicate
// in every credit_ledger raw-sql query.

function currencyClause(currencyId?: string) {
  return currencyId ? sql` AND "currencyId" = ${currencyId}` : sql``;
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
  // Intentionally project-wide: raw_revenue_events has no currencyId column —
  // a credit-pack purchase is real-money revenue (USD), not a virtual-currency
  // unit. Revenue attribution per currency is out of scope for this plan.
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

async function readOutstandingBalance(
  projectId: string,
  currencyId?: string,
): Promise<{ outstanding: number; walletCount: number }> {
  // DISTINCT ON ("subscriberId", "currencyId") so each (subscriber, currency)
  // wallet is counted independently — a subscriber holding GLD and GEM holds
  // two separate wallets that must both contribute to the outstanding total.
  const rows = await drizzle.db.execute<{
    outstanding: string | null;
    wallet_count: string | null;
  }>(sql`
    SELECT
      COALESCE(SUM(balance), 0)::text                AS outstanding,
      COUNT(*) FILTER (WHERE balance > 0)::text      AS wallet_count
    FROM (
      SELECT DISTINCT ON ("subscriberId", "currencyId") balance
      FROM ${drizzle.schema.creditLedger}
      WHERE "projectId" = ${projectId}${currencyClause(currencyId)}
      ORDER BY "subscriberId", "currencyId", "createdAt" DESC
    ) latest
  `);
  const r = rows.rows[0];
  return {
    outstanding: Number(r?.outstanding ?? "0"),
    walletCount: Number(r?.wallet_count ?? "0"),
  };
}

// =============================================================
// PG: KPI sums + breakage proxy
// =============================================================

async function readKpis(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<CreditsKpis> {
  const cl = drizzle.schema.creditLedger;
  const [{ outstanding, walletCount }, [windowAgg]] = await Promise.all([
    readOutstandingBalance(projectId, currencyId),
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
          ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
        ),
      ),
  ]);

  // Intentionally project-wide: revenue_events has no currencyId column —
  // CREDIT_PURCHASE USD measures real-money revenue (dollars), not virtual-
  // currency units. Revenue attribution per currency is out of scope.
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
    outstandingWalletCount: walletCount,
    issued28d: issued,
    burned28d: burned,
    revenue28dUsd: revRows[0]?.sumUsd ?? "0",
    breakagePct,
  };
}

// =============================================================
// PG: window-scoped sums by ledger type
// =============================================================
//
// One query returns the absolute-value sum for every ledger type
// in the window. Inflow types (PURCHASE/BONUS/REFUND/TRANSFER_IN)
// carry positive deltas; outflow types (SPEND/EXPIRE/TRANSFER_OUT)
// carry negative deltas, and we surface them positive so the UI
// can render without a per-row sign flip.

interface PgFlowRow {
  type: string;
  total: string;
}

const ZERO_FLOW: CreditsFlowByType = {
  purchase: 0,
  bonus: 0,
  refund: 0,
  transferIn: 0,
  spend: 0,
  expire: 0,
  transferOut: 0,
};

async function readFlowByType(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<{ inflow: CreditsFlowByType; outflow: CreditsFlowByType }> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      type: cl.type,
      total: sql<string>`COALESCE(SUM(ABS("amount")), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        gte(cl.createdAt, window.from),
        lte(cl.createdAt, window.to),
        ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
      ),
    )
    .groupBy(cl.type);

  const inflow: CreditsFlowByType = { ...ZERO_FLOW };
  const outflow: CreditsFlowByType = { ...ZERO_FLOW };
  for (const r of rows as PgFlowRow[]) {
    const n = Number(r.total);
    switch (r.type) {
      case "PURCHASE":
        inflow.purchase = n;
        break;
      case "BONUS":
        inflow.bonus = n;
        break;
      case "REFUND":
        inflow.refund = n;
        break;
      case "TRANSFER_IN":
        inflow.transferIn = n;
        break;
      case "SPEND":
        outflow.spend = n;
        break;
      case "EXPIRE":
        outflow.expire = n;
        break;
      case "TRANSFER_OUT":
        outflow.transferOut = n;
        break;
    }
  }
  return { inflow, outflow };
}

// =============================================================
// PG: liability composition
// =============================================================
//
// Splits the outstanding balance into paid (PURCHASE+REFUND),
// promo (BONUS), and transfer (TRANSFER_IN) shares using lifetime
// inflow ratios. credit_ledger doesn't track per-batch attribution
// so this is an approximation, not a true FIFO/LIFO accounting.
// `averageAgeDays` is the amount-weighted age across all positive
// ledger rows in the trailing 365 days, capped so a one-off ancient
// row can't drag the average. Reserve = paid × avgCreditPrice in
// USD; delta compares against the same-length prior window.

const AGE_LOOKBACK_DAYS = 365;
const AVG_AGE_LOOKBACK_MS = AGE_LOOKBACK_DAYS * DAY_MS;

async function readLifetimeInflowSplit(
  projectId: string,
  currencyId?: string,
): Promise<{ paid: number; promo: number; transfer: number }> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      type: cl.type,
      total: sql<string>`COALESCE(SUM("amount"), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        gte(cl.amount, 1),
        ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
      ),
    )
    .groupBy(cl.type);
  let paid = 0;
  let promo = 0;
  let transfer = 0;
  for (const r of rows as PgFlowRow[]) {
    const n = Number(r.total);
    if (r.type === "PURCHASE" || r.type === "REFUND") paid += n;
    else if (r.type === "BONUS") promo += n;
    else if (r.type === "TRANSFER_IN") transfer += n;
  }
  return { paid, promo, transfer };
}

async function readAverageAgeDays(
  projectId: string,
  currencyId?: string,
): Promise<number | null> {
  const cutoff = new Date(Date.now() - AVG_AGE_LOOKBACK_MS);
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db.execute<{ avg_days: string | null }>(sql`
    SELECT (SUM(EXTRACT(EPOCH FROM (NOW() - "createdAt")) * "amount")
            / NULLIF(SUM("amount"), 0)) / 86400.0 AS avg_days
    FROM ${cl}
    WHERE "projectId" = ${projectId}${currencyClause(currencyId)}
      AND "amount" > 0
      AND "createdAt" >= ${cutoff}
  `);
  const v = rows.rows[0]?.avg_days;
  return v == null ? null : Number(v);
}

async function readWindowCreditPurchaseUsd(
  projectId: string,
  window: RollupWindow,
): Promise<number> {
  // Intentionally project-wide: revenue_events has no currencyId column —
  // CREDIT_PURCHASE USD is real-money revenue (dollars), not virtual-currency
  // units. Revenue attribution per currency is out of scope.
  const rev = drizzle.schema.revenueEvents;
  const rows = await drizzle.db
    .select({
      sumUsd: sql<string>`COALESCE(SUM("amountUsd"), 0)::text`,
    })
    .from(rev)
    .where(
      and(
        eq(rev.projectId, projectId),
        eq(rev.type, "CREDIT_PURCHASE"),
        gte(rev.eventDate, window.from),
        lte(rev.eventDate, window.to),
      ),
    );
  return Number(rows[0]?.sumUsd ?? "0");
}

async function readWindowIssued(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
): Promise<number> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      total: sql<string>`COALESCE(SUM(CASE WHEN "amount" > 0 THEN "amount" ELSE 0 END), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        gte(cl.createdAt, window.from),
        lte(cl.createdAt, window.to),
        ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
      ),
    );
  return Number(rows[0]?.total ?? "0");
}

interface LiabilityInputs {
  outstanding: number;
  windowRevenueUsd: number;
  windowIssued: number;
  prevWindowRevenueUsd: number;
  prevWindowIssued: number;
}

async function readLiability(
  projectId: string,
  inputs: LiabilityInputs,
  currencyId?: string,
): Promise<CreditsLiability> {
  const [split, averageAgeDays] = await Promise.all([
    readLifetimeInflowSplit(projectId, currencyId),
    readAverageAgeDays(projectId, currencyId),
  ]);

  const totalInflow = split.paid + split.promo + split.transfer;
  const paidShare = totalInflow > 0 ? split.paid / totalInflow : 0;
  const promoShare = totalInflow > 0 ? split.promo / totalInflow : 0;
  const transferShare = totalInflow > 0 ? split.transfer / totalInflow : 0;

  const avgCreditPriceUsd =
    inputs.windowIssued > 0 ? inputs.windowRevenueUsd / inputs.windowIssued : 0;
  const paidReserveCents = Math.round(
    paidShare * inputs.outstanding * avgCreditPriceUsd * 100,
  );
  const paidReserveUsd = (paidReserveCents / 100).toFixed(2);

  const prevAvgPrice =
    inputs.prevWindowIssued > 0
      ? inputs.prevWindowRevenueUsd / inputs.prevWindowIssued
      : 0;
  const prevReserve = paidShare * inputs.outstanding * prevAvgPrice;
  const currentReserve = paidReserveCents / 100;
  const reserveDeltaPct =
    prevReserve > 0 ? ((currentReserve - prevReserve) / prevReserve) * 100 : null;

  return {
    paidShare,
    promoShare,
    transferShare,
    paidReserveUsd,
    reserveDeltaPct,
    averageAgeDays,
  };
}

// =============================================================
// PG: top burning reference buckets
// =============================================================

async function readTopBurners(
  projectId: string,
  window: RollupWindow,
  currencyId?: string,
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
        ...(currencyId ? [eq(cl.currencyId, currencyId)] : []),
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
  currencyId?: string,
): Promise<CreditsLedgerRow[]> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select()
    .from(cl)
    .where(
      currencyId
        ? and(eq(cl.projectId, projectId), eq(cl.currencyId, currencyId))
        : eq(cl.projectId, projectId),
    )
    .orderBy(desc(cl.createdAt), desc(cl.id))
    .limit(LEDGER_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    subscriberId: r.subscriberId,
    currencyId: r.currencyId,
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
  currencyId?: string,
): Promise<
  Map<
    string,
    { identifier: string; displayName: string; creditAmount: number | null }
  >
> {
  if (productIds.length === 0) return new Map();
  const ids = [...productIds];
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
        inArray(drizzle.schema.products.id, ids),
      ),
    );

  // The granted amount comes from product_currency_grants (the actual grant
  // source) for the rollup's currency. With no currency filter a product can
  // grant several currencies, so a single number is ambiguous → null. (The
  // old code read the dead products.creditAmount column, which the purchase
  // grant path never reads.)
  const grantByProduct = new Map<string, number>();
  if (currencyId) {
    const grants = await drizzle.db
      .select({
        productId: drizzle.schema.productCurrencyGrants.productId,
        amount: drizzle.schema.productCurrencyGrants.amount,
      })
      .from(drizzle.schema.productCurrencyGrants)
      .where(
        and(
          inArray(drizzle.schema.productCurrencyGrants.productId, ids),
          eq(drizzle.schema.productCurrencyGrants.currencyId, currencyId),
        ),
      );
    for (const g of grants) grantByProduct.set(g.productId, g.amount);
  }

  return new Map(
    rows.map((r) => [
      r.id,
      {
        identifier: r.identifier,
        displayName: r.displayName,
        creditAmount: currencyId ? (grantByProduct.get(r.id) ?? null) : null,
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
  currencyId?: string;
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

  const prevWindow: RollupWindow = {
    from: new Date(window.from.getTime() - window.days * DAY_MS),
    to: new Date(window.from.getTime() - 1),
    days: window.days,
  };

  const [
    kpis,
    volume,
    packagesRaw,
    topBurners,
    ledger,
    flowByType,
    prevRevenueUsd,
    prevIssued,
  ] = await Promise.all([
    readKpis(input.projectId, window, input.currencyId),
    readVolume(input.projectId, window, input.currencyId),
    readPackages(input.projectId, window),
    readTopBurners(input.projectId, window, input.currencyId),
    readRecentLedger(input.projectId, input.currencyId),
    readFlowByType(input.projectId, window, input.currencyId),
    readWindowCreditPurchaseUsd(input.projectId, prevWindow),
    readWindowIssued(input.projectId, prevWindow, input.currencyId),
  ]);

  const liability = await readLiability(
    input.projectId,
    {
      outstanding: kpis.outstanding,
      windowRevenueUsd: Number(kpis.revenue28dUsd),
      windowIssued: kpis.issued28d,
      prevWindowRevenueUsd: prevRevenueUsd,
      prevWindowIssued: prevIssued,
    },
    input.currencyId,
  );

  const flow: CreditsFlow = {
    inflow: kpis.issued28d,
    outflow: kpis.burned28d,
    balance: kpis.outstanding,
    inflowByType: flowByType.inflow,
    outflowByType: flowByType.outflow,
    balanceByType: {
      paid: Math.round(liability.paidShare * kpis.outstanding),
      promo: Math.round(liability.promoShare * kpis.outstanding),
      transfer: Math.round(liability.transferShare * kpis.outstanding),
    },
  };

  const productDisplay = await fetchProductDisplay(
    input.projectId,
    packagesRaw.map((p) => p.productId),
    input.currencyId,
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
    flow,
    liability,
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
