import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  BillingIssueRow,
  BillingIssuesResponse,
  RenewalCalendarDay,
  RenewalCalendarResponse,
  SubscriptionRow,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionUiStatus,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
} from "@rovenue/shared";

// =============================================================
// Subscriptions rollup (Phase 3.3)
// =============================================================
//
// Backed by Postgres `purchases` — the authoritative source of
// subscription lifecycle state. ClickHouse mirrors the event log
// (revenue / credits) but the *current* status of a subscription
// is a row-level field that needs PG to serve.
//
//   GET /subscriptions               cursor list
//   GET /subscriptions/kpis          top-of-page stat cards
//   GET /subscriptions/composition   live segments + total
//   GET /subscriptions/renewal-calendar
//                                    daily upcoming + past stack
//   GET /subscriptions/billing-issues
//                                    grace / declined retry rows
//
// All endpoints accept the same project context — the page
// fans them out in parallel.

const DAY_MS = 24 * 60 * 60 * 1000;

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

const CALENDAR_PAST_DEFAULT_DAYS = 6;
const CALENDAR_FUTURE_DEFAULT_DAYS = 7;
const CALENDAR_MAX_DAYS = 60;

const RENEWING_WINDOW_DAYS = 7;

// =============================================================
// Status mapping
// =============================================================
//
// The DB enum encodes finer-grained billing state than the UI
// surfaces. The dashboard's scope tabs collapse them to:
//
//   TRIAL                                      → trial
//   ACTIVE  + autoRenewStatus !== false        → active
//   ACTIVE  + autoRenewStatus === false        → canceling
//   GRACE_PERIOD | PAUSED                      → grace
//   EXPIRED | REFUNDED | REVOKED               → churned
//
// `mapStatus` returns the UI key per row; the SQL helpers below
// use the equivalent CASE expression so filters stay aligned
// between server and client.

const LIVE_STATUSES: ReadonlyArray<"TRIAL" | "ACTIVE" | "GRACE_PERIOD" | "PAUSED"> = [
  "TRIAL",
  "ACTIVE",
  "GRACE_PERIOD",
  "PAUSED",
];

const CHURNED_STATUSES: ReadonlyArray<"EXPIRED" | "REFUNDED" | "REVOKED"> = [
  "EXPIRED",
  "REFUNDED",
  "REVOKED",
];

function mapStatus(row: {
  status: string;
  autoRenewStatus: boolean | null;
}): SubscriptionUiStatus {
  switch (row.status) {
    case "TRIAL":
      return "trial";
    case "ACTIVE":
      return row.autoRenewStatus === false ? "canceling" : "active";
    case "GRACE_PERIOD":
    case "PAUSED":
      return "grace";
    case "EXPIRED":
    case "REFUNDED":
    case "REVOKED":
      return "churned";
    default:
      return "active";
  }
}

// =============================================================
// Cursor v2 (sortKey + sortValue + id)
// =============================================================

const CURSOR_VERSION = "v2";

export interface ParsedSubsCursor {
  sort: SubscriptionSortKey;
  /** ISO timestamp / decimal string / status enum / "" when sortValue is NULL. */
  sortValue: string;
  id: string;
}

