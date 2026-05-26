import type { SubscriptionRow, SubscriptionScopeName } from "@rovenue/shared";
import {
  listSubscriptions,
  decodeSubsCursor,
  type ParsedSubsCursor,
} from "../metrics/subscriptions";

// =============================================================
// Column definitions
// =============================================================

const COLUMNS = [
  "id",
  "subscriber_id",
  "product",
  "status",
  "store",
  "price_amount",
  "price_currency",
  "purchase_date",
  "expires_date",
  "auto_renew",
  "is_trial",
  "cancellation_date",
] as const;

// =============================================================
// Pure helpers
// =============================================================

export function csvEscape(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function formatHeader(): string {
  return `${COLUMNS.join(",")}\n`;
}

export function formatRow(r: SubscriptionRow): string {
  const cells = [
    r.id,
    r.subscriberId,
    r.productName ?? r.productIdentifier ?? r.productId,
    r.status,
    r.store,
    r.priceAmount ?? "",
    r.priceCurrency ?? "",
    r.purchaseDate,
    r.expiresDate ?? "",
    r.autoRenew ?? false,
    r.isTrial,
    r.cancellationDate ?? "",
  ].map(csvEscape);
  return `${cells.join(",")}\n`;
}

// =============================================================
// Streaming generator
// =============================================================

const PAGE = 1000;
const HARD_CAP = 1_000_000;

export type ExportParams = {
  projectId: string;
  scope: SubscriptionScopeName;
  search: string | null;
};

export async function* streamSubscriptionsCsv(
  params: ExportParams,
): AsyncGenerator<string, { rowCount: number; truncated: boolean }, void> {
  yield formatHeader();
  let cursor: ParsedSubsCursor | null = null;
  let rowCount = 0;
  let truncated = false;

  while (true) {
    const page = await listSubscriptions({
      projectId: params.projectId,
      scope: params.scope,
      limit: PAGE,
      cursor,
      search: params.search,
    });

    for (const row of page.rows) {
      yield formatRow(row);
      rowCount += 1;
      if (rowCount >= HARD_CAP) {
        yield `# truncated at ${HARD_CAP} rows\n`;
        truncated = true;
        return { rowCount, truncated };
      }
    }

    if (!page.nextCursor) break;
    const next = decodeSubsCursor(page.nextCursor);
    if (!next) break;
    cursor = next;
  }

  return { rowCount, truncated };
}
