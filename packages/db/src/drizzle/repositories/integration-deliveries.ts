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
// ON CONFLICT DO NOTHING on the dedupe unique index
// (connection_id, outbox_event_id, created_at).
// Returns the inserted row, or undefined when a duplicate was
// silently skipped.
//
// Note: `onConflictDoNothing()` is called WITHOUT an explicit
// `target` because the table is partitioned. Postgres does not
// support an explicit conflict target referencing a partial/unique
// index on a partitioned table parent — the bare DO NOTHING form
// correctly catches any unique-constraint violation across all
// partitions.

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