export function encodeSubsCursor(c: ParsedSubsCursor): string {
  const raw = `${CURSOR_VERSION}|${c.sort}|${c.sortValue}|${c.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeSubsCursor(
  cursor: string,
  expectedSort: SubscriptionSortKey,
): ParsedSubsCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = raw.split("|");
    if (parts.length !== 4) return null;
    const [version, sort, sortValue, id] = parts;
    if (version !== CURSOR_VERSION) return null;
    if (sort !== expectedSort) return null;
    if (!id) return null;
    return {
      sort: sort as SubscriptionSortKey,
      sortValue,
      id,
    };
  } catch {
    return null;
  }
}

// =============================================================
// Product display lookup (project-scoped)
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
// Scope → WHERE
// =============================================================

function scopeWhere(scope: SubscriptionScopeName, now: Date) {
  const p = drizzle.schema.purchases;
  switch (scope) {
    case "all":
      return undefined;
    case "active":
      return and(
        eq(p.status, "ACTIVE"),
        or(isNull(p.autoRenewStatus), eq(p.autoRenewStatus, true)),
      );
    case "trial":
      return eq(p.status, "TRIAL");
    case "grace":
      return inArray(p.status, ["GRACE_PERIOD", "PAUSED"]);
    case "canceling":
      return and(eq(p.status, "ACTIVE"), eq(p.autoRenewStatus, false));
    case "churned":
      return inArray(p.status, ["EXPIRED", "REFUNDED", "REVOKED"]);
    case "issues":
      return and(
        eq(p.status, "GRACE_PERIOD"),
        or(
          isNull(p.gracePeriodExpires),
          gte(p.gracePeriodExpires, now),
        ),
      );
    default:
      return undefined;
  }
}

// =============================================================
// List
// =============================================================

export interface ListSubscriptionsInput {
  projectId: string;
  scope: SubscriptionScopeName;
  limit: number;
  cursor: ParsedSubsCursor | null;
  search: string | null;
  sort: SubscriptionSortKey;
  store: ReadonlyArray<SubscriptionStoreCode> | null;
  productId: ReadonlyArray<string> | null;
  autoRenew: boolean | null;
  isTrial: boolean | null;
  isIntro: boolean | null;
  hasIssue: boolean;
  purchasedFrom: string | null;
  purchasedTo: string | null;
  expiresFrom: string | null;
  expiresTo: string | null;
}

function buildListFilters(input: ListSubscriptionsInput) {
  const p = drizzle.schema.purchases;
  const filters: ReturnType<typeof and>[] = [];

  if (input.store && input.store.length > 0) {
    filters.push(inArray(p.store, [...input.store]));
  }
  if (input.productId && input.productId.length > 0) {
    filters.push(inArray(p.productId, [...input.productId]));
  }
  if (input.autoRenew !== null) {
    filters.push(eq(p.autoRenewStatus, input.autoRenew));
  }
  if (input.isTrial !== null) filters.push(eq(p.isTrial, input.isTrial));
  if (input.isIntro !== null) filters.push(eq(p.isIntroOffer, input.isIntro));
  if (input.hasIssue) {
    filters.push(
      and(
        eq(p.status, "GRACE_PERIOD"),
        or(isNull(p.autoRenewStatus), eq(p.autoRenewStatus, true)),
      )!,
    );
  }
  if (input.purchasedFrom) {
    filters.push(gte(p.purchaseDate, new Date(input.purchasedFrom)));
  }
  if (input.purchasedTo) {
    // Inclusive end-of-day so YYYY-MM-DD bounds work intuitively.
    const end = new Date(input.purchasedTo);
    end.setUTCHours(23, 59, 59, 999);
    filters.push(lte(p.purchaseDate, end));
  }
  if (input.expiresFrom) {
    filters.push(gte(p.expiresDate, new Date(input.expiresFrom)));
  }
  if (input.expiresTo) {
    const end = new Date(input.expiresTo);
    end.setUTCHours(23, 59, 59, 999);
    filters.push(lte(p.expiresDate, end));
  }
  if (input.search) {
    const needle = `%${input.search.toLowerCase()}%`;
    filters.push(
      or(
        ilike(p.id, needle),
        ilike(p.subscriberId, needle),
        ilike(p.storeTransactionId, needle),
      )!,
    );
  }
  return filters;
}

// Column accessor + direction descriptor per sort key. `nullable`
// flags the keys whose sort column can be NULL — those need an extra
// CASE expression to keep NULL rows at the end and still cursor through.
const SORT_DESCRIPTORS: Record<
  SubscriptionSortKey,
  {
    column: (p: typeof drizzle.schema.purchases) => any;
    direction: "asc" | "desc";
    nullable: boolean;
  }
> = {
  started_desc: {
    column: (p) => p.purchaseDate,
    direction: "desc",
    nullable: false,
  },
  started_asc: {
    column: (p) => p.purchaseDate,
    direction: "asc",
    nullable: false,
  },
  renews_asc: {
    column: (p) => p.expiresDate,
    direction: "asc",
    nullable: true,
  },
  renews_desc: {
    column: (p) => p.expiresDate,
    direction: "desc",
    nullable: true,
  },
  price_desc: {
    column: (p) => p.priceAmount,
    direction: "desc",
    nullable: true,
  },
  price_asc: {
    column: (p) => p.priceAmount,
    direction: "asc",
    nullable: true,
  },
  status: { column: (p) => p.status, direction: "asc", nullable: false },
};

function nullFlag(column: any) {
  // Postgres-side: 0 for non-NULL rows, 1 for NULL — sorted ASC keeps
  // NULL rows after everything else regardless of `direction`.
  return sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`;
}

