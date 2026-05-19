import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  RevenueEventTypeName,
  TransactionRow,
  TransactionScope,
  TransactionsListResponse,
  TransactionsStoreBreakdownResponse,
  TransactionsStoreBreakdownRow,
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

export interface ListTransactionsInput {
  projectId: string;
  scope: TransactionScope;
  limit: number;
  cursor: ParsedCursor | null;
}

export async function listTransactions(
  input: ListTransactionsInput,
): Promise<TransactionsListResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const limit = Math.min(Math.max(input.limit, 1), PAGE_LIMIT_MAX);

  const cursorClause = input.cursor
    ? "AND (eventDate, eventId) < ({cursorDate:DateTime64(3)}, {cursorId:String})"
    : "";
  const scopeClauseSql = scopeClause(input.scope, "scopeTypes");

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
        ${cursorClause}
        ${scopeClauseSql}
      ORDER BY eventDate DESC, eventId DESC
      LIMIT {limit:UInt32}
    `,
    {
      limit: fetchLimit,
      ...(input.cursor
        ? {
            cursorDate: toDateTimeStr(input.cursor.eventDate),
            cursorId: input.cursor.eventId,
          }
        : {}),
      ...(scopeParam(input.scope)
        ? { scopeTypes: scopeParam(input.scope) }
        : {}),
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
    hasMore && last
      ? encodeCursor({
          eventDate: new Date(last.event_date),
          eventId: last.eventId,
        })
      : null;

  return { rows: mapped, nextCursor };
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

  const rows = await queryAnalytics<ChStoreRow>(
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
  );

  const total = rows.reduce((a, r) => a + Number(r.gross_usd), 0);
  const mapped: TransactionsStoreBreakdownRow[] = rows.map((r) => {
    const g = Number(r.gross_usd);
    return {
      store: r.store,
      grossUsd: r.gross_usd,
      pct: total > 0 ? Math.round((g / total) * 1000) / 10 : 0,
      eventCount: Number(r.event_count),
    };
  });

  return {
    windowDays,
    rows: mapped,
    totalUsd: total.toFixed(4),
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
