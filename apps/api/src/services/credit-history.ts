import { queryAnalytics } from "../lib/clickhouse";

// =============================================================
// Credit history reads — ClickHouse exclusive (Plan 3 Phase B)
// =============================================================
//
// Reads `raw_credit_ledger` (ReplacingMergeTree FINAL) keyed on
// (projectId, subscriberId), keyset-paginated on
// (createdAt DESC, eventId DESC). The CH table's storage ORDER BY
// is `(projectId, createdAt, eventId)`, so the same tuple drives
// both index-skip and the API's pagination cursor.
//
// Eventual-consistency contract (documented in Plan 3 §B.1):
// rows just inserted into Postgres `credit_ledger` may not appear
// here until the outbox dispatcher publishes and the Kafka Engine
// MV ingests. Budget: ≤2s p99 from PG commit. The dashboard SHOULD
// surface this lag to operators as part of the response header
// X-Read-Lag (set by the route, not the service).
//
// `description` is intentionally NULL: it lives only in Postgres
// and was never propagated through the outbox payload. Kept in the
// wire shape so the dashboard SPA's row renderer doesn't crash on
// missing fields.

export interface CreditHistoryEntry {
  /** creditLedgerId (PG row PK). */
  id: string;
  type: string;
  amount: string;
  balance: string;
  referenceType: string | null;
  description: string | null;
  createdAt: string;
}

export interface CreditHistoryCursor {
  createdAt: string;
  /** Outbox eventId — CH's storage tiebreaker, opaque to the client. */
  id: string;
}

export interface ListCreditHistoryInput {
  projectId: string;
  subscriberId: string;
  limit: number;
  cursor?: CreditHistoryCursor | null;
}

export interface ListCreditHistoryResult {
  entries: CreditHistoryEntry[];
  nextCursor: CreditHistoryCursor | null;
}

interface ChCreditRow {
  eventId: string;
  creditLedgerId: string;
  type: string;
  amount: string;
  balance: string;
  referenceType: string | null;
  createdAt: string;
}

export async function listCreditHistory(
  input: ListCreditHistoryInput,
): Promise<ListCreditHistoryResult> {
  const fetchLimit = input.limit + 1;
  const cursorClause = input.cursor
    ? `AND (createdAt, eventId) < ({cursorCreatedAt:DateTime64(3)}, {cursorEventId:String})`
    : "";

  const sql = `
    SELECT
      eventId,
      creditLedgerId,
      type,
      toString(amount)            AS amount,
      toString(balance)           AS balance,
      referenceType,
      formatDateTime(createdAt, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS createdAt
    FROM rovenue.raw_credit_ledger FINAL
    WHERE projectId = {projectId:String}
      AND subscriberId = {subscriberId:String}
      ${cursorClause}
    ORDER BY createdAt DESC, eventId DESC
    LIMIT ${fetchLimit}
  `;

  const params: Record<string, unknown> = {
    subscriberId: input.subscriberId,
  };
  if (input.cursor) {
    params.cursorCreatedAt = formatChDateTime(input.cursor.createdAt);
    params.cursorEventId = input.cursor.id;
  }

  const rows = await queryAnalytics<ChCreditRow>(input.projectId, sql, params);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  const entries: CreditHistoryEntry[] = page.map((r) => ({
    id: r.creditLedgerId,
    type: r.type,
    amount: r.amount,
    balance: r.balance,
    referenceType: r.referenceType,
    description: null,
    createdAt: normaliseChIso(r.createdAt),
  }));

  const nextCursor: CreditHistoryCursor | null =
    hasMore && last
      ? {
          createdAt: normaliseChIso(last.createdAt),
          id: last.eventId,
        }
      : null;

  return { entries, nextCursor };
}

// CH wants `YYYY-MM-DD HH:MM:SS.fff` for DateTime64 binds; the cursor
// stores ISO. Strip the trailing `Z` and replace the `T` separator.
function formatChDateTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.?\d*Z$/, (m) =>
    m.startsWith(".") ? m.slice(0, -1) : "",
  );
}

// `formatDateTime(...'%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')` already returns
// ISO-shaped strings; this guard normalises CH's `%f` (microseconds)
// to ms by truncating to 3 fractional digits if longer.
function normaliseChIso(value: string): string {
  return value.replace(/(\.\d{3})\d+(Z|\+\d{2}:?\d{2})?$/, "$1$2");
}