function buildOrderBy(sort: SubscriptionSortKey) {
  const p = drizzle.schema.purchases;
  const desc_ = SORT_DESCRIPTORS[sort];
  const col = desc_.column(p);
  const dir = desc_.direction;
  const id = p.id;
  const order = [
    desc_.nullable ? asc(nullFlag(col)) : null,
    dir === "asc" ? asc(col) : desc(col),
    dir === "asc" ? asc(id) : desc(id),
  ].filter(Boolean) as any[];
  return order;
}

// Build the cursor WHERE: keeps the row order strictly monotonic across
// pages. Tuple compare in SQL using the same nullFlag-then-col-then-id
// shape as ORDER BY.
function cursorWhere(input: ListSubscriptionsInput): ReturnType<typeof and> | undefined {
  const cur = input.cursor;
  if (!cur) return undefined;
  const desc_ = SORT_DESCRIPTORS[input.sort];
  const p = drizzle.schema.purchases;
  const col = desc_.column(p);
  const id = p.id;
  const dir = desc_.direction;

  const wasNull = desc_.nullable && cur.sortValue === "";

  // Coerce string sortValue into the column's expected type for SQL compare.
  const valueLiteral = wasNull
    ? null
    : input.sort === "status"
      ? sql`${cur.sortValue}::text`
      : input.sort.startsWith("price")
        ? sql`${cur.sortValue}::numeric`
        : sql`${cur.sortValue}::timestamptz`;

  // Build the strictly-after-cursor predicate based on direction.
  // For nullable sorts: the cursor is either in the non-NULL bucket
  // (nullFlag=0) or NULL bucket (nullFlag=1). Rows AFTER the cursor are
  // either the same bucket with a later col/id, or the NULL bucket (only
  // when the cursor is in non-NULL).
  if (!desc_.nullable) {
    if (dir === "desc") {
      return or(
        lt(col, valueLiteral as any),
        and(eq(col, valueLiteral as any), lt(id, cur.id)),
      )!;
    }
    return or(
      gt(col, valueLiteral as any),
      and(eq(col, valueLiteral as any), gt(id, cur.id)),
    )!;
  }

  if (wasNull) {
    // Already in the NULL bucket — id-only tiebreaker.
    return and(isNull(col), dir === "desc" ? lt(id, cur.id) : gt(id, cur.id));
  }
  // Non-NULL bucket; either advance within bucket or move to NULL bucket.
  const sameBucket =
    dir === "desc"
      ? or(
          and(
            isNotNull(col),
            or(
              lt(col, valueLiteral as any),
              and(eq(col, valueLiteral as any), lt(id, cur.id)),
            ),
          ),
        )
      : or(
          and(
            isNotNull(col),
            or(
              gt(col, valueLiteral as any),
              and(eq(col, valueLiteral as any), gt(id, cur.id)),
            ),
          ),
        );
  return or(sameBucket, isNull(col));
}

