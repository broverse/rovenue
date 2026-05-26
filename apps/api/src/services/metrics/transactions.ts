import { and, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  RevenueEventTypeName,
  TransactionRow,
  TransactionScope,
  TransactionStoreFilter,
  TransactionsListResponse,
  TransactionsListSort,
  TransactionsStoreBreakdownResponse,
  TransactionsStoreBreakdownRow,
  TransactionsSyncResponse,
  TransactionsVolumePoint,
  TransactionsVolumeResponse,
} from "@rovenue/shared";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../../lib/clickhouse";

// =============================================================
// Transactions rollup (Phase 3.2)
// =============================================================
//
// Three reads, all keyed by projectId:
//
//   GET /transactions               cursor-paginated list,
//                                   scope + free-text filters
//   GET /transactions/volume        daily stacked counts for the
//                                   28-day strip across the top
//   GET /transactions/store-breakdown
//                                   per-store gross-USD share for
//                                   the same window
//
// The list endpoint uses a (eventDate, eventId) tuple cursor so
// ties at the same instant don't drop rows. Product names are
// resolved in a single PG roundtrip after the CH page returns,
// keeping the per-row CH SELECT lean.

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;
const VOLUME_WINDOW_DEFAULT_DAYS = 28;
const VOLUME_WINDOW_MAX_DAYS = 90;
const STORE_WINDOW_DEFAULT_DAYS = 28;
const STORE_WINDOW_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// =============================================================
// Scope → CH `type` filter
// =============================================================

const SCOPE_TYPES: Record<TransactionScope, ReadonlyArray<RevenueEventTypeName> | null> = {
  all: null,
  purchase: ["INITIAL", "REACTIVATION", "CREDIT_PURCHASE"],
  renewal: ["RENEWAL"],
  refund: ["REFUND"],
  trial: ["TRIAL_CONVERSION"],
  // We don't track failed/disputed events in `revenue_events`
  // today — the table only carries settled ledger rows. The
  // scope is accepted so the UI doesn't 4xx when the user picks
  // the tab; the empty result is the honest answer until a
  // payment-attempt log lands.
  failed: [],
};

function scopeClause(scope: TransactionScope, paramName: string): string {
  const types = SCOPE_TYPES[scope];
  if (types === null) return "";
  if (types.length === 0) return "AND 0";
  return `AND type IN ({${paramName}:Array(String)})`;
}

function scopeParam(
  scope: TransactionScope,
): ReadonlyArray<string> | undefined {
  const types = SCOPE_TYPES[scope];
  if (types === null || types.length === 0) return undefined;
  return [...types];
}

// =============================================================
// Cursor encoding
// =============================================================
//
// Opaque base64 of `${eventDateIso}|${eventId}`. The previous-
// page cutoff is reconstructed from the cursor on each request,
// so the wire format is forward-compatible with future sort
// keys (just bump the schema and version-prefix the cursor).

const CURSOR_VERSION = "v1";

export interface ParsedCursor {
  eventDate: Date;
  eventId: string;
}

