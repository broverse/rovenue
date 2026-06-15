import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../client";
import {
  integrationDeliveries,
  type IntegrationDelivery,
  type NewIntegrationDelivery,
} from "../schema";

// =============================================================
// insertPendingDelivery
// =============================================================
//
// Inserts a delivery audit row. This is NOT a dedupe boundary —
// there is no unique constraint that can fire here (the table is
// PARTITION BY RANGE (created_at), so a 2-column
// (connection_id, outbox_event_id) unique index is impossible, and
// any index including created_at never collides because each insert
// gets a fresh now()). Idempotency for ad-platform deliveries is
// enforced provider-side via the native event_id field.
//
// `onConflictDoNothing()` is retained only as a belt-and-braces guard
// against a primary-key (id, created_at) collision on the cuid2 id;
// in practice it never fires and the inserted row is always returned.
// It is called WITHOUT an explicit target because the table is
// partitioned and Postgres rejects a target referencing the parent.

export async function insertPendingDelivery(
  db: Db,
  values: NewIntegrationDelivery,
): Promise<IntegrationDelivery | undefined> {
  const [row] = await db
    .insert(integrationDeliveries)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return row;
}

// =============================================================
// updateDeliveryStatus
// =============================================================
//
// Uses composite (id, createdAt) predicate for partition pruning.
//
// Postgres stores timestamps at microsecond precision, but JS Date
// is millisecond-only.  Comparing the JS Date directly via `eq`
// would fail whenever the stored value has sub-millisecond digits.
// We work around this by matching a 1-millisecond window:
//   created_at >= trunc_to_ms  AND  created_at < trunc_to_ms + 1ms
// This still gives Postgres the partition-key range it needs to
// prune partitions while tolerating the microsecond difference.

export interface UpdateDeliveryStatusInput {
  id: string;
  createdAt: Date;
  status: IntegrationDelivery["status"];
  httpStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  providerEvent?: string | null;
  skipReason?: string | null;
  attempt?: number;
}

export async function updateDeliveryStatus(
  db: Db,
  input: UpdateDeliveryStatusInput,
): Promise<IntegrationDelivery> {
  // Truncate to the millisecond so the ms-precision JS Date matches the
  // microsecond-precision Postgres timestamp.
  const msFloor = new Date(Math.floor(input.createdAt.getTime()));
  const msCeil = new Date(msFloor.getTime() + 1);
  const [row] = await db
    .update(integrationDeliveries)
    .set({
      status: input.status,
      httpStatus: input.httpStatus ?? null,
      responseBody: input.responseBody ?? null,
      errorMessage: input.errorMessage ?? null,
      providerEvent: input.providerEvent ?? null,
      skipReason: input.skipReason ?? null,
      attempt: input.attempt ?? 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationDeliveries.id, input.id),
        gte(integrationDeliveries.createdAt, msFloor),
        lt(integrationDeliveries.createdAt, msCeil),
      ),
    )
    .returning();
  if (!row) throw new Error(`updateDeliveryStatus: id=${input.id} not found`);
  return row;
}

// =============================================================
// listDeliveriesForConnection
// =============================================================
//
// Cursor-paginated, newest-first. Cursor is the ISO-8601 string
// of the last seen createdAt. Fetches limit+1 rows to determine
// whether a next page exists, then slices back to limit.

export interface ListDeliveriesInput {
  connectionId: string;
  limit: number;
  cursor?: string; // ISO timestamp of last seen createdAt
  status?: IntegrationDelivery["status"];
}

export interface ListDeliveriesPage {
  rows: IntegrationDelivery[];
  nextCursor?: string;
}

export async function listDeliveriesForConnection(
  db: Db,
  input: ListDeliveriesInput,
): Promise<ListDeliveriesPage> {
  const conds = [eq(integrationDeliveries.connectionId, input.connectionId)];
  if (input.cursor) {
    conds.push(lt(integrationDeliveries.createdAt, new Date(input.cursor)));
  }
  if (input.status) {
    conds.push(eq(integrationDeliveries.status, input.status));
  }
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(and(...conds))
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : undefined,
  };
}