function encodeNextCursor(
  sort: SubscriptionSortKey,
  row: typeof drizzle.schema.purchases.$inferSelect,
): string {
  let sortValue = "";
  switch (sort) {
    case "started_desc":
    case "started_asc":
      sortValue = row.purchaseDate.toISOString();
      break;
    case "renews_asc":
    case "renews_desc":
      sortValue = row.expiresDate ? row.expiresDate.toISOString() : "";
      break;
    case "price_asc":
    case "price_desc":
      sortValue = row.priceAmount ?? "";
      break;
    case "status":
      sortValue = row.status;
      break;
  }
  return encodeSubsCursor({ sort, sortValue, id: row.id });
}

export async function listSubscriptions(
  input: ListSubscriptionsInput,
): Promise<SubscriptionsListResponse> {
  const limit = Math.min(Math.max(input.limit, 1), PAGE_LIMIT_MAX);
  const fetchLimit = limit + 1;
  const now = new Date();
  const p = drizzle.schema.purchases;

  const where = [eq(p.projectId, input.projectId)];
  const scoped = scopeWhere(input.scope, now);
  if (scoped) where.push(scoped);
  for (const f of buildListFilters(input)) {
    if (f) where.push(f);
  }
  const curWhere = cursorWhere(input);
  if (curWhere) where.push(curWhere);

  const rows = await drizzle.db
    .select()
    .from(p)
    .where(and(...where))
    .orderBy(...buildOrderBy(input.sort))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const productIds = page.map((r) => r.productId);
  const display = await fetchProductDisplay(input.projectId, productIds);

  const mapped: SubscriptionRow[] = page.map((row) => {
    const meta = display.get(row.productId);
    const status = mapStatus({
      status: row.status,
      autoRenewStatus: row.autoRenewStatus,
    });
    const hasIssue =
      status === "grace" &&
      (row.autoRenewStatus === true || row.autoRenewStatus === null);
    return {
      id: row.id,
      subscriberId: row.subscriberId,
      productId: row.productId,
      productName: meta?.displayName ?? null,
      productIdentifier: meta?.identifier ?? null,
      store: row.store,
      status,
      priceAmount: row.priceAmount ?? null,
      priceCurrency: row.priceCurrency ?? null,
      isTrial: row.isTrial,
      isIntroOffer: row.isIntroOffer,
      autoRenew: row.autoRenewStatus,
      purchaseDate: row.purchaseDate.toISOString(),
      expiresDate: row.expiresDate?.toISOString() ?? null,
      gracePeriodExpires: row.gracePeriodExpires?.toISOString() ?? null,
      cancellationDate: row.cancellationDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      hasIssue,
    };
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeNextCursor(input.sort, last) : null;
  return { rows: mapped, nextCursor };
}

// =============================================================
// KPIs (top of page stat cards)
// =============================================================

export async function readSubscriptionsKpis(
  projectId: string,
): Promise<SubscriptionsKpis> {
  const p = drizzle.schema.purchases;
  const now = new Date();
  const renewingTo = new Date(now.getTime() + RENEWING_WINDOW_DAYS * DAY_MS);

  const [
    totalActiveRow,
    renewingRow,
    graceRow,
    cancelingRow,
    churnedRow,
  ] = await Promise.all([
    drizzle.db
      .select({ c: count() })
      .from(p)
      .where(
        and(
          eq(p.projectId, projectId),
          eq(p.status, "ACTIVE"),
          or(isNull(p.autoRenewStatus), eq(p.autoRenewStatus, true)),
        ),
      ),
    drizzle.db
      .select({ c: count() })
      .from(p)
      .where(
        and(
          eq(p.projectId, projectId),
          inArray(p.status, ["ACTIVE", "TRIAL"]),
          isNotNull(p.expiresDate),
          gte(p.expiresDate, now),
          lte(p.expiresDate, renewingTo),
        ),
      ),
    drizzle.db
      .select({ c: count() })
      .from(p)
      .where(
        and(
          eq(p.projectId, projectId),
          eq(p.status, "GRACE_PERIOD"),
        ),
      ),
    drizzle.db
      .select({ c: count() })
      .from(p)
      .where(
        and(
          eq(p.projectId, projectId),
          eq(p.status, "ACTIVE"),
          eq(p.autoRenewStatus, false),
        ),
      ),
    drizzle.db
      .select({ c: count() })
      .from(p)
      .where(
        and(
          eq(p.projectId, projectId),
          inArray(p.status, ["EXPIRED", "REFUNDED", "REVOKED"]),
        ),
      ),
  ]);

  return {
    totalActive: Number(totalActiveRow[0]?.c ?? 0),
    renewing7: Number(renewingRow[0]?.c ?? 0),
    graceRetry: Number(graceRow[0]?.c ?? 0),
    canceling: Number(cancelingRow[0]?.c ?? 0),
    churned: Number(churnedRow[0]?.c ?? 0),
  };
}

// =============================================================
// Composition (live segments)
// =============================================================

export async function readSubscriptionsComposition(
  projectId: string,
): Promise<SubscriptionsCompositionResponse> {
  const p = drizzle.schema.purchases;
  const rows = await drizzle.db
    .select({
      status: p.status,
      autoRenew: p.autoRenewStatus,
      c: count(),
    })
    .from(p)
    .where(
      and(eq(p.projectId, projectId), inArray(p.status, [...LIVE_STATUSES])),
    )
    .groupBy(p.status, p.autoRenewStatus);

  const counts: Record<SubscriptionUiStatus, number> = {
    active: 0,
    trial: 0,
    grace: 0,
    canceling: 0,
    churned: 0,
  };
  for (const r of rows) {
    const k = mapStatus({ status: r.status, autoRenewStatus: r.autoRenew });
    counts[k] += Number(r.c);
  }
  // `churned` isn't part of LIVE_STATUSES so it stays at zero — the
  // composition bar shows live subscriptions only. The KPI tile is
  // where the dashboard surfaces lifetime churned count.
  const total = counts.active + counts.trial + counts.grace + counts.canceling;
  const order: SubscriptionUiStatus[] = [
    "active",
    "trial",
    "canceling",
    "grace",
  ];
  return {
    total,
    segments: order.map((key) => ({
      key,
      count: counts[key],
      share:
        total > 0
          ? Math.round((counts[key] / total) * 1000) / 10
          : 0,
    })),
  };
}

// =============================================================
// Renewal calendar (past failed + upcoming renewals/trials/grace)
// =============================================================

export interface ReadCalendarInput {
  projectId: string;
  pastDays: number;
  futureDays: number;
}

export async function readRenewalCalendar(
  input: ReadCalendarInput,
): Promise<RenewalCalendarResponse> {
  const pastDays = Math.max(0, Math.min(input.pastDays, CALENDAR_MAX_DAYS));
  const futureDays = Math.max(0, Math.min(input.futureDays, CALENDAR_MAX_DAYS));
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const from = new Date(todayStart.getTime() - pastDays * DAY_MS);
  const to = new Date(todayStart.getTime() + (futureDays + 1) * DAY_MS); // exclusive

  const p = drizzle.schema.purchases;

  // Upcoming renewals + trials grouped by expiry day.
  const upcomingRows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${p.expiresDate}), 'YYYY-MM-DD')`,
      status: p.status,
      c: count(),
    })
    .from(p)
    .where(
      and(
        eq(p.projectId, projectId(input)),
        isNotNull(p.expiresDate),
        gte(p.expiresDate, todayStart),
        lt(p.expiresDate, to),
        inArray(p.status, ["ACTIVE", "TRIAL"]),
      ),
    )
    .groupBy(
      sql`date_trunc('day', ${p.expiresDate})`,
      p.status,
    );

  // Past failed/expired events grouped by cancellation/expires day.
  // We use COALESCE(cancellationDate, expiresDate) as the bucket so
  // a refund that has both keys reports against the cancellation
  // moment (closer to the real signal).
  const pastRows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', COALESCE(${p.cancellationDate}, ${p.expiresDate})), 'YYYY-MM-DD')`,
      c: count(),
    })
    .from(p)
    .where(
      and(
        eq(p.projectId, projectId(input)),
        inArray(p.status, [...CHURNED_STATUSES]),
        or(
          and(
            isNotNull(p.cancellationDate),
            gte(p.cancellationDate, from),
            lt(p.cancellationDate, todayStart),
          ),
          and(
            isNull(p.cancellationDate),
            isNotNull(p.expiresDate),
            gte(p.expiresDate, from),
            lt(p.expiresDate, todayStart),
          ),
        ),
      ),
    )
    .groupBy(
      sql`date_trunc('day', COALESCE(${p.cancellationDate}, ${p.expiresDate}))`,
    );

  // Grace bucket — grace_period subs whose grace expiry falls in window.
  const graceRows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${p.gracePeriodExpires}), 'YYYY-MM-DD')`,
      c: count(),
    })
    .from(p)
    .where(
      and(
        eq(p.projectId, projectId(input)),
        eq(p.status, "GRACE_PERIOD"),
        isNotNull(p.gracePeriodExpires),
        gte(p.gracePeriodExpires, from),
        lt(p.gracePeriodExpires, to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${p.gracePeriodExpires})`);

  // Hydrate per-day buckets.
  const total = pastDays + 1 + futureDays;
  const days: RenewalCalendarDay[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(from.getTime() + i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    const offset = i - pastDays;
    const isToday = offset === 0;
    const isPast = offset < 0;
    days.push({
      day: key,
      offset,
      today: isToday,
      past: isPast,
      renewals: 0,
      trials: 0,
      grace: 0,
      failed: 0,
    });
  }

  const byDay = new Map<string, RenewalCalendarDay>();
  for (const d of days) byDay.set(d.day, d);

  for (const r of upcomingRows) {
    const bucket = byDay.get(r.day);
    if (!bucket) continue;
    if (r.status === "TRIAL") bucket.trials += Number(r.c);
    else bucket.renewals += Number(r.c);
  }
  for (const r of pastRows) {
    const bucket = byDay.get(r.day);
    if (!bucket) continue;
    bucket.failed += Number(r.c);
  }
  for (const r of graceRows) {
    const bucket = byDay.get(r.day);
    if (!bucket) continue;
    bucket.grace += Number(r.c);
  }

  return { days, todayIndex: pastDays };
}