export function encodeCursor(cursor: ParsedCursor): string {
  const raw = `${CURSOR_VERSION}|${cursor.eventDate.toISOString()}|${cursor.eventId}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): ParsedCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [version, dateStr, eventId] = raw.split("|");
    if (version !== CURSOR_VERSION || !dateStr || !eventId) return null;
    const eventDate = new Date(dateStr);
    if (Number.isNaN(eventDate.getTime())) return null;
    return { eventDate, eventId };
  } catch {
    return null;
  }
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toDateTimeStr(d: Date): string {
  // CH parses 'YYYY-MM-DD HH:mm:ss.SSS' as DateTime64.
  return d.toISOString().replace("T", " ").replace("Z", "");
}

// =============================================================
// PG product display lookup (shared with overview shape)
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
// List
// =============================================================

interface ChTransactionRow {
  eventId: string;
  type: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  store: string;
  amount_usd: string;
  currency: string;
  event_date: string;
}

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
// Store / sort / extra filter mappings
// =============================================================

const STORE_FILTER_MAP: Record<TransactionStoreFilter, ReadonlyArray<string>> = {
  ios: ["APP_STORE", "APPLE", "IOS"],
  play: ["PLAY_STORE", "GOOGLE", "PLAY"],
  stripe: ["STRIPE"],
  web: ["WEB", "DIRECT"],
};

function expandStoreFilters(
  stores: ReadonlyArray<TransactionStoreFilter> | undefined,
): string[] | undefined {
  if (!stores || stores.length === 0) return undefined;
  const acc = new Set<string>();
  for (const s of stores) {
    for (const raw of STORE_FILTER_MAP[s] ?? []) acc.add(raw);
  }
  return acc.size > 0 ? [...acc] : undefined;
}

function orderByClause(sort: TransactionsListSort): string {
  switch (sort) {
    case "oldest":
      return "ORDER BY eventDate ASC, eventId ASC";
    case "amount_desc":
      return "ORDER BY amountUsd DESC, eventDate DESC, eventId DESC";
    case "amount_asc":
      return "ORDER BY amountUsd ASC, eventDate DESC, eventId DESC";
    case "newest":
    default:
      return "ORDER BY eventDate DESC, eventId DESC";
  }
}

function cursorClauseFor(
  sort: TransactionsListSort,
  hasCursor: boolean,
): string {
  if (!hasCursor) return "";
  // Cursors only apply to the time-ordered modes today. Amount
  // sorts use offset paging in the route; we still accept a
  // cursor for forward-compat but treat it as a time-bound.
  if (sort === "oldest") {
    return "AND (eventDate, eventId) > ({cursorDate:DateTime64(3)}, {cursorId:String})";
  }
  return "AND (eventDate, eventId) < ({cursorDate:DateTime64(3)}, {cursorId:String})";
}

function buildFilterClauses(input: {
  scope: TransactionScope;
  q?: string;
  storesRaw?: ReadonlyArray<string>;
  currencies?: ReadonlyArray<string>;
  amountMin?: number;
  from?: Date;
  to?: Date;
}): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  const scopeSql = scopeClause(input.scope, "scopeTypes");
  if (scopeSql) parts.push(scopeSql);
  const scopeTypes = scopeParam(input.scope);
  if (scopeTypes) params.scopeTypes = scopeTypes;

  if (input.q && input.q.trim().length > 0) {
    parts.push(
      "AND (positionCaseInsensitive(subscriberId, {q:String}) > 0 OR positionCaseInsensitive(purchaseId, {q:String}) > 0 OR positionCaseInsensitive(productId, {q:String}) > 0 OR positionCaseInsensitive(eventId, {q:String}) > 0)",
    );
    params.q = input.q.trim();
  }

  if (input.storesRaw && input.storesRaw.length > 0) {
    parts.push("AND store IN ({stores:Array(String)})");
    params.stores = [...input.storesRaw];
  }

  if (input.currencies && input.currencies.length > 0) {
    parts.push("AND upper(currency) IN ({currencies:Array(String)})");
    params.currencies = input.currencies.map((c) => c.toUpperCase());
  }

  if (typeof input.amountMin === "number" && Number.isFinite(input.amountMin)) {
    parts.push("AND abs(amountUsd) >= {amountMin:Float64}");
    params.amountMin = input.amountMin;
  }

  if (input.from) {
    parts.push("AND eventDate >= {filterFrom:DateTime64(3)}");
    params.filterFrom = toDateTimeStr(input.from);
  }

  if (input.to) {
    parts.push("AND eventDate <= {filterTo:DateTime64(3)}");
    params.filterTo = toDateTimeStr(input.to);
  }

  return { sql: parts.join("\n        "), params };
}

export interface ListTransactionsInput {
  projectId: string;
  scope: TransactionScope;
  limit: number;
  cursor: ParsedCursor | null;
  q?: string;
  stores?: ReadonlyArray<TransactionStoreFilter>;
  currencies?: ReadonlyArray<string>;
  amountMin?: number;
  from?: Date;
  to?: Date;
  sort?: TransactionsListSort;
  offset?: number;
}

export async function listTransactions(
  input: ListTransactionsInput,
): Promise<TransactionsListResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const limit = Math.min(Math.max(input.limit, 1), PAGE_LIMIT_MAX);
  const sort: TransactionsListSort = input.sort ?? "newest";
  const useOffset = sort === "amount_desc" || sort === "amount_asc";
  const offset = useOffset ? Math.max(0, input.offset ?? 0) : 0;

  const filter = buildFilterClauses({
    scope: input.scope,
    q: input.q,
    storesRaw: expandStoreFilters(input.stores),
    currencies: input.currencies,
    amountMin: input.amountMin,
    from: input.from,
    to: input.to,
  });

  const cursorSql = useOffset
    ? ""
    : cursorClauseFor(sort, Boolean(input.cursor));
  const orderSql = orderByClause(sort);

  // Over-fetch by 1 so we know whether the page is the last one
  // without a second COUNT query.
  const fetchLimit = limit + 1;

  const rows = await queryAnalytics<ChTransactionRow>(
    input.projectId,
    `
      SELECT
        eventId,
        type,
        subscriberId,
        purchaseId,
        productId,
        store,
        toString(amountUsd)                                  AS amount_usd,
        currency,
        formatDateTime(eventDate, '%Y-%m-%dT%H:%i:%S.%fZ')   AS event_date
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        ${cursorSql}
        ${filter.sql}
      ${orderSql}
      LIMIT {limit:UInt32}${useOffset ? " OFFSET {offset:UInt32}" : ""}
    `,
    {
      limit: fetchLimit,
      ...(useOffset ? { offset } : {}),
      ...(!useOffset && input.cursor
        ? {
            cursorDate: toDateTimeStr(input.cursor.eventDate),
            cursorId: input.cursor.eventId,
          }
        : {}),
      ...filter.params,
    },
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const productDisplay = await fetchProductDisplay(
    input.projectId,
    page.map((r) => r.productId),
  );

  const mapped: TransactionRow[] = page.map((row) => {
    const meta = productDisplay.get(row.productId);
    const type: RevenueEventTypeName = isKnownRevenueType(row.type)
      ? row.type
      : "INITIAL";
    return {
      id: row.eventId,
      type,
      subscriberId: row.subscriberId,
      purchaseId: row.purchaseId,
      productId: row.productId,
      productName: meta?.displayName ?? null,
      productIdentifier: meta?.identifier ?? null,
      store: row.store,
      amountUsd: row.amount_usd,
      currency: row.currency,
      eventDate: row.event_date,
    };
  });

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last && !useOffset
      ? encodeCursor({
          eventDate: new Date(last.event_date),
          eventId: last.eventId,
        })
      : useOffset && hasMore
        ? encodeOffsetCursor(offset + limit)
        : null;

  return { rows: mapped, nextCursor };
}

// =============================================================
// Offset-cursor encoding (amount sort modes)
// =============================================================

const OFFSET_CURSOR_PREFIX = "off:";

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`${OFFSET_CURSOR_PREFIX}${offset}`, "utf8").toString(
    "base64url",
  );
}

export function decodeOffsetCursor(token: string): number | null {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    if (!raw.startsWith(OFFSET_CURSOR_PREFIX)) return null;
    const n = Number.parseInt(raw.slice(OFFSET_CURSOR_PREFIX.length), 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

// =============================================================
// Sync stores — surfaces outbox lag as a freshness signal
// =============================================================

export async function syncTransactions(input: {
  projectId: string;
}): Promise<TransactionsSyncResponse> {
  // Outbox lag is project-agnostic at the row level (the table is
  // shared across projects via the payload). Counting unpublished
  // rows older than 5 seconds is the cheapest "is the dispatcher
  // caught up?" signal we have today — newer rows are expected in
  // flight.
  const cutoff = new Date(Date.now() - 5_000);
  const rows = await drizzle.db
    .select({
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(drizzle.schema.outboxEvents)
    .where(
      and(
        isNull(drizzle.schema.outboxEvents.publishedAt),
        drizzleSql`${drizzle.schema.outboxEvents.aggregateType} = 'REVENUE_EVENT'`,
        drizzleSql`${drizzle.schema.outboxEvents.createdAt} <= ${cutoff}`,
      ),
    );
  const pending = rows[0]?.count ?? 0;
  void input;
  return {
    syncedAt: new Date().toISOString(),
    pendingOutbox: pending,
  };
}

// =============================================================
// CSV export — streams the filtered list without paging
// =============================================================

const CSV_HARD_LIMIT = 50_000;

export interface ExportTransactionsInput {
  projectId: string;
  scope: TransactionScope;
  q?: string;
  stores?: ReadonlyArray<TransactionStoreFilter>;
  currencies?: ReadonlyArray<string>;
  amountMin?: number;
  from?: Date;
  to?: Date;
  sort?: TransactionsListSort;
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function exportTransactionsCsv(
  input: ExportTransactionsInput,
): Promise<string> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }

  const filter = buildFilterClauses({
    scope: input.scope,
    q: input.q,
    storesRaw: expandStoreFilters(input.stores),
    currencies: input.currencies,
    amountMin: input.amountMin,
    from: input.from,
    to: input.to,
  });

  const orderSql = orderByClause(input.sort ?? "newest");

  const rows = await queryAnalytics<ChTransactionRow>(
    input.projectId,
    `
      SELECT
        eventId,
        type,
        subscriberId,
        purchaseId,
        productId,
        store,
        toString(amountUsd)                                  AS amount_usd,
        currency,
        formatDateTime(eventDate, '%Y-%m-%dT%H:%i:%S.%fZ')   AS event_date
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        ${filter.sql}
      ${orderSql}
      LIMIT {limit:UInt32}
    `,
    {
      limit: CSV_HARD_LIMIT,
      ...filter.params,
    },
  );

  const productDisplay = await fetchProductDisplay(
    input.projectId,
    rows.map((r) => r.productId),
  );

  const header = [
    "event_id",
    "type",
    "event_date",
    "subscriber_id",
    "purchase_id",
    "product_id",
    "product_identifier",
    "product_name",
    "store",
    "amount_usd",
    "currency",
  ].join(",");

  const body = rows.map((row) => {
    const meta = productDisplay.get(row.productId);
    return [
      csvField(row.eventId),
      csvField(row.type),
      csvField(row.event_date),
      csvField(row.subscriberId),
      csvField(row.purchaseId),
      csvField(row.productId),
      csvField(meta?.identifier ?? ""),
      csvField(meta?.displayName ?? ""),
      csvField(row.store),
      csvField(row.amount_usd),
      csvField(row.currency),
    ].join(",");
  });

  return `${header}\n${body.join("\n")}\n`;
}

// =============================================================
// Daily volume (stacked counts)
// =============================================================

interface ChVolumeRow {
  day: string;
  purchases: string;
  renewals: string;
  refunds: string;
}

export interface ListVolumeInput {
  projectId: string;
  windowDays: number;
}

export async function listTransactionsVolume(
  input: ListVolumeInput,
): Promise<TransactionsVolumeResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const windowDays = Math.min(
    Math.max(input.windowDays, 1),
    VOLUME_WINDOW_MAX_DAYS,
  );
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - (windowDays - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);

  const rows = await queryAnalytics<ChVolumeRow>(
    input.projectId,
    `
      SELECT
        toString(toDate(eventDate))                                            AS day,
        toString(countIf(type IN ('INITIAL','REACTIVATION','CREDIT_PURCHASE'))) AS purchases,
        toString(countIf(type = 'RENEWAL'))                                     AS renewals,
        toString(countIf(type IN ('REFUND','CHARGEBACK')))                       AS refunds
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY toDate(eventDate)
      ORDER BY day ASC
    `,
    {
      from: toDateOnly(from),
      to: toDateOnly(to),
    },
  );

  // Fill missing days with zeros so the stacked-bar component
  // can render a continuous 28-day strip without branching on
  // gaps. Keeps the wire shape predictable.
  const byDay = new Map<string, ChVolumeRow>(rows.map((r) => [r.day, r]));
  const points: TransactionsVolumePoint[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(from.getTime() + i * DAY_MS);
    const key = toDateOnly(d);
    const row = byDay.get(key);
    points.push({
      day: key,
      purchases: Number(row?.purchases ?? "0"),
      renewals: Number(row?.renewals ?? "0"),
      refunds: Number(row?.refunds ?? "0"),
    });
  }

  return { windowDays, points };
}

// =============================================================
// Store breakdown
// =============================================================

interface ChStoreRow {
  store: string;
  gross_usd: string;
  event_count: string;
}

interface ChWindowAggregateRow {
  refunds_usd: string;
  prev_gross_usd: string;
}

/**
 * Estimated store fee rates. We don't record actual fees in
 * `revenue_events`, so the dashboard reports these as estimates.
 * Apple/Google's small-business rate (15%) is the safer default
 * than 30% for the typical Rovenue customer. Stripe is the
 * standard published rate. Self-billed channels are 0%.
 */
const STORE_FEE_RATE: Record<string, number> = {
  APP_STORE: 0.15,
  APPLE: 0.15,
  IOS: 0.15,
  PLAY_STORE: 0.15,
  GOOGLE: 0.15,
  PLAY: 0.15,
  STRIPE: 0.029,
  WEB: 0,
  DIRECT: 0,
};

function feeRateFor(store: string): number {
  const rate = STORE_FEE_RATE[store.toUpperCase()];
  return typeof rate === "number" ? rate : 0;
}

export interface ListStoreBreakdownInput {
  projectId: string;
  windowDays: number;
}

export async function listStoreBreakdown(
  input: ListStoreBreakdownInput,
): Promise<TransactionsStoreBreakdownResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const windowDays = Math.min(
    Math.max(input.windowDays, 1),
    STORE_WINDOW_MAX_DAYS,
  );
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - (windowDays - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);
  const prevTo = new Date(from.getTime() - 1);
  prevTo.setUTCHours(23, 59, 59, 999);
  const prevFrom = new Date(prevTo.getTime() - (windowDays - 1) * DAY_MS);
  prevFrom.setUTCHours(0, 0, 0, 0);

  const [rows, aggRows] = await Promise.all([
    queryAnalytics<ChStoreRow>(
      input.projectId,
      `
        SELECT
          store,
          toString(sum(amountUsd))   AS gross_usd,
          toString(count())          AS event_count
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {from:Date}
          AND toDate(eventDate) <= {to:Date}
          AND type NOT IN ('REFUND','CHARGEBACK')
        GROUP BY store
        ORDER BY sum(amountUsd) DESC
      `,
      {
        from: toDateOnly(from),
        to: toDateOnly(to),
      },
    ),
    queryAnalytics<ChWindowAggregateRow>(
      input.projectId,
      `
        SELECT
          toString(sumIf(abs(amountUsd), type IN ('REFUND','CHARGEBACK') AND toDate(eventDate) >= {from:Date} AND toDate(eventDate) <= {to:Date}))                                                          AS refunds_usd,
          toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK') AND toDate(eventDate) >= {prevFrom:Date} AND toDate(eventDate) <= {prevTo:Date}))                                                  AS prev_gross_usd
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {prevFrom:Date}
          AND toDate(eventDate) <= {to:Date}
      `,
      {
        from: toDateOnly(from),
        to: toDateOnly(to),
        prevFrom: toDateOnly(prevFrom),
        prevTo: toDateOnly(prevTo),
      },
    ),
  ]);

  const total = rows.reduce((a, r) => a + Number(r.gross_usd), 0);
  let estimatedFeesUsd = 0;
  let totalEventCount = 0;

  const mapped: TransactionsStoreBreakdownRow[] = rows.map((r) => {
    const g = Number(r.gross_usd);
    const rate = feeRateFor(r.store);
    const fee = g * rate;
    estimatedFeesUsd += fee;
    const eventCount = Number(r.event_count);
    totalEventCount += eventCount;
    return {
      store: r.store,
      grossUsd: r.gross_usd,
      pct: total > 0 ? Math.round((g / total) * 1000) / 10 : 0,
      eventCount,
      estimatedFeeUsd: fee.toFixed(4),
      estimatedFeePct: Math.round(rate * 1000) / 10,
    };
  });

  const agg = aggRows[0] ?? { refunds_usd: "0", prev_gross_usd: "0" };
  const refunds = Number(agg.refunds_usd) || 0;
  const previous = Number(agg.prev_gross_usd) || 0;
  const deltaPct =
    previous > 0 ? Math.round(((total - previous) / previous) * 1000) / 10 : null;
  const blendedFeePct =
    total > 0 ? Math.round((estimatedFeesUsd / total) * 1000) / 10 : 0;

  return {
    windowDays,
    rows: mapped,
    totalUsd: total.toFixed(4),
    eventCount: totalEventCount,
    refundsUsd: refunds.toFixed(4),
    previousTotalUsd: previous.toFixed(4),
    deltaPct,
    estimatedFeesUsd: estimatedFeesUsd.toFixed(4),
    estimatedFeePct: blendedFeePct,
  };
}

export const __transactionsConstants = {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  VOLUME_WINDOW_DEFAULT_DAYS,
  VOLUME_WINDOW_MAX_DAYS,
  STORE_WINDOW_DEFAULT_DAYS,
  STORE_WINDOW_MAX_DAYS,
};