// Helper to keep TS happy in the calendar query bodies above.
function projectId(input: { projectId: string }): string {
  return input.projectId;
}

// =============================================================
// Billing issues (grace + auto-renew on)
// =============================================================

export async function readBillingIssues(
  projectId: string,
  limit: number,
): Promise<BillingIssuesResponse> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const p = drizzle.schema.purchases;
  const rows = await drizzle.db
    .select()
    .from(p)
    .where(
      and(
        eq(p.projectId, projectId),
        eq(p.status, "GRACE_PERIOD"),
        or(isNull(p.autoRenewStatus), eq(p.autoRenewStatus, true)),
      ),
    )
    .orderBy(asc(p.gracePeriodExpires), desc(p.createdAt))
    .limit(cap);

  const display = await fetchProductDisplay(
    projectId,
    rows.map((r) => r.productId),
  );

  const issues: BillingIssueRow[] = rows.map((row) => {
    const meta = display.get(row.productId);
    const signal =
      row.gracePeriodExpires ?? row.expiresDate ?? row.updatedAt;
    return {
      purchaseId: row.id,
      subscriberId: row.subscriberId,
      productId: row.productId,
      productName: meta?.displayName ?? null,
      priceAmount: row.priceAmount ?? null,
      priceCurrency: row.priceCurrency ?? null,
      store: row.store,
      signalAt: signal.toISOString(),
      issue: "Renewal pending in grace period",
      severity: "high",
    };
  });

  return { rows: issues };
}

export const __subscriptionsConstants = {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  CALENDAR_PAST_DEFAULT_DAYS,
  CALENDAR_FUTURE_DEFAULT_DAYS,
  CALENDAR_MAX_DAYS,
};
